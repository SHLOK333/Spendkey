/// BUCKET Enhanced Access Control (EAC): a Move-native port of the **ENSv2** Enhanced Access Control semantics
/// (`@ensdomains/contracts-v2` `EnhancedAccessControl.sol` + `EACBaseRolesLib.sol`), applied to BUCKET resources.
///
/// This reproduces the ENSv2 model, not merely an EAC-inspired one:
///
///   * Resource-scoped roles. A resource is an arbitrary identifier (here a Bucket's object address); each resource
///     has an independent role assignment per account.
///   * `ROOT_RESOURCE` (0x0). Roles granted on the root resource apply to *every* resource: a check ORs the
///     account's root roles with its resource-specific roles. `grant_roles`/`revoke_roles` reject the root resource;
///     use `grant_root_roles`/`revoke_root_roles`.
///   * Nybble-packed role bitmap (`u256`). Each role occupies one nybble (4 bits); the lower 128 bits hold 32
///     regular roles, the upper 128 bits hold their 32 admin roles. A regular role at nybble N is `1 << (N*4)`; its
///     admin role is `role << 128`. `ALL_ROLES` has bit 0 of every nybble set.
///   * Per-role admin roles. Holding admin role `R<<128` authorizes granting/revoking both the regular role `R`
///     and the admin role `R<<128` itself — exactly `withAdminRolesApplied` in ENSv2. There is deliberately no
///     single super-`ROLE_ADMIN`.
///   * `grant_roles(resource, bitmap, account)` / `revoke_roles(...)` / `has_roles(resource, bitmap, account)`
///     match ENSv2's `grantRoles` / `revokeRoles` / `hasRoles`.
///
/// SuiNS supplies identity only: `resolve_target` reads the real on-chain `suins::registry` and returns the target
/// address, which becomes the EAC principal. The address is the security principal; the name never is.
///
/// Adapted for Move (see docs/SECURITY.md): the ENSv2 per-role **assignee counter** (max 15 holders per role, used
/// only as an operational cap, not an authorization rule) is not reproduced; and role administration is bootstrapped
/// per resource by the Bucket owner's `OwnerCap` (BUCKET's registrar-equivalent) rather than by a global registrar.
module bucket::access;

use std::string::String;
use sui::{clock::Clock, event, table::{Self, Table}};
use suins::{domain, name_record::NameRecord, registry::{Self, Registry}};

// === Bit layout (identical positions to ENSv2 EACBaseRolesLib) ===

const U256_MAX: u256 = 0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff;
/// Bit 0 of every nybble — one unit per role slot across all 64 slots (32 regular + 32 admin).
const ALL_ROLES: u256 = 0x1111111111111111111111111111111111111111111111111111111111111111;
/// The 32 admin-role nybbles (upper 128 bits).
const ADMIN_ROLES: u256 = 0x1111111111111111111111111111111100000000000000000000000000000000;

/// The root resource. Roles here apply to every resource. Bucket object addresses are never `@0x0`.
const ROOT_RESOURCE: address = @0x0;

// === BUCKET regular roles (regular half; admin role of each is `role << 128`) ===

const ROLE_VIEW: u256 = 0x1; // nybble 0
const ROLE_PAY: u256 = 0x10; // nybble 1
const ROLE_REBALANCE: u256 = 0x100; // nybble 2
const ROLE_EXECUTE: u256 = 0x1000; // nybble 3
const ROLE_GUARDIAN: u256 = 0x10000; // nybble 4

const ADMIN_SHIFT: u8 = 128;

// === Abort codes ===

const EInvalidRoleBitmap: u64 = 700;
const ECannotGrantRoles: u64 = 701;
const ECannotRevokeRoles: u64 = 702;
const ERootResourceNotAllowed: u64 = 703;
const EInvalidAccount: u64 = 704;
const ENameNotRegistered: u64 = 705;
const ENameExpired: u64 = 706;
const ENameNoTarget: u64 = 707;

// === Storage ===

/// Composite key: roles are stored per (resource, account), exactly like ENSv2's
/// `mapping(resource => mapping(account => roleBitmap))`.
public struct ResourceAccount has copy, drop, store {
    resource: address,
    account: address,
}

/// The shared EAC registry: one object holds every resource's role assignments, so `ROOT_RESOURCE` can apply
/// across all of them. Created once by `init` at publish and shared.
public struct AccessControl has key {
    id: UID,
    roles: Table<ResourceAccount, u256>,
}

// === Events ===

public struct RolesGranted has copy, drop {
    resource: address,
    account: address,
    role_bitmap: u256,
    by: address,
}

public struct RolesRevoked has copy, drop {
    resource: address,
    account: address,
    role_bitmap: u256,
    by: address,
}

// === Construction ===

fun init(ctx: &mut TxContext) {
    transfer::share_object(AccessControl { id: object::new(ctx), roles: table::new(ctx) });
}

// === Role / resource accessors ===

public fun view(): u256 { ROLE_VIEW }

public fun pay(): u256 { ROLE_PAY }

public fun rebalance(): u256 { ROLE_REBALANCE }

public fun execute(): u256 { ROLE_EXECUTE }

public fun guardian(): u256 { ROLE_GUARDIAN }

/// The admin role that governs granting/revoking `role` (ENSv2: `role << 128`).
public fun admin(role: u256): u256 { role << ADMIN_SHIFT }

public fun all_roles(): u256 { ALL_ROLES }

public fun admin_roles(): u256 { ADMIN_ROLES }

public fun root_resource(): address { ROOT_RESOURCE }

// === Bit helpers (mirror EACBaseRolesLib) ===

fun bit_not(x: u256): u256 { x ^ U256_MAX }

fun check_role_bitmap(role_bitmap: u256) {
    assert!(role_bitmap & bit_not(ALL_ROLES) == 0, EInvalidRoleBitmap);
}

/// ENSv2 `withAdminRolesApplied`: an admin role implies authority over its regular role and over itself.
fun with_admin_roles_applied(role_bitmap: u256): u256 {
    let a = role_bitmap >> ADMIN_SHIFT;
    (a << ADMIN_SHIFT) | a
}

// === Reads ===

fun get_roles(ac: &AccessControl, resource: address, account: address): u256 {
    let key = ResourceAccount { resource, account };
    if (ac.roles.contains(key)) *ac.roles.borrow(key) else 0
}

/// Effective roles = root roles OR resource roles (ENSv2 `_effectiveRoles`).
fun effective_roles(ac: &AccessControl, resource: address, account: address): u256 {
    get_roles(ac, ROOT_RESOURCE, account) | get_roles(ac, resource, account)
}

/// Raw stored roles for `account` within `resource` (no root fallback, no owner implication).
public fun roles(ac: &AccessControl, resource: address, account: address): u256 {
    get_roles(ac, resource, account)
}

/// ENSv2 `hasRoles`: the account holds *all* bits of `role_bitmap`, counting the root-resource fallback.
public fun has_roles(
    ac: &AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
): bool {
    check_role_bitmap(role_bitmap);
    effective_roles(ac, resource, account) & role_bitmap == role_bitmap
}

/// ENSv2 `hasRootRoles`: the account holds all bits of `role_bitmap` on the root resource specifically.
public fun has_root_roles(ac: &AccessControl, role_bitmap: u256, account: address): bool {
    get_roles(ac, ROOT_RESOURCE, account) & role_bitmap == role_bitmap
}

/// The roles `account` is allowed to grant/revoke within `resource` (ENSv2 `_getSettableRoles`).
public fun settable_roles(ac: &AccessControl, resource: address, account: address): u256 {
    with_admin_roles_applied(effective_roles(ac, resource, account))
}

// === Grant / revoke (ENSv2-equivalent, admin-role checked against the caller) ===

/// ENSv2 `grantRoles`: rejects the root resource; the caller must hold the admin role for every role granted.
public fun grant_roles(
    ac: &mut AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
    ctx: &TxContext,
) {
    assert!(resource != ROOT_RESOURCE, ERootResourceNotAllowed);
    check_can_grant(ac, resource, role_bitmap, ctx.sender());
    do_grant(ac, resource, role_bitmap, account, ctx.sender());
}

/// ENSv2 `grantRootRoles`: grants on the root resource; the caller must hold the admin role for every role granted.
public fun grant_root_roles(
    ac: &mut AccessControl,
    role_bitmap: u256,
    account: address,
    ctx: &TxContext,
) {
    check_can_grant(ac, ROOT_RESOURCE, role_bitmap, ctx.sender());
    do_grant(ac, ROOT_RESOURCE, role_bitmap, account, ctx.sender());
}

/// ENSv2 `revokeRoles`: rejects the root resource; the caller must hold the admin role for every role revoked.
public fun revoke_roles(
    ac: &mut AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
    ctx: &TxContext,
) {
    assert!(resource != ROOT_RESOURCE, ERootResourceNotAllowed);
    check_can_revoke(ac, resource, role_bitmap, ctx.sender());
    do_revoke(ac, resource, role_bitmap, account, ctx.sender());
}

/// ENSv2 `revokeRootRoles`.
public fun revoke_root_roles(
    ac: &mut AccessControl,
    role_bitmap: u256,
    account: address,
    ctx: &TxContext,
) {
    check_can_revoke(ac, ROOT_RESOURCE, role_bitmap, ctx.sender());
    do_revoke(ac, ROOT_RESOURCE, role_bitmap, account, ctx.sender());
}

fun check_can_grant(ac: &AccessControl, resource: address, role_bitmap: u256, caller: address) {
    assert!(role_bitmap & bit_not(settable_roles(ac, resource, caller)) == 0, ECannotGrantRoles);
}

fun check_can_revoke(ac: &AccessControl, resource: address, role_bitmap: u256, caller: address) {
    assert!(role_bitmap & bit_not(settable_roles(ac, resource, caller)) == 0, ECannotRevokeRoles);
}

// === Owner bootstrap (BUCKET adaptation of ENSv2's registrar seeding) ===
//
// A Bucket owner is the root authority for its own resource. `bucket::bucket` verifies the `OwnerCap` and then
// calls these unchecked seeders — the OwnerCap possession *is* the authority, so no pre-existing admin role is
// required. This only ever seeds a Bucket's own (non-root) resource; it can never seed the root resource.

public(package) fun owner_grant(
    ac: &mut AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
    by: address,
) {
    assert!(resource != ROOT_RESOURCE, ERootResourceNotAllowed);
    do_grant(ac, resource, role_bitmap, account, by);
}

public(package) fun owner_revoke(
    ac: &mut AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
    by: address,
) {
    assert!(resource != ROOT_RESOURCE, ERootResourceNotAllowed);
    do_revoke(ac, resource, role_bitmap, account, by);
}

// === Internal state changes (ENSv2 `_grantRoles` / `_revokeRoles`, minus assignee counting) ===

fun do_grant(
    ac: &mut AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
    by: address,
) {
    check_role_bitmap(role_bitmap);
    assert!(account != @0x0, EInvalidAccount);
    if (role_bitmap == 0) return;
    let key = ResourceAccount { resource, account };
    let current = if (ac.roles.contains(key)) *ac.roles.borrow(key) else 0;
    let updated = current | role_bitmap;
    if (updated != current) {
        if (ac.roles.contains(key)) *ac.roles.borrow_mut(key) = updated
        else ac.roles.add(key, updated);
        event::emit(RolesGranted { resource, account, role_bitmap, by });
    };
}

fun do_revoke(
    ac: &mut AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
    by: address,
) {
    check_role_bitmap(role_bitmap);
    let key = ResourceAccount { resource, account };
    if (!ac.roles.contains(key)) return;
    let current = *ac.roles.borrow(key);
    let updated = current & bit_not(role_bitmap);
    if (updated != current) {
        if (updated == 0) { ac.roles.remove(key); } else { *ac.roles.borrow_mut(key) = updated; };
        event::emit(RolesRevoked { resource, account, role_bitmap, by });
    };
}

// === SuiNS resolution (real on-chain registry reads) ===

/// Resolves `name` to its live target address via the real SuiNS registry, aborting if the name is unregistered,
/// expired, or has no target. The returned address — never the string — is the EAC principal.
public fun resolve_target(reg: &Registry, name: String, clock: &Clock): address {
    let record = lookup_live(reg, name, clock);
    let target = record.target_address();
    assert!(target.is_some(), ENameNoTarget);
    target.destroy_some()
}

/// Non-aborting resolver for views: `none` when unregistered, expired, or no target.
public fun try_resolve_target(reg: &Registry, name: String, clock: &Clock): Option<address> {
    let opt = registry::lookup(reg, domain::new(name));
    if (opt.is_none()) return option::none();
    let record = opt.destroy_some();
    if (record.has_expired(clock)) return option::none();
    record.target_address()
}

fun lookup_live(reg: &Registry, name: String, clock: &Clock): NameRecord {
    let opt = registry::lookup(reg, domain::new(name));
    assert!(opt.is_some(), ENameNotRegistered);
    let record = opt.destroy_some();
    assert!(!record.has_expired(clock), ENameExpired);
    record
}

// === Test-only helpers ===

#[test_only]
public fun new_for_testing(ctx: &mut TxContext): AccessControl {
    AccessControl { id: object::new(ctx), roles: table::new(ctx) }
}

#[test_only]
/// Seeds roles on any resource (including `ROOT_RESOURCE`) with no admin check — for exercising root-resource and
/// admin-role scenarios in tests. Never compiled into the published package.
public fun grant_unchecked_for_testing(
    ac: &mut AccessControl,
    resource: address,
    role_bitmap: u256,
    account: address,
) {
    do_grant(ac, resource, role_bitmap, account, @0x0);
}
