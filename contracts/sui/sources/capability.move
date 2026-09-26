/// Financial Capabilities: scoped, revocable, hierarchical, non-escalating onchain rights to perform specific
/// financial actions against a specific Bucket, under explicit constraints.
///
/// This is BUCKET's own authorization primitive, native to Sui. SuiNS gives an identity a human-readable name;
/// it does not define what that identity is financially allowed to do. A `Capability` is what does: it binds an
/// operator address (resolved from a SuiNS name off-chain, retained here only for attribution) to a permission
/// set, an asset scope, quantitative limits and a validity window, all checked against — and never wider than —
/// its issuing policy or parent capability. Move enforces every rule; nothing here is a frontend-only check.
///
///   SuiNS            WHO      resolves a human name to a live address (identity, not authorization)
///   Capability        WHAT     what that address may do: permissions, assets, amounts, time, policy version
///   Move (this file)  HOW      `check_link` / `check_leaf` / `remaining_value` enforce it on every use
///   PTB / bucket.move WHERE    the settlement that only proceeds once the capability check passes
///
/// The core invariant, checked at issuance and never re-derivable afterwards because capabilities are immutable
/// once issued: **ChildAuthority ⊆ ParentAuthority**.
module bucket::capability;

use bucket::codec;
use bucket::permissions;
use bucket::policy::{Self, Policy};
use std::string::String;
use sui::address;
use sui::hash::keccak256;

// === Constants ===

const STATUS_ACTIVE: u8 = 1;
const STATUS_REVOKED: u8 = 2;
const STATUS_EXHAUSTED: u8 = 3;

/// Root = depth 0; a capability at MAX_DELEGATION_DEPTH - 1 may still delegate one more level.
const MAX_DELEGATION_DEPTH: u8 = 3;
const MAX_CAPABILITY_DURATION: u64 = 31_536_000; // 365 days, seconds
const HOUR: u64 = 3_600;
const DAY: u64 = 86_400;
const BPS: u256 = 10_000;

/// Domain tags of the capability identifier and its commitment. Kept keccak256-based (rather than Sui object IDs)
/// so a capability's identity is a pure function of its content and is reproducible by anyone off-chain.
const ID_DOMAIN_TAG: vector<u8> = b"BUCKET_CAPABILITY_ID_V1";
const HASH_DOMAIN_TAG: vector<u8> = b"BUCKET_CAPABILITY_V1";

// === Abort codes ===

const EPermissions: u64 = 401;
const EAssets: u64 = 402;
const EWindow: u64 = 404;
const ELimits: u64 = 405;
const ELimitExceedsCeiling: u64 = 406;
const ERecipientRequired: u64 = 407;
const EDepth: u64 = 408;
const EEpoch: u64 = 410;
const EPolicyVersion: u64 = 411;
const ERevoked: u64 = 412;
const EExhausted: u64 = 413;
const ENotYetValid: u64 = 414;
const EExpired: u64 = 415;
const EPermissionDenied: u64 = 416;
const EAssetNotAllowed: u64 = 417;
const EVelocity: u64 = 419;
const EOperatorMismatch: u64 = 420;

/// Quantitative ceilings. A child capability's limits must each be `<=` its parent's (K2). `0` in
/// `max_executions` means unlimited; every other field is a real ceiling (policy validation rejects `0` there).
public struct Limits has copy, drop, store {
    max_per_tx: u128,
    max_hourly_spend: u128,
    max_daily_spend: u128,
    max_daily_turnover_bps: u16,
    max_executions: u32,
}

/// Cumulative spend in fixed windows (`window = timestamp / size`); at most twice a window's limit can be spent
/// across one boundary, and the daily limit bounds that. Every limit is additionally capped per execution.
public struct Usage has copy, drop, store {
    hour_window: u64,
    day_window: u64,
    hour_value: u128,
    day_value: u128,
}

/// The immutable content of a capability. `operator` is what Move actually authorizes; `operator_name` is the
/// SuiNS name it was resolved from at issuance, kept only so the UI and audit trail can show a human name — it is
/// never re-resolved or trusted for authorization.
public struct Grant has copy, drop, store {
    capability_id: vector<u8>,
    parent_id: vector<u8>,
    issuer: address,
    operator: address,
    operator_name: String,
    depth: u8,
    permissions: u32,
    asset_mask: u8,
    valid_after: u64,
    valid_until: u64,
    policy_version: u32,
    epoch: u32,
    nonce: u64,
    /// Fixed payment destination if `PERM_PAY` is granted; `@0x0` otherwise.
    payee: address,
    limits: Limits,
}

/// A capability plus its live state (status, usage, execution count).
public struct Capability has copy, drop, store {
    grant: Grant,
    capability_hash: vector<u8>,
    status: u8,
    executions: u64,
    usage: Usage,
    issued_at_ms: u64,
}

// === Construction ===

public fun new_limits(
    max_per_tx: u128,
    max_hourly_spend: u128,
    max_daily_spend: u128,
    max_daily_turnover_bps: u16,
    max_executions: u32,
): Limits {
    Limits { max_per_tx, max_hourly_spend, max_daily_spend, max_daily_turnover_bps, max_executions }
}

/// Deterministic identifier: keccak256(ID_DOMAIN, bucket_ref, nonce). Computable before issuance from the
/// Bucket's next nonce, so a UI can show "this will be capability #N" before signing.
public fun id_of(bucket_ref: &vector<u8>, nonce: u64): vector<u8> {
    codec::assert_word(bucket_ref);
    let domain_tag = ID_DOMAIN_TAG;
    let mut bytes = keccak256(&domain_tag);
    bytes.append(*bucket_ref);
    codec::push_word(&mut bytes, nonce as u256);
    keccak256(&bytes)
}

/// Commitment to a capability's immutable content, so any two observers can prove they mean the same grant.
fun hash(bucket_ref: &vector<u8>, g: &Grant): vector<u8> {
    let domain_tag = HASH_DOMAIN_TAG;
    let mut bytes = keccak256(&domain_tag);
    bytes.append(g.capability_id);
    bytes.append(*bucket_ref);
    bytes.append(g.parent_id);
    bytes.append(g.issuer.to_bytes());
    bytes.append(g.operator.to_bytes());
    codec::push_be(&mut bytes, g.depth as u256, 1);
    codec::push_be(&mut bytes, g.permissions as u256, 4);
    codec::push_be(&mut bytes, g.asset_mask as u256, 1);
    codec::push_be(&mut bytes, g.valid_after as u256, 5);
    codec::push_be(&mut bytes, g.valid_until as u256, 5);
    codec::push_be(&mut bytes, g.policy_version as u256, 4);
    codec::push_be(&mut bytes, g.epoch as u256, 4);
    codec::push_be(&mut bytes, g.nonce as u256, 8);
    bytes.append(g.payee.to_bytes());
    let l = &g.limits;
    codec::push_be(&mut bytes, l.max_per_tx as u256, 16);
    codec::push_be(&mut bytes, l.max_hourly_spend as u256, 16);
    codec::push_be(&mut bytes, l.max_daily_spend as u256, 16);
    codec::push_be(&mut bytes, l.max_daily_turnover_bps as u256, 2);
    codec::push_be(&mut bytes, l.max_executions as u256, 4);
    keccak256(&bytes)
}

/// Issues a root capability, called by `bucket.move` under `OwnerCap` authority. Every ceiling is checked against
/// the canonical policy (K1: never an owner-only permission; every limit `<=` the policy's).
public(package) fun issue_root(
    bucket_ref: &vector<u8>,
    issuer: address,
    operator: address,
    operator_name: String,
    permissions: u32,
    asset_mask: u8,
    valid_after: u64,
    valid_until: u64,
    payee: address,
    limits: Limits,
    policy: &Policy,
    epoch: u32,
    nonce: u64,
    now_ms: u64,
): Capability {
    let capability_id = id_of(bucket_ref, nonce);
    let grant = Grant {
        capability_id,
        parent_id: codec::zero_word(),
        issuer,
        operator,
        operator_name,
        depth: 0,
        permissions,
        asset_mask,
        valid_after,
        valid_until,
        policy_version: policy::version(policy),
        epoch,
        nonce,
        payee,
        limits,
    };
    validate_shape(&grant);
    assert!(permissions::contains(policy::delegable_permissions(policy), grant.permissions), EPermissions);
    assert!(grant.asset_mask & (policy::full_asset_mask(policy) ^ 0xff) == 0, EAssets);
    let l = &grant.limits;
    assert!(
        l.max_per_tx <= policy::max_per_tx(policy) && l.max_hourly_spend <= policy::max_hourly_spend(policy)
            && l.max_daily_spend <= policy::max_daily_spend(policy)
            && l.max_daily_turnover_bps <= policy::max_daily_turnover_bps(policy),
        ELimitExceedsCeiling,
    );
    build(bucket_ref, grant, now_ms)
}

/// Issues a child capability, called by `bucket.move` under the parent operator's `OperatorCap`. Every field is
/// checked to be within the parent's (K2: `ChildAuthority ⊆ ParentAuthority`) — permissions, assets, time window,
/// each limit, and (if it pays) the same fixed payee.
public(package) fun issue_child(
    bucket_ref: &vector<u8>,
    parent: &Capability,
    operator: address,
    operator_name: String,
    permissions: u32,
    asset_mask: u8,
    valid_after: u64,
    valid_until: u64,
    payee: address,
    limits: Limits,
    nonce: u64,
    now_ms: u64,
): Capability {
    let p = &parent.grant;
    assert!(permissions::contains(p.permissions, permissions::delegate()), EPermissionDenied);
    let depth = p.depth + 1;
    assert!(depth < MAX_DELEGATION_DEPTH, EDepth);

    let capability_id = id_of(bucket_ref, nonce);
    let grant = Grant {
        capability_id,
        parent_id: p.capability_id,
        issuer: p.operator,
        operator,
        operator_name,
        depth,
        permissions,
        asset_mask,
        valid_after,
        valid_until,
        policy_version: p.policy_version,
        epoch: p.epoch,
        nonce,
        payee,
        limits,
    };
    validate_shape(&grant);
    // A capability at the last delegable level cannot delegate further.
    assert!(
        depth + 1 < MAX_DELEGATION_DEPTH || grant.permissions & permissions::delegate() == 0,
        EDepth,
    );
    assert!(permissions::contains(p.permissions, grant.permissions), EPermissions);
    assert!(grant.asset_mask & (p.asset_mask ^ 0xff) == 0, EAssets);
    assert!(grant.valid_after >= p.valid_after && grant.valid_until <= p.valid_until, EWindow);
    if (grant.permissions & permissions::pay() != 0) assert!(grant.payee == p.payee, ERecipientRequired);
    let l = &grant.limits;
    let pl = &p.limits;
    assert!(
        l.max_per_tx <= pl.max_per_tx && l.max_hourly_spend <= pl.max_hourly_spend
            && l.max_daily_spend <= pl.max_daily_spend && l.max_daily_turnover_bps <= pl.max_daily_turnover_bps,
        ELimitExceedsCeiling,
    );
    if (pl.max_executions != 0) {
        let left = (pl.max_executions as u64) - parent.executions;
        assert!(l.max_executions != 0 && (l.max_executions as u64) <= left, ELimitExceedsCeiling);
    };
    build(bucket_ref, grant, now_ms)
}

// === Validation ===

/// Checks one link of a chain at `timestamp` (seconds): status, epoch, policy version and validity window.
public fun check_link(c: &Capability, epoch: u32, policy_version: u32, timestamp: u64) {
    assert!(c.status != STATUS_REVOKED, ERevoked);
    assert!(c.status != STATUS_EXHAUSTED, EExhausted);
    assert!(c.grant.epoch == epoch, EEpoch);
    assert!(c.grant.policy_version == policy_version, EPolicyVersion);
    assert!(timestamp >= c.grant.valid_after, ENotYetValid);
    assert!(timestamp <= c.grant.valid_until, EExpired);
}

/// Checks the leaf's scope: caller identity, permission, assets.
public fun check_leaf(c: &Capability, operator: address, permission: u32, asset_mask: u8) {
    assert!(c.grant.operator == operator, EOperatorMismatch);
    assert!(permissions::contains(c.grant.permissions, permission), EPermissionDenied);
    assert!(asset_mask & (c.grant.asset_mask ^ 0xff) == 0, EAssetNotAllowed);
}

/// Largest value one link still allows at `timestamp`: per-transaction, hourly, daily and turnover
/// (`turnover_bps * total_value / BPS - day_spent`).
public fun remaining_value(c: &Capability, timestamp: u64, total_value: u256): u256 {
    let l = c.grant.limits;
    let day = day_spent(&c.usage, timestamp);
    let mut remaining = l.max_per_tx as u256;
    remaining = min(remaining, sub_floor(l.max_hourly_spend as u256, hour_spent(&c.usage, timestamp)));
    remaining = min(remaining, sub_floor(l.max_daily_spend as u256, day));
    min(remaining, sub_floor(total_value * (l.max_daily_turnover_bps as u256) / BPS, day))
}

/// Charges an execution to one link, rolling expired windows first; aborts past the hourly/daily limits.
/// Returns `true` when the charge exhausts the capability's lifetime execution count.
public(package) fun charge(c: &mut Capability, value: u256, timestamp: u64): bool {
    let hour_left = sub_floor(c.grant.limits.max_hourly_spend as u256, hour_spent(&c.usage, timestamp));
    let day_left = sub_floor(c.grant.limits.max_daily_spend as u256, day_spent(&c.usage, timestamp));
    assert!(value <= hour_left && value <= day_left, EVelocity);
    charge_usage(&mut c.usage, value, timestamp);
    c.executions = c.executions + 1;
    let max = c.grant.limits.max_executions as u64;
    if (max != 0 && c.executions >= max) {
        c.status = STATUS_EXHAUSTED;
        return true
    };
    false
}

public(package) fun revoke(c: &mut Capability) {
    assert!(c.status == STATUS_ACTIVE, ERevoked);
    c.status = STATUS_REVOKED;
}

// === Usage helpers ===

public fun new_usage(): Usage { Usage { hour_window: 0, day_window: 0, hour_value: 0, day_value: 0 } }

public fun hour_spent(u: &Usage, timestamp: u64): u256 {
    if (u.hour_window == timestamp / HOUR) (u.hour_value as u256) else 0
}

public fun day_spent(u: &Usage, timestamp: u64): u256 {
    if (u.day_window == timestamp / DAY) (u.day_value as u256) else 0
}

public(package) fun charge_usage(u: &mut Usage, value: u256, timestamp: u64) {
    let hour = timestamp / HOUR;
    let day = timestamp / DAY;
    let hour_value = (if (u.hour_window == hour) (u.hour_value as u256) else 0) + value;
    let day_value = (if (u.day_window == day) (u.day_value as u256) else 0) + value;
    u.hour_window = hour;
    u.day_window = day;
    u.hour_value = hour_value as u128;
    u.day_value = day_value as u128;
}

public fun sub_floor(a: u256, b: u256): u256 { if (b >= a) 0 else a - b }

public fun min(a: u256, b: u256): u256 { if (a < b) a else b }

// === Accessors ===

public fun capability_id(c: &Capability): vector<u8> { c.grant.capability_id }

public fun parent_id(c: &Capability): vector<u8> { c.grant.parent_id }

public fun is_root(c: &Capability): bool { codec::is_zero(&c.grant.parent_id) }

public fun issuer(c: &Capability): address { c.grant.issuer }

public fun operator(c: &Capability): address { c.grant.operator }

public fun operator_name(c: &Capability): String { c.grant.operator_name }

public fun depth(c: &Capability): u8 { c.grant.depth }

public fun permissions(c: &Capability): u32 { c.grant.permissions }

public fun asset_mask(c: &Capability): u8 { c.grant.asset_mask }

public fun valid_after(c: &Capability): u64 { c.grant.valid_after }

public fun valid_until(c: &Capability): u64 { c.grant.valid_until }

public fun policy_version(c: &Capability): u32 { c.grant.policy_version }

public fun epoch(c: &Capability): u32 { c.grant.epoch }

public fun nonce(c: &Capability): u64 { c.grant.nonce }

public fun payee(c: &Capability): address { c.grant.payee }

public fun status(c: &Capability): u8 { c.status }

public fun executions(c: &Capability): u64 { c.executions }

public fun capability_hash(c: &Capability): vector<u8> { c.capability_hash }

public fun limits(c: &Capability): Limits { c.grant.limits }

public fun max_per_tx(l: &Limits): u128 { l.max_per_tx }

public fun max_hourly_spend(l: &Limits): u128 { l.max_hourly_spend }

public fun max_daily_spend(l: &Limits): u128 { l.max_daily_spend }

public fun status_active(): u8 { STATUS_ACTIVE }

public fun status_revoked(): u8 { STATUS_REVOKED }

public fun status_exhausted(): u8 { STATUS_EXHAUSTED }

// === Internal ===

/// Rules shared by root and child grants: id derivation, valid permission set, non-empty asset scope, a sane
/// window within `MAX_CAPABILITY_DURATION`, coherent limits, and a payee iff `PERM_PAY` is granted.
fun validate_shape(g: &Grant) {
    assert!(permissions::is_valid(g.permissions) && permissions::is_delegable(g.permissions), EPermissions);
    assert!(g.asset_mask != 0, EAssets);
    assert!(
        g.valid_after < g.valid_until && g.valid_until - g.valid_after <= MAX_CAPABILITY_DURATION,
        EWindow,
    );
    let l = &g.limits;
    assert!(
        l.max_per_tx > 0 && l.max_per_tx <= l.max_hourly_spend && l.max_hourly_spend <= l.max_daily_spend
            && l.max_daily_turnover_bps > 0,
        ELimits,
    );
    let pays = g.permissions & permissions::pay() != 0;
    assert!(pays == (g.payee != @0x0), ERecipientRequired);
}

fun build(bucket_ref: &vector<u8>, grant: Grant, now_ms: u64): Capability {
    let capability_hash = hash(bucket_ref, &grant);
    Capability { grant, capability_hash, status: STATUS_ACTIVE, executions: 0, usage: new_usage(), issued_at_ms: now_ms }
}
