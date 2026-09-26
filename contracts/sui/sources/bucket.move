/// The Bucket: a Sui-native programmable financial container.
///
/// A `Bucket` is a shared object holding a native vault of Sui coins, its canonical spend policy and every
/// Financial Capability issued against it. Ownership never moves to this contract as custody: the owner deposits
/// coins into the Bucket's own vault (a Sui object the owner's `OwnerCap` controls), and every other party — every
/// operator, however deep in the delegation chain — can only move funds out through a `Capability` that Move checks
/// on every call: live, in scope, under limit, this transaction.
///
///   SuiNS        WHO      resolves a human name to a live address (identity; kept for attribution only)
///   Capability    WHAT     what that address may do (see `bucket::capability`)
///   Bucket (here) WHERE    the vault the capability's authority is checked against and settled from
///
/// A Bucket may optionally record an `EvmBinding` purely for cross-chain attribution: BUCKET also runs an
/// independently issued, independently enforced Financial Capability stack on the EVM execution layer (ENSv2 +
/// `BucketCapabilities` + SwapVM + Aqua). The two are not one shared contract; `record_evm_receipt` lets an EVM
/// execution show up in this Bucket's own audit trail without Sui re-deriving EVM's own price-based math.
///
/// Invariants
///   S1  `policy_hash == policy::hash(bucket_ref, policy)` at all times; `bucket_ref` is this object's own ID.
///   S2  A capability's every field is within its parent's (`ChildAuthority ⊆ ParentAuthority`), checked once at
///       issuance; capabilities are immutable afterward, so this never needs re-checking.
///   S3  No execution proceeds unless every link of its capability's chain is live *now*: not revoked, not
///       exhausted, under the Bucket's current epoch and policy version, inside its validity window.
///   S4  Cumulative value moved never exceeds a capability's (or its ancestors', or the Bucket's own) per-tx,
///       hourly, daily or turnover limit.
///   S5  A CLOSED Bucket accepts no state change; a PAUSED Bucket accepts no payment or capability issuance.
module bucket::bucket;

use bucket::access::{Self, AccessControl};
use bucket::capability::{Self, Capability};
use bucket::permissions;
use bucket::policy::{Self, Policy};
use bucket::receipt::{Self, Receipt};
use std::ascii;
use std::string::String;
use std::type_name;
use sui::bag::{Self, Bag};
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::event;
use sui::table::{Self, Table};
use sui::vec_set::{Self, VecSet};
use suins::registry::Registry;
use suins::suins::SuiNS;

// === Status ===

const STATUS_ACTIVE: u8 = 1;
const STATUS_PAUSED: u8 = 2;
const STATUS_CLOSED: u8 = 3;

const MS_PER_SECOND: u64 = 1_000;

// === Abort codes ===

const EWrongBucket: u64 = 600;
const ENotOwnerOrGuardian: u64 = 602;
const EBucketNotActive: u64 = 603;
const EBucketClosed: u64 = 604;
const EInvalidStatus: u64 = 605;
const EEvmAlreadyBound: u64 = 606;
const EEvmNotBound: u64 = 607;
const EEvmBindingInvalid: u64 = 608;
const ECapabilityUnknown: u64 = 609;
const ENotAuthorizedToRevoke: u64 = 610;
const EAssetNotAccepted: u64 = 611;
const EZeroAmount: u64 = 612;
const EInsufficientVault: u64 = 613;
const EDeadlinePassed: u64 = 614;
const ERecipientNotAllowed: u64 = 615;
const ECapabilityLimitExceeded: u64 = 616;
const EBucketLimitExceeded: u64 = 617;
const ELengthMismatch: u64 = 618;
const EReceivingPolicyRejected: u64 = 619;
const EEvmNonceOrder: u64 = 620;
/// EAC: caller lacks the role this protected operation requires on this Bucket.
const ENotAuthorizedRole: u64 = 621;

// === Objects ===

/// Explicit, optional association with an independently issued and enforced EVM twin. Sui and EVM accounts are
/// never assumed equal; `holder` is recorded purely for display (the EVM wallet whose balances the twin governs).
public struct EvmBinding has copy, drop, store {
    chain_id: u64,
    /// `BucketController` address (20 bytes).
    controller: vector<u8>,
    /// EVM `bucketId` (32 bytes).
    bucket_id: vector<u8>,
    /// The EVM holder wallet (20 bytes).
    holder: vector<u8>,
}

/// A receiving Bucket's inbound-payment policy for `pay_bucket_to_bucket`. `None` accepted_senders = accept from
/// any Bucket owner.
public struct ReceivingPolicy has copy, drop, store {
    accepted_senders: Option<VecSet<address>>,
    min_amount: u64,
    max_amount: u64,
}

public struct Bucket has key {
    id: UID,
    /// Human label or SuiNS name (e.g. `treasury@shlok`), for display only.
    name: String,
    owner: address,
    evm: Option<EvmBinding>,
    policy: Policy,
    policy_hash: vector<u8>,
    capability_epoch: u32,
    capability_nonce: u64,
    capabilities: Table<u64, Capability>,
    /// Bucket-wide cumulative usage, charged alongside every capability's own (policy-level velocity ceiling).
    usage: capability::Usage,
    guardians: VecSet<address>,
    receiving_policy: Option<ReceivingPolicy>,
    vault: Bag,
    evm_execution_nonce: u64,
    evm_receipts_recorded: u64,
    last_evm_tx: vector<u8>,
    status: u8,
    version: u64,
    created_at_ms: u64,
    updated_at_ms: u64,
}

/// Ownership of a Bucket. Transferring it transfers ownership; a lost `OwnerCap` is catastrophic (there is no
/// admin override), so it is deliberately the only capability with `store` — the one an owner might keep in cold
/// storage or a multisig rather than a hot wallet.
public struct OwnerCap has key, store {
    id: UID,
    bucket_id: ID,
}

/// Possession of the operator identity a capability was issued to. `key`-only: mintable and transferable once, by
/// this module, at issuance, never movable again — an operator cannot re-delegate its own authority by handing
/// this object to someone else; delegation only happens through `delegate_capability`, which mints a fresh child.
public struct OperatorCap has key {
    id: UID,
    bucket_id: ID,
    capability_nonce: u64,
}

// === Events ===

public struct BucketCreated has copy, drop {
    bucket_id: ID,
    owner: address,
    name: String,
    policy_version: u32,
    policy_hash: vector<u8>,
}

public struct BucketEvmBound has copy, drop {
    bucket_id: ID,
    chain_id: u64,
    controller: vector<u8>,
    evm_bucket_id: vector<u8>,
    holder: vector<u8>,
}

public struct BucketPolicyUpdated has copy, drop {
    bucket_id: ID,
    policy_version: u32,
    policy_hash: vector<u8>,
    actor: address,
}

public struct BucketStatusUpdated has copy, drop {
    bucket_id: ID,
    status: u8,
    actor: address,
}

public struct GuardianUpdated has copy, drop {
    bucket_id: ID,
    guardian: address,
    active: bool,
}


public struct CapabilityIssued has copy, drop {
    bucket_id: ID,
    capability_id: vector<u8>,
    parent_id: vector<u8>,
    nonce: u64,
    depth: u8,
    operator: address,
    operator_name: String,
    permissions: u32,
    capability_hash: vector<u8>,
}

public struct CapabilityRevoked has copy, drop {
    bucket_id: ID,
    nonce: u64,
    capability_id: vector<u8>,
    by: address,
}

public struct CapabilityExhausted has copy, drop {
    bucket_id: ID,
    nonce: u64,
    capability_id: vector<u8>,
    executions: u64,
}

public struct CapabilityEpochAdvanced has copy, drop {
    bucket_id: ID,
    epoch: u32,
    by: address,
}

public struct VaultUpdated has copy, drop {
    bucket_id: ID,
    coin_type: ascii::String,
    amount: u64,
    /// 0 deposit, 1 withdraw (owner, unrestricted).
    direction: u8,
    actor: address,
    counterparty: address,
}

/// WHO / WHAT / WHY / HOW MUCH / RESULT of one Sui-native payment. A rejected attempt aborts and emits nothing;
/// the SDK surfaces the abort code from the failed (or dry-run) transaction instead.
public struct PaymentExecuted has copy, drop {
    bucket_id: ID,
    capability_id: vector<u8>,
    parent_capability_id: vector<u8>,
    nonce: u64,
    operator: address,
    coin_type: ascii::String,
    amount: u64,
    recipient: address,
    executions: u64,
}

public struct BucketToBucketPayment has copy, drop {
    source_bucket_id: ID,
    dest_bucket_id: ID,
    capability_id: vector<u8>,
    operator: address,
    coin_type: ascii::String,
    amount: u64,
}

/// A recorded EVM execution report, kept purely for cross-chain attribution (see the module doc).
public struct EvmReceiptRecorded has copy, drop {
    bucket_id: ID,
    evm_tx_hash: vector<u8>,
    evm_receipt_hash: vector<u8>,
    execution_nonce: u64,
    kind: u8,
    evm_capability_id: vector<u8>,
    evm_operator: vector<u8>,
    amount_out: u128,
    amount_in: u128,
    value_out: u256,
    recipient: vector<u8>,
}

// === Construction ===

/// Creates and shares a Bucket, returning its `OwnerCap`. No EVM twin is required; `bind_evm` adds one later.
public fun create_bucket(name: String, policy: Policy, clock: &Clock, ctx: &mut TxContext): OwnerCap {
    let mut policy = policy;
    policy::validate(&policy);
    policy::set_version(&mut policy, 1);

    let uid = object::new(ctx);
    let bucket_id = object::uid_to_inner(&uid);
    let bucket_ref = object::id_to_bytes(&bucket_id);
    let policy_hash = policy::hash(&bucket_ref, &policy);
    let now = clock.timestamp_ms();
    let owner = ctx.sender();

    let bucket = Bucket {
        id: uid,
        name,
        owner,
        evm: option::none(),
        policy,
        policy_hash,
        capability_epoch: 0,
        capability_nonce: 0,
        capabilities: table::new(ctx),
        usage: capability::new_usage(),
        guardians: vec_set::empty(),
        receiving_policy: option::none(),
        vault: bag::new(ctx),
        evm_execution_nonce: 0,
        evm_receipts_recorded: 0,
        last_evm_tx: vector[],
        status: STATUS_ACTIVE,
        version: 1,
        created_at_ms: now,
        updated_at_ms: now,
    };

    event::emit(BucketCreated { bucket_id, owner, name: bucket.name, policy_version: 1, policy_hash: bucket.policy_hash });
    transfer::share_object(bucket);
    OwnerCap { id: object::new(ctx), bucket_id }
}

/// Binds an independently governed EVM twin, for attribution only. Owner only, once.
public fun bind_evm(
    bucket: &mut Bucket,
    cap: &OwnerCap,
    chain_id: u64,
    controller: vector<u8>,
    evm_bucket_id: vector<u8>,
    holder: vector<u8>,
    clock: &Clock,
) {
    assert_owner(bucket, cap);
    assert!(bucket.evm.is_none(), EEvmAlreadyBound);
    assert!(controller.length() == 20 && evm_bucket_id.length() == 32 && holder.length() == 20, EEvmBindingInvalid);
    bucket.evm = option::some(EvmBinding { chain_id, controller, bucket_id: evm_bucket_id, holder });
    touch(bucket, clock);
    event::emit(BucketEvmBound {
        bucket_id: object::id(bucket),
        chain_id,
        controller,
        evm_bucket_id,
        holder,
    });
}

// === Policy ===

/// Installs a new policy version. Every capability issued under the previous version stops working immediately
/// (`check_link` compares against the current version), without touching a single stored capability.
public fun update_policy(bucket: &mut Bucket, cap: &OwnerCap, new_policy: Policy, clock: &Clock) {
    assert_owner(bucket, cap);
    assert_not_closed(bucket);
    let mut new_policy = new_policy;
    policy::validate(&new_policy);
    let version = policy::version(&bucket.policy) + 1;
    policy::set_version(&mut new_policy, version);
    bucket.policy = new_policy;
    let bucket_ref = object::id_to_bytes(&object::id(bucket));
    bucket.policy_hash = policy::hash(&bucket_ref, &bucket.policy);
    touch(bucket, clock);
    event::emit(BucketPolicyUpdated {
        bucket_id: object::id(bucket),
        policy_version: version,
        policy_hash: bucket.policy_hash,
        actor: bucket.owner,
    });
}

/// Owner-only receiving-Bucket policy for `pay_bucket_to_bucket` (accepted senders, amount bounds).
public fun set_receiving_policy(
    bucket: &mut Bucket,
    cap: &OwnerCap,
    accepted_senders: Option<VecSet<address>>,
    min_amount: u64,
    max_amount: u64,
    clock: &Clock,
) {
    assert_owner(bucket, cap);
    assert!(min_amount <= max_amount, EReceivingPolicyRejected);
    bucket.receiving_policy = option::some(ReceivingPolicy { accepted_senders, min_amount, max_amount });
    touch(bucket, clock);
}

public fun clear_receiving_policy(bucket: &mut Bucket, cap: &OwnerCap, clock: &Clock) {
    assert_owner(bucket, cap);
    bucket.receiving_policy = option::none();
    touch(bucket, clock);
}

// === Status and guardians ===

public fun add_guardian(bucket: &mut Bucket, cap: &OwnerCap, guardian: address, clock: &Clock) {
    assert_owner(bucket, cap);
    bucket.guardians.insert(guardian);
    touch(bucket, clock);
    event::emit(GuardianUpdated { bucket_id: object::id(bucket), guardian, active: true });
}

public fun remove_guardian(bucket: &mut Bucket, cap: &OwnerCap, guardian: address, clock: &Clock) {
    assert_owner(bucket, cap);
    if (bucket.guardians.contains(&guardian)) bucket.guardians.remove(&guardian);
    touch(bucket, clock);
    event::emit(GuardianUpdated { bucket_id: object::id(bucket), guardian, active: false });
}

/// Emergency pause: owner or any guardian. Only the owner can resume (guardians never regain ACTIVE for it).
public fun pause(bucket: &mut Bucket, clock: &Clock, ctx: &TxContext) {
    assert_not_closed(bucket);
    let sender = ctx.sender();
    assert!(sender == bucket.owner || bucket.guardians.contains(&sender), ENotOwnerOrGuardian);
    bucket.status = STATUS_PAUSED;
    touch(bucket, clock);
    event::emit(BucketStatusUpdated { bucket_id: object::id(bucket), status: STATUS_PAUSED, actor: sender });
}

public fun resume(bucket: &mut Bucket, cap: &OwnerCap, clock: &Clock) {
    assert_owner(bucket, cap);
    assert!(bucket.status == STATUS_PAUSED, EInvalidStatus);
    bucket.status = STATUS_ACTIVE;
    touch(bucket, clock);
    event::emit(BucketStatusUpdated { bucket_id: object::id(bucket), status: STATUS_ACTIVE, actor: bucket.owner });
}

/// Terminal: owner only. Capabilities stop mattering (the Bucket rejects every execution regardless).
public fun close(bucket: &mut Bucket, cap: &OwnerCap, clock: &Clock) {
    assert_owner(bucket, cap);
    assert_not_closed(bucket);
    bucket.status = STATUS_CLOSED;
    touch(bucket, clock);
    event::emit(BucketStatusUpdated { bucket_id: object::id(bucket), status: STATUS_CLOSED, actor: bucket.owner });
}

// === Capability issuance and delegation ===

/// Issues a root capability directly to `operator` (its address already resolved off-chain from `operator_name`,
/// e.g. a SuiNS name — SuiNS tells us WHO; this call is what tells Move WHAT that address may do). Owner only.
public fun issue_capability(
    bucket: &mut Bucket,
    cap: &OwnerCap,
    operator: address,
    operator_name: String,
    permissions: u32,
    asset_mask: u8,
    valid_after: u64,
    valid_until: u64,
    payee: address,
    limits: capability::Limits,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert_owner(bucket, cap);
    assert_active(bucket);
    let bucket_id = object::id(bucket);
    let bucket_ref = object::id_to_bytes(&bucket_id);
    let nonce = bucket.capability_nonce + 1;
    let owner = bucket.owner;
    let epoch = bucket.capability_epoch;

    let capability = capability::issue_root(
        &bucket_ref, owner, operator, operator_name, permissions, asset_mask, valid_after, valid_until, payee,
        limits, &bucket.policy, epoch, nonce, clock.timestamp_ms(),
    );
    bucket.capability_nonce = nonce;
    emit_issued(bucket_id, &capability, nonce);
    bucket.capabilities.add(nonce, capability);
    touch(bucket, clock);

    transfer::transfer(OperatorCap { id: object::new(ctx), bucket_id, capability_nonce: nonce }, operator);
    nonce
}

/// Delegates a child of the caller's own capability. Requires `PERM_DELEGATE` on the parent and re-validates that
/// the parent is *currently* live (not revoked, not expired, current epoch and policy version) before allowing it
/// to delegate at all — a capability cannot pass on authority it has itself already lost.
public fun delegate_capability(
    bucket: &mut Bucket,
    parent_cap: &OperatorCap,
    operator: address,
    operator_name: String,
    permissions: u32,
    asset_mask: u8,
    valid_after: u64,
    valid_until: u64,
    payee: address,
    limits: capability::Limits,
    clock: &Clock,
    ctx: &mut TxContext,
): u64 {
    assert_active(bucket);
    let bucket_id = object::id(bucket);
    assert!(parent_cap.bucket_id == bucket_id, EWrongBucket);
    let bucket_ref = object::id_to_bytes(&bucket_id);
    let now = clock.timestamp_ms() / MS_PER_SECOND;
    let epoch = bucket.capability_epoch;
    let policy_version = policy::version(&bucket.policy);
    let nonce = bucket.capability_nonce + 1;

    let sender = ctx.sender();
    let child;
    {
        let parent = bucket.capabilities.borrow(parent_cap.capability_nonce);
        capability::check_link(parent, epoch, policy_version, now);
        capability::check_leaf(parent, sender, permissions::delegate(), 0);
        child = capability::issue_child(
            &bucket_ref, parent, operator, operator_name, permissions, asset_mask, valid_after, valid_until,
            payee, limits, nonce, clock.timestamp_ms(),
        );
    };
    bucket.capability_nonce = nonce;
    emit_issued(bucket_id, &child, nonce);
    bucket.capabilities.add(nonce, child);
    touch(bucket, clock);

    transfer::transfer(OperatorCap { id: object::new(ctx), bucket_id, capability_nonce: nonce }, operator);
    nonce
}

/// Revokes one capability (and, since every descendant's chain check walks up to it, every capability delegated
/// from it). Callable by the Bucket owner, any guardian, or the capability's own issuer (self-revocation).
public fun revoke_capability(bucket: &mut Bucket, nonce: u64, clock: &Clock, ctx: &TxContext) {
    assert!(bucket.capabilities.contains(nonce), ECapabilityUnknown);
    let sender = ctx.sender();
    let capability_id = {
        let capability = bucket.capabilities.borrow(nonce);
        assert!(
            sender == bucket.owner || bucket.guardians.contains(&sender) || capability::issuer(capability) == sender,
            ENotAuthorizedToRevoke,
        );
        capability::capability_id(capability)
    };
    let capability = bucket.capabilities.borrow_mut(nonce);
    capability::revoke(capability);
    touch(bucket, clock);
    event::emit(CapabilityRevoked { bucket_id: object::id(bucket), nonce, capability_id, by: sender });
}

/// Kill switch: invalidates every capability of the Bucket at once (an epoch bump instantly fails `check_link`
/// for every existing capability, without iterating or mutating a single one of them). Owner or guardian.
public fun revoke_all(bucket: &mut Bucket, clock: &Clock, ctx: &TxContext): u32 {
    let sender = ctx.sender();
    assert!(sender == bucket.owner || bucket.guardians.contains(&sender), ENotOwnerOrGuardian);
    bucket.capability_epoch = bucket.capability_epoch + 1;
    touch(bucket, clock);
    event::emit(CapabilityEpochAdvanced { bucket_id: object::id(bucket), epoch: bucket.capability_epoch, by: sender });
    bucket.capability_epoch
}

// === Enhanced Access Control (EAC), ENSv2 semantics ===
//
// Resource-scoped roles, enforced in Move. The Bucket owner is the resource's root authority and implicitly holds
// every role. The Bucket's EAC resource is its own object address (`bucket_resource`). Roles live in the shared
// `access::AccessControl` registry. ENSv2 semantics apply: roles are nybble-packed `u256` bitmaps, each regular role
// has an admin role (`access::admin(role)`), a role granted on `access::root_resource()` applies to every Bucket,
// and granting/revoking a role requires the caller to hold that role's admin role — except the owner-bootstrap path
// below, where the `OwnerCap` is the resource's root authority (BUCKET's registrar-equivalent).
//
// The plain admin path is `access::grant_roles` / `revoke_roles` on the shared registry (admin-role checked). The
// helpers here are the owner-bootstrap path plus SuiNS resolution and the Bucket-scoped authorization view.

/// This Bucket's EAC resource id — its own object address. Distinct per Bucket, so a role on one Bucket never
/// authorizes another (only a `root_resource` grant spans all of them).
public fun bucket_resource(bucket: &Bucket): address {
    object::id_address(bucket)
}

/// Owner bootstrap: the `OwnerCap` holder seeds `role_bitmap` for `principal` on this Bucket's resource, with no
/// pre-existing admin role required (possession of the `OwnerCap` is the resource's root authority). Granting the
/// GUARDIAN role also adds the principal to the Bucket's `guardians` set, so the existing pause/revoke path applies.
public fun owner_grant_roles(
    ac: &mut AccessControl,
    bucket: &mut Bucket,
    cap: &OwnerCap,
    role_bitmap: u256,
    principal: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_owner(bucket, cap);
    access::owner_grant(ac, object::id_address(bucket), role_bitmap, principal, ctx.sender());
    if (role_bitmap & access::guardian() != 0 && !bucket.guardians.contains(&principal)) {
        bucket.guardians.insert(principal);
    };
    touch(bucket, clock);
}

/// Owner bootstrap via SuiNS: resolves `name` to its live on-chain target address and seeds `role_bitmap` for that
/// address. The name is identity only; authority lives on the resolved address.
public fun owner_grant_roles_by_suins(
    ac: &mut AccessControl,
    bucket: &mut Bucket,
    cap: &OwnerCap,
    suins_obj: &SuiNS,
    name: String,
    role_bitmap: u256,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_owner(bucket, cap);
    let reg = suins::suins::registry<Registry>(suins_obj);
    let principal = access::resolve_target(reg, name, clock);
    access::owner_grant(ac, object::id_address(bucket), role_bitmap, principal, ctx.sender());
    if (role_bitmap & access::guardian() != 0 && !bucket.guardians.contains(&principal)) {
        bucket.guardians.insert(principal);
    };
    touch(bucket, clock);
}

/// Owner bootstrap revoke: removes `role_bitmap` from `principal` on this Bucket's resource. Immediate.
public fun owner_revoke_roles(
    ac: &mut AccessControl,
    bucket: &mut Bucket,
    cap: &OwnerCap,
    role_bitmap: u256,
    principal: address,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_owner(bucket, cap);
    access::owner_revoke(ac, object::id_address(bucket), role_bitmap, principal, ctx.sender());
    if (role_bitmap & access::guardian() != 0 && bucket.guardians.contains(&principal)) {
        bucket.guardians.remove(&principal);
    };
    touch(bucket, clock);
}

/// True if `principal` holds every role in `role_bitmap` for this Bucket, applying the ENSv2 root-resource
/// fallback and the owner's implicit root authority. The Move source of truth — never a frontend check.
public fun has_role(ac: &AccessControl, bucket: &Bucket, principal: address, role_bitmap: u256): bool {
    principal == bucket.owner || access::has_roles(ac, object::id_address(bucket), role_bitmap, principal)
}

/// The raw stored role bitmap for `principal` on this Bucket's resource (no root fallback, no owner implication).
public fun roles_of(ac: &AccessControl, bucket: &Bucket, principal: address): u256 {
    access::roles(ac, object::id_address(bucket), principal)
}

/// Resolves a SuiNS name to the address BUCKET EAC would authorize, using the real on-chain registry. Aborts if
/// the name is unregistered, expired, or has no target address.
public fun resolve_suins_principal(suins_obj: &SuiNS, name: String, clock: &Clock): address {
    access::resolve_target(suins::suins::registry<Registry>(suins_obj), name, clock)
}

fun require_role(ac: &AccessControl, bucket: &Bucket, principal: address, role_bitmap: u256) {
    assert!(has_role(ac, bucket, principal, role_bitmap), ENotAuthorizedRole);
}

// === Native vault ===

/// Deposits a coin of a policy-accepted type. Anyone may fund a Bucket; only the owner may take unrestricted
/// amounts back out (`withdraw`), and only capability holders may pay out under their limits (`pay`).
public fun deposit<T>(bucket: &mut Bucket, coin: Coin<T>, clock: &Clock, ctx: &TxContext) {
    assert_not_closed(bucket);
    let amount = coin.value();
    assert!(amount > 0, EZeroAmount);
    let coin_type = accepted_type<T>(bucket);
    if (bucket.vault.contains(coin_type)) {
        let balance: &mut Balance<T> = bucket.vault.borrow_mut(coin_type);
        balance.join(coin.into_balance());
    } else {
        bucket.vault.add(coin_type, coin.into_balance());
    };
    touch(bucket, clock);
    event::emit(VaultUpdated { bucket_id: object::id(bucket), coin_type, amount, direction: 0, actor: ctx.sender(), counterparty: ctx.sender() });
}

/// Unrestricted withdrawal. Owner only — never delegable, matching the EVM `PERM_WITHDRAW` invariant.
public fun withdraw<T>(bucket: &mut Bucket, cap: &OwnerCap, amount: u64, clock: &Clock, ctx: &mut TxContext): Coin<T> {
    assert_owner(bucket, cap);
    let coin = take<T>(bucket, amount, ctx);
    let coin_type = type_name::with_defining_ids<T>().into_string();
    touch(bucket, clock);
    event::emit(VaultUpdated { bucket_id: object::id(bucket), coin_type, amount, direction: 1, actor: bucket.owner, counterparty: bucket.owner });
    coin
}

public fun vault_balance<T>(bucket: &Bucket): u64 {
    vault_balance_of<T>(&bucket.vault, type_name::with_defining_ids<T>().into_string())
}

// === Payments ===

/// Pays `amount` of `T` from the vault to the capability's fixed payee. The operator is authorized to *fulfil* a
/// payment within these constraints, never to choose an arbitrary destination — `recipient` must equal the
/// capability's own `payee`, checked here, not trusted from the caller. `deadline` (Unix seconds) is this call's
/// condition: past it, the payment is rejected regardless of every other check passing.
public fun pay<T>(
    bucket: &mut Bucket,
    ac: &AccessControl,
    op_cap: &OperatorCap,
    recipient: address,
    amount: u64,
    deadline: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let now = clock.timestamp_ms() / MS_PER_SECOND;
    assert!(now <= deadline, EDeadlinePassed);
    let (capability_id, parent_id, executions, exhausted) =
        charge_for_payment<T>(bucket, ac, op_cap, recipient, amount, now, ctx);

    let coin = take<T>(bucket, amount, ctx);
    transfer::public_transfer(coin, recipient);
    touch(bucket, clock);

    let coin_type = type_name::with_defining_ids<T>().into_string();
    event::emit(PaymentExecuted {
        bucket_id: object::id(bucket),
        capability_id,
        parent_capability_id: parent_id,
        nonce: op_cap.capability_nonce,
        operator: ctx.sender(),
        coin_type,
        amount,
        recipient,
        executions,
    });
    if (exhausted) {
        event::emit(CapabilityExhausted { bucket_id: object::id(bucket), nonce: op_cap.capability_nonce, capability_id, executions });
    };
}

/// Atomic multi-recipient settlement: every payment succeeds or the whole call aborts (ordinary Move/PTB atomicity
/// — there is no partial state to roll back). If the capability has a fixed payee, every recipient must equal it;
/// a capability issued with no fixed payee (`payee == @0x0`) may pay any set of recipients, an explicit trust
/// decision made once at issuance rather than bypassed here.
public fun pay_many<T>(
    bucket: &mut Bucket,
    ac: &AccessControl,
    op_cap: &OperatorCap,
    recipients: vector<address>,
    amounts: vector<u64>,
    deadline: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    assert!(recipients.length() == amounts.length() && recipients.length() > 0, ELengthMismatch);
    let now = clock.timestamp_ms() / MS_PER_SECOND;
    assert!(now <= deadline, EDeadlinePassed);

    let mut total = 0u64;
    let mut i = 0;
    while (i < amounts.length()) {
        total = total + amounts[i];
        i = i + 1;
    };

    let (capability_id, parent_id, executions, exhausted) =
        charge_for_payment<T>(bucket, ac, op_cap, @0x0, total, now, ctx);
    // charge_for_payment checked `recipient == payee` for a single address; a fixed-payee capability must pay only
    // that address, so re-check every recipient here once we know whether one is fixed.
    let fixed_payee = {
        let capability = bucket.capabilities.borrow(op_cap.capability_nonce);
        capability::payee(capability)
    };

    let coin_type = type_name::with_defining_ids<T>().into_string();
    i = 0;
    while (i < recipients.length()) {
        let recipient = recipients[i];
        if (fixed_payee != @0x0) assert!(recipient == fixed_payee, ERecipientNotAllowed);
        let coin = take<T>(bucket, amounts[i], ctx);
        transfer::public_transfer(coin, recipient);
        event::emit(PaymentExecuted {
            bucket_id: object::id(bucket),
            capability_id,
            parent_capability_id: parent_id,
            nonce: op_cap.capability_nonce,
            operator: ctx.sender(),
            coin_type,
            amount: amounts[i],
            recipient,
            executions,
        });
        i = i + 1;
    };
    touch(bucket, clock);
    if (exhausted) {
        event::emit(CapabilityExhausted { bucket_id: object::id(bucket), nonce: op_cap.capability_nonce, capability_id, executions });
    };
}

/// Bucket-to-Bucket payment: moves `Balance<T>` directly between two Bucket vaults in one atomic call — no Coin
/// round-trip, no intermediate custody. The capability's fixed payee is checked against the destination Bucket's
/// *owner* (a Bucket has no address of its own); the destination's receiving policy is checked in addition.
public fun pay_bucket_to_bucket<T>(
    source: &mut Bucket,
    ac: &AccessControl,
    op_cap: &OperatorCap,
    dest: &mut Bucket,
    amount: u64,
    deadline: u64,
    clock: &Clock,
    ctx: &TxContext,
) {
    assert_not_closed(dest);
    let now = clock.timestamp_ms() / MS_PER_SECOND;
    assert!(now <= deadline, EDeadlinePassed);
    let dest_owner = dest.owner;
    let (capability_id, _parent_id, _executions, _exhausted) =
        charge_for_payment<T>(source, ac, op_cap, dest_owner, amount, now, ctx);

    if (dest.receiving_policy.is_some()) {
        let policy_ref = dest.receiving_policy.borrow();
        assert!(amount >= policy_ref.min_amount && amount <= policy_ref.max_amount, EReceivingPolicyRejected);
        if (policy_ref.accepted_senders.is_some()) {
            assert!(policy_ref.accepted_senders.borrow().contains(&source.owner), EReceivingPolicyRejected);
        };
    };

    let coin_type = accepted_type<T>(dest);
    let moved = take_balance<T>(source, amount);
    if (dest.vault.contains(coin_type)) {
        let balance: &mut Balance<T> = dest.vault.borrow_mut(coin_type);
        balance.join(moved);
    } else {
        dest.vault.add(coin_type, moved);
    };

    touch(source, clock);
    touch(dest, clock);
    event::emit(BucketToBucketPayment {
        source_bucket_id: object::id(source),
        dest_bucket_id: object::id(dest),
        capability_id,
        operator: ctx.sender(),
        coin_type,
        amount,
    });
}

// === Cross-chain attribution ===

/// Records an EVM execution report for cross-chain attribution. Sui cannot read Ethereum state, so this only
/// checks what Sui *can* verify without an oracle: strict nonce order and that the report is for the bound EVM
/// twin. It does not re-derive EVM's price-based allocation math — that invariant is enforced on the EVM execution
/// layer itself. Owner only (a dedicated relayer role is a natural extension, not implemented here).
public fun record_evm_receipt(bucket: &mut Bucket, cap: &OwnerCap, r: Receipt, clock: &Clock) {
    assert_owner(bucket, cap);
    assert_not_closed(bucket);
    assert!(bucket.evm.is_some(), EEvmNotBound);
    assert!(receipt::execution_nonce(&r) == bucket.evm_execution_nonce + 1, EEvmNonceOrder);

    bucket.evm_execution_nonce = receipt::execution_nonce(&r);
    bucket.evm_receipts_recorded = bucket.evm_receipts_recorded + 1;
    bucket.last_evm_tx = receipt::evm_tx_hash(&r);
    touch(bucket, clock);

    event::emit(EvmReceiptRecorded {
        bucket_id: object::id(bucket),
        evm_tx_hash: receipt::evm_tx_hash(&r),
        evm_receipt_hash: receipt::evm_receipt_hash(&r),
        execution_nonce: receipt::execution_nonce(&r),
        kind: receipt::kind(&r),
        evm_capability_id: receipt::capability_id(&r),
        evm_operator: receipt::operator(&r),
        amount_out: receipt::amount_out(&r),
        amount_in: receipt::amount_in(&r),
        value_out: receipt::value_out(&r),
        recipient: receipt::recipient(&r),
    });
}

// === Views ===

public fun bucket_id_bytes(bucket: &Bucket): vector<u8> { object::id_to_bytes(&object::id(bucket)) }

public fun name(bucket: &Bucket): String { bucket.name }

public fun owner(bucket: &Bucket): address { bucket.owner }

public fun evm(bucket: &Bucket): Option<EvmBinding> { bucket.evm }

public fun policy(bucket: &Bucket): &Policy { &bucket.policy }

public fun policy_hash(bucket: &Bucket): vector<u8> { bucket.policy_hash }

public fun status(bucket: &Bucket): u8 { bucket.status }

public fun version(bucket: &Bucket): u64 { bucket.version }

public fun capability_epoch(bucket: &Bucket): u32 { bucket.capability_epoch }

public fun capability_nonce(bucket: &Bucket): u64 { bucket.capability_nonce }

public fun evm_execution_nonce(bucket: &Bucket): u64 { bucket.evm_execution_nonce }

public fun has_capability(bucket: &Bucket, nonce: u64): bool { bucket.capabilities.contains(nonce) }

public fun get_capability(bucket: &Bucket, nonce: u64): Capability { *bucket.capabilities.borrow(nonce) }

public fun owner_cap_bucket(cap: &OwnerCap): ID { cap.bucket_id }

public fun operator_cap_bucket(cap: &OperatorCap): ID { cap.bucket_id }

public fun operator_cap_nonce(cap: &OperatorCap): u64 { cap.capability_nonce }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_paused(): u8 { STATUS_PAUSED }

public fun status_closed(): u8 { STATUS_CLOSED }

// === Internal ===

/// Full authorization + limit check + charge for one payment of `T`, shared by `pay`, `pay_many` (with `@0x0`
/// standing in for "checked per-recipient by the caller instead") and `pay_bucket_to_bucket`.
/// Returns (capability_id, parent_id, executions, exhausted) for event emission.
fun charge_for_payment<T>(
    bucket: &mut Bucket,
    ac: &AccessControl,
    op_cap: &OperatorCap,
    recipient: address,
    amount: u64,
    now: u64,
    ctx: &TxContext,
): (vector<u8>, vector<u8>, u64, bool) {
    assert_active(bucket);
    assert!(op_cap.bucket_id == object::id(bucket), EWrongBucket);
    assert!(amount > 0, EZeroAmount);

    // EAC gate: the operator must hold ROLE_PAY on this Bucket (resource), in addition to a valid PAY capability,
    // the policy asset check, the velocity limits and the Bucket being active — every layer must independently permit.
    require_role(ac, bucket, ctx.sender(), access::pay());

    let epoch = bucket.capability_epoch;
    let policy_version = policy::version(&bucket.policy);
    let coin_type = type_name::with_defining_ids<T>().into_string();
    let asset_index = policy::find_type(&bucket.policy, &coin_type);
    assert!(asset_index.is_some(), EAssetNotAccepted);
    let asset_bit = 1u8 << (asset_index.destroy_some() as u8);
    let vault_balance = (vault_balance_of<T>(&bucket.vault, coin_type) as u256);
    assert!((amount as u256) <= vault_balance, EInsufficientVault);

    let sender = ctx.sender();
    let nonce = op_cap.capability_nonce;
    let value = amount as u256;
    let capability_id;
    let parent_id;
    let executions;
    let exhausted;
    {
        let capability = bucket.capabilities.borrow_mut(nonce);
        capability::check_link(capability, epoch, policy_version, now);
        capability::check_leaf(capability, sender, permissions::pay(), asset_bit);
        if (recipient != @0x0) {
            let payee = capability::payee(capability);
            assert!(payee == @0x0 || payee == recipient, ERecipientNotAllowed);
        };
        let cap_max = capability::remaining_value(capability, now, vault_balance);
        assert!(value <= cap_max, ECapabilityLimitExceeded);
        exhausted = capability::charge(capability, value, now);
        capability_id = capability::capability_id(capability);
        parent_id = capability::parent_id(capability);
        executions = capability::executions(capability);
    };

    let bucket_max = remaining_bucket_value(&bucket.policy, &bucket.usage, now, vault_balance);
    assert!(value <= bucket_max, EBucketLimitExceeded);
    capability::charge_usage(&mut bucket.usage, value, now);

    (capability_id, parent_id, executions, exhausted)
}

/// Bucket-wide velocity ceiling, mirroring `capability::remaining_value` against the Bucket's own policy limits.
fun remaining_bucket_value(policy: &Policy, usage: &capability::Usage, now: u64, vault_balance: u256): u256 {
    let day = capability::day_spent(usage, now);
    let mut remaining = policy::max_per_tx(policy) as u256;
    remaining = capability::min(
        remaining,
        capability::sub_floor(policy::max_hourly_spend(policy) as u256, capability::hour_spent(usage, now)),
    );
    remaining = capability::min(remaining, capability::sub_floor(policy::max_daily_spend(policy) as u256, day));
    capability::min(
        remaining,
        capability::sub_floor(vault_balance * (policy::max_daily_turnover_bps(policy) as u256) / 10_000, day),
    )
}

fun emit_issued(bucket_id: ID, capability: &Capability, nonce: u64) {
    event::emit(CapabilityIssued {
        bucket_id,
        capability_id: capability::capability_id(capability),
        parent_id: capability::parent_id(capability),
        nonce,
        depth: capability::depth(capability),
        operator: capability::operator(capability),
        operator_name: capability::operator_name(capability),
        permissions: capability::permissions(capability),
        capability_hash: capability::capability_hash(capability),
    });
}

fun take<T>(bucket: &mut Bucket, amount: u64, ctx: &mut TxContext): Coin<T> {
    coin::from_balance(take_balance<T>(bucket, amount), ctx)
}

fun take_balance<T>(bucket: &mut Bucket, amount: u64): Balance<T> {
    assert!(amount > 0, EZeroAmount);
    let coin_type = type_name::with_defining_ids<T>().into_string();
    assert!(bucket.vault.contains(coin_type), EInsufficientVault);
    let balance: &mut Balance<T> = bucket.vault.borrow_mut(coin_type);
    assert!(balance.value() >= amount, EInsufficientVault);
    balance.split(amount)
}

fun vault_balance_of<T>(vault: &Bag, coin_type: ascii::String): u64 {
    if (!vault.contains(coin_type)) return 0;
    let balance: &Balance<T> = vault.borrow(coin_type);
    balance.value()
}

fun accepted_type<T>(bucket: &Bucket): ascii::String {
    let coin_type = type_name::with_defining_ids<T>().into_string();
    assert!(policy::find_type(&bucket.policy, &coin_type).is_some(), EAssetNotAccepted);
    coin_type
}

fun assert_owner(bucket: &Bucket, cap: &OwnerCap) {
    assert!(cap.bucket_id == object::id(bucket), EWrongBucket);
}

fun assert_not_closed(bucket: &Bucket) {
    assert!(bucket.status != STATUS_CLOSED, EBucketClosed);
}

fun assert_active(bucket: &Bucket) {
    assert!(bucket.status == STATUS_ACTIVE, EBucketNotActive);
}

fun touch(bucket: &mut Bucket, clock: &Clock) {
    bucket.version = bucket.version + 1;
    bucket.updated_at_ms = clock.timestamp_ms();
}
