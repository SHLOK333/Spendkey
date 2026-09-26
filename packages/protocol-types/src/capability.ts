import { encodePacked, keccak256, stringToBytes, concat, type Address, type Hex } from 'viem'

import { CAPABILITY_HASH_DOMAIN_TAG, CAPABILITY_ID_DOMAIN_TAG, MAX_CAPABILITY_DURATION } from './constants'
import { DELEGABLE_PERMISSIONS, isValidPermissionMask } from './permissions'
import type { Capability, CapabilityGrant } from './types'

/** Deterministic EVM capability identifier, identical to `CapabilityLib.id`. Computable before issuance from the
 *  Bucket's next nonce, so a UI can show "this will be capability #N" before signing. */
export function computeCapabilityId(bucketId: Hex, nonce: bigint): Hex {
  return keccak256(
    encodePacked(
      ['bytes32', 'bytes32', 'uint64'],
      [keccak256(stringToBytes(CAPABILITY_ID_DOMAIN_TAG)), bucketId, nonce],
    ),
  )
}

/** Cross-chain capability commitment, byte-identical to `CapabilityLib.hash`. */
export function hashCapability(capabilityId: Hex, bucketId: Hex, c: Capability): Hex {
  const head = encodePacked(
    ['bytes32', 'bytes32', 'bytes32', 'bytes32', 'address', 'address', 'uint8', 'uint32', 'uint8', 'uint8', 'uint40', 'uint40'],
    [
      keccak256(stringToBytes(CAPABILITY_HASH_DOMAIN_TAG)),
      capabilityId,
      bucketId,
      c.parentId,
      c.issuer,
      c.operator,
      c.depth,
      c.permissions,
      c.assetMask,
      c.venueMask,
      c.validAfter,
      c.validUntil,
    ],
  )
  const tail = encodePacked(
    ['uint32', 'uint32', 'uint64', 'address', 'uint128', 'uint128', 'uint128', 'uint16', 'uint16', 'uint32'],
    [
      c.policyVersion,
      c.epoch,
      c.nonce,
      c.payee,
      c.limits.maxExecutionValue,
      c.limits.maxHourlyValue,
      c.limits.maxDailyValue,
      c.limits.maxSlippageBps,
      c.limits.maxDailyTurnoverBps,
      c.limits.maxExecutions,
    ],
  )
  return keccak256(concat([head, tail]))
}

/** Validation error of a capability grant; `code` names the invariant like the Solidity custom errors. */
export class CapabilityValidationError extends Error {
  constructor(
    readonly code:
      | 'CapabilityPermissionsInvalid'
      | 'CapabilityAssetsInvalid'
      | 'CapabilityVenuesInvalid'
      | 'CapabilityWindowInvalid'
      | 'CapabilityLimitsInvalid'
      | 'CapabilityPayeeInvalid',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'CapabilityValidationError'
  }
}

/** Checks shared by root and child grants (mirrors `BucketCapabilities._validateShape`). Does not check
 *  monotonicity against a policy or parent — see `isChildWithinParent`. */
export function validateGrantShape(grant: CapabilityGrant, nowSeconds: number): void {
  if (!isValidPermissionMask(grant.permissions) || (grant.permissions & ~DELEGABLE_PERMISSIONS) !== 0 || grant.permissions === 0) {
    throw new CapabilityValidationError('CapabilityPermissionsInvalid', String(grant.permissions))
  }
  if (grant.assetMask === 0) throw new CapabilityValidationError('CapabilityAssetsInvalid', '0')
  if (grant.venueMask === 0) throw new CapabilityValidationError('CapabilityVenuesInvalid', '0')
  if (
    grant.validAfter >= grant.validUntil ||
    grant.validUntil <= nowSeconds ||
    grant.validUntil - grant.validAfter > MAX_CAPABILITY_DURATION
  ) {
    throw new CapabilityValidationError('CapabilityWindowInvalid', `${grant.validAfter}..${grant.validUntil}`)
  }
  const l = grant.limits
  if (l.maxExecutionValue <= 0n || l.maxExecutionValue > l.maxHourlyValue || l.maxHourlyValue > l.maxDailyValue || l.maxDailyTurnoverBps <= 0) {
    throw new CapabilityValidationError('CapabilityLimitsInvalid', JSON.stringify(l))
  }
  const pays = (grant.permissions & DELEGABLE_PERMISSIONS & 0b100) !== 0 // Permission.Pay bit (index 2)
  const hasPayee = grant.payee.toLowerCase() !== CAPABILITY_ZERO_ADDRESS
  if (pays !== hasPayee) throw new CapabilityValidationError('CapabilityPayeeInvalid', grant.payee)
}

/** `ChildAuthority ⊆ ParentAuthority`: every field of `child` must be within `parent`'s. */
export function isChildWithinParent(child: CapabilityGrant, parent: Capability): boolean {
  const permissionsOk = (child.permissions & ~parent.permissions) === 0
  const assetsOk = (child.assetMask & ~parent.assetMask) === 0
  const venuesOk = (child.venueMask & ~parent.venueMask) === 0
  const windowOk = child.validAfter >= parent.validAfter && child.validUntil <= parent.validUntil
  const payeeOk = (child.permissions & 0b100) === 0 || child.payee.toLowerCase() === parent.payee.toLowerCase()
  const l = child.limits
  const pl = parent.limits
  const limitsOk =
    l.maxExecutionValue <= pl.maxExecutionValue &&
    l.maxHourlyValue <= pl.maxHourlyValue &&
    l.maxDailyValue <= pl.maxDailyValue &&
    l.maxSlippageBps <= pl.maxSlippageBps &&
    l.maxDailyTurnoverBps <= pl.maxDailyTurnoverBps
  const executionsOk =
    pl.maxExecutions === 0 ||
    (l.maxExecutions !== 0 && l.maxExecutions <= pl.maxExecutions - Number(parent.executions))
  return permissionsOk && assetsOk && venuesOk && windowOk && payeeOk && limitsOk && executionsOk
}

/** Largest value one link (capability or policy-shaped) allows right now, given cumulative usage. */
export function remainingValue(
  limits: { maxExecutionValue: bigint; maxHourlyValue: bigint; maxDailyValue: bigint; maxDailyTurnoverBps: number },
  usage: { hourSpent: bigint; daySpent: bigint },
  totalValue: bigint,
): bigint {
  const subFloor = (a: bigint, b: bigint): bigint => (b >= a ? 0n : a - b)
  const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)
  let remaining = limits.maxExecutionValue
  remaining = min(remaining, subFloor(limits.maxHourlyValue, usage.hourSpent))
  remaining = min(remaining, subFloor(limits.maxDailyValue, usage.daySpent))
  return min(remaining, subFloor((totalValue * BigInt(limits.maxDailyTurnoverBps)) / 10_000n, usage.daySpent))
}

/** Value spent in the fixed hour/day window containing `timestamp` (seconds). */
export function spentInWindow(usage: { hourWindow: number; dayWindow: number; hourValue: bigint; dayValue: bigint }, nowSeconds: number) {
  const hourSpent = usage.hourWindow === Math.floor(nowSeconds / 3_600) ? usage.hourValue : 0n
  const daySpent = usage.dayWindow === Math.floor(nowSeconds / 86_400) ? usage.dayValue : 0n
  return { hourSpent, daySpent }
}

export const CAPABILITY_ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

