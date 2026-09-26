/**
 * Chain-neutral Financial Capability permission bits, identical to the EVM `BucketPermissions` and the Sui
 * `bucket::permissions` module.
 *
 * Delegable permissions describe execution an operator may perform over the holder's/owner's wallet liquidity.
 * Owner-only permissions describe authority over the Bucket itself and are never granted to a capability.
 */
export const Permission = {
  Rebalance: 1 << 0,
  Swap: 1 << 1,
  Pay: 1 << 2,
  Delegate: 1 << 3,
  UpdatePolicy: 1 << 4,
  ChangeOwner: 1 << 5,
  Withdraw: 1 << 6,
} as const
export type PermissionName = keyof typeof Permission

export const PERMISSION_COUNT = 7
export const ALL_PERMISSIONS = (1 << PERMISSION_COUNT) - 1
export const DELEGABLE_PERMISSIONS = Permission.Rebalance | Permission.Swap | Permission.Pay | Permission.Delegate
export const OWNER_ONLY_PERMISSIONS = Permission.UpdatePolicy | Permission.ChangeOwner | Permission.Withdraw

export const PERMISSION_LABEL: Record<PermissionName, string> = {
  Rebalance: 'REBALANCE',
  Swap: 'SWAP',
  Pay: 'PAY',
  Delegate: 'DELEGATE',
  UpdatePolicy: 'CHANGE POLICY',
  ChangeOwner: 'CHANGE OWNER',
  Withdraw: 'WITHDRAW ALL',
}

export const PERMISSION_NAMES = Object.keys(Permission) as PermissionName[]
export const DELEGABLE_PERMISSION_NAMES = PERMISSION_NAMES.filter((name) => (Permission[name] & OWNER_ONLY_PERMISSIONS) === 0)

export function isValidPermissionMask(mask: number): boolean {
  return Number.isInteger(mask) && mask >= 0 && (mask & ~ALL_PERMISSIONS) === 0
}

/** Non-empty and free of owner-only bits — the shape every issued capability's permission mask must have. */
export function isDelegablePermissionMask(mask: number): boolean {
  return mask !== 0 && (mask & ~DELEGABLE_PERMISSIONS) === 0
}

export function hasPermissions(mask: number, required: number): boolean {
  return (mask & required) === required
}

export function permissionMask(names: readonly PermissionName[]): number {
  return names.reduce((mask, name) => mask | Permission[name], 0)
}

export function permissionNames(mask: number): PermissionName[] {
  return PERMISSION_NAMES.filter((name) => (mask & Permission[name]) !== 0)
}
