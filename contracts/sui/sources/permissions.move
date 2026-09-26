/// Chain-neutral Financial Capability permission bits, identical to the EVM `BucketPermissions`.
///
/// Delegable permissions describe execution an operator may perform over the holder's wallet liquidity. Owner-only
/// permissions describe authority over the Bucket itself; they exist so every layer can state explicitly that they are
/// never delegated, and any capability requesting them is rejected.
module bucket::permissions;

const PERM_REBALANCE: u32 = 1;
const PERM_SWAP: u32 = 2;
const PERM_PAY: u32 = 4;
const PERM_DELEGATE: u32 = 8;
const PERM_UPDATE_POLICY: u32 = 16;
const PERM_CHANGE_OWNER: u32 = 32;
const PERM_WITHDRAW: u32 = 64;

const ALL_PERMISSIONS: u32 = 127;
const DELEGABLE_PERMISSIONS: u32 = 15; // REBALANCE | SWAP | PAY | DELEGATE
const OWNER_ONLY_PERMISSIONS: u32 = 112; // UPDATE_POLICY | CHANGE_OWNER | WITHDRAW

public fun rebalance(): u32 { PERM_REBALANCE }

public fun swap(): u32 { PERM_SWAP }

public fun pay(): u32 { PERM_PAY }

public fun delegate(): u32 { PERM_DELEGATE }

public fun update_policy(): u32 { PERM_UPDATE_POLICY }

public fun change_owner(): u32 { PERM_CHANGE_OWNER }

public fun withdraw(): u32 { PERM_WITHDRAW }

public fun all(): u32 { ALL_PERMISSIONS }

public fun delegable(): u32 { DELEGABLE_PERMISSIONS }

public fun owner_only(): u32 { OWNER_ONLY_PERMISSIONS }

/// True when `mask` contains every bit of `required`.
public fun contains(mask: u32, required: u32): bool { mask & required == required }

/// True when `mask` only uses known permission bits.
public fun is_valid(mask: u32): bool { mask & (ALL_PERMISSIONS ^ 0xffffffff) == 0 }

/// True when `mask` is non-empty and free of owner-only bits.
public fun is_delegable(mask: u32): bool {
    mask != 0 && mask & (DELEGABLE_PERMISSIONS ^ 0xffffffff) == 0
}
