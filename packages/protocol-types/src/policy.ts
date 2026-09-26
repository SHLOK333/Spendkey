import { encodePacked, keccak256, stringToBytes, concat, isAddress, zeroAddress, type Hex } from 'viem'

import {
  ALL_VENUES,
  BPS,
  MAX_BUCKET_ASSETS,
  MAX_SLIPPAGE_LIMIT_BPS,
  MAX_THRESHOLD_LIMIT_BPS,
  MAX_TOKEN_DECIMALS,
  POLICY_DOMAIN_TAG,
} from './constants'
import { DELEGABLE_PERMISSIONS } from './permissions'
import type { AssetConfig, PolicyParams } from './types'

/** Policy invariant violated; `code` names the invariant exactly like the Solidity custom errors. */
export class PolicyValidationError extends Error {
  constructor(
    readonly code:
      | 'PolicyAssetCount'
      | 'PolicyTokenZero'
      | 'PolicyTokenDuplicate'
      | 'PolicyTokenDecimals'
      | 'PolicyWeightBand'
      | 'PolicyTargetSum'
      | 'PolicyThreshold'
      | 'PolicySlippage'
      | 'PolicyValueLimits'
      | 'PolicyPriceAge'
      | 'PolicyAuctionDuration'
      | 'PolicyTurnover'
      | 'PolicyVenues'
      | 'PolicyDelegablePermissions'
      | 'PolicyIntegerRange',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'PolicyValidationError'
  }
}

const U16 = 0xffff
const U32 = 0xffffffff
const U128 = (1n << 128n) - 1n

function requireInt(value: number, max: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new PolicyValidationError('PolicyIntegerRange', `${field}=${value} is not an integer in [0, ${max}]`)
  }
}

/** Invariants I1-I10, identical to `BucketPolicyLib.validate`. */
export function validatePolicy(params: PolicyParams, assets: readonly AssetConfig[]): void {
  if (assets.length === 0 || assets.length > MAX_BUCKET_ASSETS) {
    throw new PolicyValidationError('PolicyAssetCount', `${assets.length} assets`)
  }

  let targetSum = 0n
  const seen = new Set<string>()
  assets.forEach((asset, index) => {
    if (!isAddress(asset.token, { strict: false }) || asset.token.toLowerCase() === zeroAddress) {
      throw new PolicyValidationError('PolicyTokenZero', `asset ${index}`)
    }
    const key = asset.token.toLowerCase()
    if (seen.has(key)) throw new PolicyValidationError('PolicyTokenDuplicate', asset.token)
    seen.add(key)

    requireInt(asset.decimals, 0xff, 'decimals')
    if (asset.decimals > MAX_TOKEN_DECIMALS) {
      throw new PolicyValidationError('PolicyTokenDecimals', `${asset.token} has ${asset.decimals} decimals`)
    }
    requireInt(asset.minBps, U16, 'minBps')
    requireInt(asset.targetBps, U16, 'targetBps')
    requireInt(asset.maxBps, U16, 'maxBps')
    if (!(asset.minBps <= asset.targetBps && asset.targetBps <= asset.maxBps && BigInt(asset.maxBps) <= BPS)) {
      throw new PolicyValidationError(
        'PolicyWeightBand',
        `${asset.token} min=${asset.minBps} target=${asset.targetBps} max=${asset.maxBps}`,
      )
    }
    targetSum += BigInt(asset.targetBps)
  })
  if (targetSum !== BPS) throw new PolicyValidationError('PolicyTargetSum', `targets sum to ${targetSum}`)

  requireInt(params.rebalanceThresholdBps, U16, 'rebalanceThresholdBps')
  requireInt(params.maxSlippageBps, U16, 'maxSlippageBps')
  requireInt(params.maxPriceAge, U32, 'maxPriceAge')
  requireInt(params.auctionDuration, U32, 'auctionDuration')
  requireInt(params.venueMask, 0xff, 'venueMask')
  requireInt(params.maxDailyTurnoverBps, U16, 'maxDailyTurnoverBps')
  requireInt(params.delegablePermissions, U32, 'delegablePermissions')

  if (params.rebalanceThresholdBps === 0 || params.rebalanceThresholdBps > MAX_THRESHOLD_LIMIT_BPS) {
    throw new PolicyValidationError('PolicyThreshold', String(params.rebalanceThresholdBps))
  }
  if (params.maxSlippageBps > MAX_SLIPPAGE_LIMIT_BPS) {
    throw new PolicyValidationError('PolicySlippage', String(params.maxSlippageBps))
  }
  if (
    params.maxExecutionValue <= 0n ||
    params.maxExecutionValue > params.maxHourlyValue ||
    params.maxHourlyValue > params.maxDailyValue ||
    params.maxDailyValue > U128
  ) {
    throw new PolicyValidationError(
      'PolicyValueLimits',
      `execution=${params.maxExecutionValue} hourly=${params.maxHourlyValue} daily=${params.maxDailyValue}`,
    )
  }
  if (params.maxPriceAge === 0) throw new PolicyValidationError('PolicyPriceAge', '0')
  if (params.auctionDuration === 0) throw new PolicyValidationError('PolicyAuctionDuration', '0')
  if (params.maxDailyTurnoverBps === 0 || BigInt(params.maxDailyTurnoverBps) > BPS) {
    throw new PolicyValidationError('PolicyTurnover', String(params.maxDailyTurnoverBps))
  }
  if (params.venueMask === 0 || (params.venueMask & ~ALL_VENUES) !== 0) {
    throw new PolicyValidationError('PolicyVenues', String(params.venueMask))
  }
  if ((params.delegablePermissions & ~DELEGABLE_PERMISSIONS) !== 0) {
    throw new PolicyValidationError('PolicyDelegablePermissions', String(params.delegablePermissions))
  }
}

/**
 * Cross-chain policy commitment, byte-identical to `BucketPolicyLib.hash` (Solidity).
 */
export function hashPolicy(
  bucketId: Hex,
  version: number,
  params: PolicyParams,
  assets: readonly AssetConfig[],
): Hex {
  const header = encodePacked(
    [
      'bytes32',
      'bytes32',
      'uint32',
      'uint16',
      'uint16',
      'uint32',
      'uint32',
      'uint8',
      'uint16',
      'uint32',
      'uint128',
      'uint128',
      'uint128',
      'uint8',
    ],
    [
      keccak256(stringToBytes(POLICY_DOMAIN_TAG)),
      bucketId,
      version,
      params.rebalanceThresholdBps,
      params.maxSlippageBps,
      params.maxPriceAge,
      params.auctionDuration,
      params.venueMask,
      params.maxDailyTurnoverBps,
      params.delegablePermissions,
      params.maxExecutionValue,
      params.maxHourlyValue,
      params.maxDailyValue,
      assets.length,
    ],
  )
  const body = assets.map((asset) =>
    encodePacked(
      ['address', 'uint8', 'uint16', 'uint16', 'uint16'],
      [asset.token, asset.decimals, asset.targetBps, asset.minBps, asset.maxBps],
    ),
  )
  return keccak256(concat([header, ...body]))
}

/** Bit mask with one bit per policy asset (index order); bounds a capability's `assetMask`. */
export function fullAssetMask(assetCount: number): number {
  return (1 << assetCount) - 1
}

/** True when tokens, decimals or weight bands differ (informational; the new policy model has no owner-only
 *  "allocation change" gate — every policy field may change together in one `updatePolicy` call). */
export function allocationChanged(current: readonly AssetConfig[], next: readonly AssetConfig[]): boolean {
  if (current.length !== next.length) return true
  return current.some((a, i) => {
    const b = next[i]
    return (
      b === undefined ||
      a.token.toLowerCase() !== b.token.toLowerCase() ||
      a.decimals !== b.decimals ||
      a.targetBps !== b.targetBps ||
      a.minBps !== b.minBps ||
      a.maxBps !== b.maxBps
    )
  })
}
