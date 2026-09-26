// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025.

import { BPS, BPS_TO_WAD, MAX_TOKEN_DECIMALS, WAD, type AssetState, type PolicyParams } from '@bucket/protocol-types'
import { encodeAbiParameters, keccak256, type Hex } from 'viem'

/**
 * Exact bigint mirror of the Solidity `BucketMath` library. Every function returns the same integer as its
 * on-chain counterpart for the same inputs (including rounding direction), and throws where Solidity reverts.
 */

const MAX_UINT256 = (1n << 256n) - 1n

export type Rounding = 'floor' | 'ceil'

export class BucketMathError extends Error {
  constructor(
    readonly code: 'Overflow' | 'DivisionByZero' | 'EmptyBucket' | 'ZeroPrice' | 'PriceStale' | 'BalancesLength',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'BucketMathError'
  }
}

function checkU256(value: bigint): bigint {
  if (value < 0n || value > MAX_UINT256) throw new BucketMathError('Overflow', value.toString())
  return value
}

/** OpenZeppelin `Math.mulDiv` (full precision, reverts when the result exceeds uint256). */
export function mulDiv(x: bigint, y: bigint, denominator: bigint, rounding: Rounding = 'floor'): bigint {
  if (denominator === 0n) throw new BucketMathError('DivisionByZero', 'mulDiv')
  const product = x * y
  const quotient = product / denominator
  const result = rounding === 'ceil' && product % denominator !== 0n ? quotient + 1n : quotient
  return checkU256(result)
}

export function ceilDiv(x: bigint, y: bigint): bigint {
  if (y === 0n) throw new BucketMathError('DivisionByZero', 'ceilDiv')
  return x === 0n ? 0n : (x - 1n) / y + 1n
}

export function scaleOf(decimals: number): bigint {
  return 10n ** BigInt(MAX_TOKEN_DECIMALS - decimals)
}

export function valueOf(amount: bigint, decimals: number, priceWad: bigint, rounding: Rounding = 'floor'): bigint {
  return mulDiv(checkU256(amount * scaleOf(decimals)), priceWad, WAD, rounding)
}

export function amountOf(value: bigint, decimals: number, priceWad: bigint, rounding: Rounding = 'floor'): bigint {
  const normalized = mulDiv(value, WAD, priceWad, rounding)
  const scale = scaleOf(decimals)
  return rounding === 'ceil' ? ceilDiv(normalized, scale) : normalized / scale
}

export function abs(x: bigint): bigint {
  return x < 0n ? -x : x
}

export function requireFreshPrices(assets: readonly AssetState[], maxPriceAge: number, nowSeconds: bigint): void {
  for (const asset of assets) {
    if (asset.priceWad === 0n) throw new BucketMathError('ZeroPrice', asset.token)
    if (asset.priceUpdatedAt > nowSeconds || nowSeconds - asset.priceUpdatedAt > BigInt(maxPriceAge)) {
      throw new BucketMathError('PriceStale', `${asset.token} updated at ${asset.priceUpdatedAt}`)
    }
  }
}

export interface Valuation {
  readonly totalValue: bigint
  readonly values: readonly bigint[]
  readonly weightsWad: readonly bigint[]
  readonly deviationsWad: readonly bigint[]
  readonly maxAbsDeviationWad: bigint
}

export function valuate(assets: readonly AssetState[]): Valuation {
  return valuateAt(
    assets,
    assets.map((asset) => asset.balance),
  )
}

export function valuateAt(assets: readonly AssetState[], balances: readonly bigint[]): Valuation {
  if (balances.length !== assets.length) {
    throw new BucketMathError('BalancesLength', `${assets.length} assets, ${balances.length} balances`)
  }
  const values = assets.map((asset, i) => valueOf(balances[i] ?? 0n, asset.decimals, asset.priceWad, 'floor'))
  const totalValue = values.reduce((sum, value) => sum + value, 0n)
  if (totalValue === 0n) throw new BucketMathError('EmptyBucket', 'total value is zero')

  const weightsWad = values.map((value) => mulDiv(value, WAD, totalValue))
  const deviationsWad = weightsWad.map((weight, i) => weight - BigInt(assets[i]?.targetBps ?? 0) * BPS_TO_WAD)
  const maxAbsDeviationWad = deviationsWad.reduce((max, deviation) => (abs(deviation) > max ? abs(deviation) : max), 0n)
  return { totalValue, values, weightsWad, deviationsWad, maxAbsDeviationWad }
}

export function isOutOfPolicy(assets: readonly AssetState[], params: PolicyParams, v: Valuation): boolean {
  const threshold = BigInt(params.rebalanceThresholdBps) * BPS_TO_WAD
  return assets.some((asset, i) => {
    const weight = v.weightsWad[i] ?? 0n
    return (
      weight < BigInt(asset.minBps) * BPS_TO_WAD ||
      weight > BigInt(asset.maxBps) * BPS_TO_WAD ||
      abs(v.deviationsWad[i] ?? 0n) > threshold
    )
  })
}

/** Most overweight asset to sell and most underweight asset to buy among `assetMask`; `-1` when none
 *  (ties -> lowest index). Mirrors `BucketMath.selectLeg`. */
export function selectLeg(v: Valuation, assetMask = 0xff): { outIndex: number; inIndex: number } {
  let outIndex = -1
  let inIndex = -1
  let maxDeviation = 0n
  let minDeviation = 0n
  v.deviationsWad.forEach((deviation, i) => {
    if ((assetMask & (1 << i)) === 0) return
    if (deviation > maxDeviation) {
      maxDeviation = deviation
      outIndex = i
    }
    if (deviation < minDeviation) {
      minDeviation = deviation
      inIndex = i
    }
  })
  return { outIndex, inIndex }
}

/** True when asset `i` sits inside its hard band [minBps, maxBps] (`BucketMath.withinBand`). */
export function withinBand(asset: AssetState, v: Valuation, i: number): boolean {
  const weight = v.weightsWad[i] ?? 0n
  return weight >= BigInt(asset.minBps) * BPS_TO_WAD && weight <= BigInt(asset.maxBps) * BPS_TO_WAD
}

/** Commitment to a Bucket state, identical to `BucketMath.stateHash`. */
export function stateHash(balances: readonly bigint[], pricesWad: readonly bigint[]): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256[]' }, { type: 'uint256[]' }],
      [[...balances], [...pricesWad]],
    ),
  )
}

export function excessValue(v: Valuation, targetBps: number, i: number): bigint {
  const targetValue = mulDiv(v.totalValue, BigInt(targetBps), BPS, 'ceil')
  const value = v.values[i] ?? 0n
  return value > targetValue ? value - targetValue : 0n
}

export function deficitValue(v: Valuation, targetBps: number, i: number): bigint {
  const targetValue = mulDiv(v.totalValue, BigInt(targetBps), BPS, 'floor')
  const value = v.values[i] ?? 0n
  return targetValue > value ? targetValue - value : 0n
}

export function auctionDiscountBps(
  maxSlippageBps: number,
  duration: number,
  start: number,
  timestamp: bigint,
): bigint {
  const startBig = BigInt(start)
  if (timestamp <= startBig) return 0n
  const elapsed = timestamp - startBig < BigInt(duration) ? timestamp - startBig : BigInt(duration)
  return (BigInt(maxSlippageBps) * elapsed) / BigInt(duration)
}

export function quoteExactIn(
  amountIn: bigint,
  assetIn: AssetState,
  assetOut: AssetState,
  discountBps: bigint,
): bigint {
  let normalizedOut = mulDiv(checkU256(amountIn * scaleOf(assetIn.decimals)), assetIn.priceWad, assetOut.priceWad, 'floor')
  normalizedOut = mulDiv(normalizedOut, BPS, BPS - discountBps, 'floor')
  return normalizedOut / scaleOf(assetOut.decimals)
}

export function quoteExactOut(
  amountOut: bigint,
  assetIn: AssetState,
  assetOut: AssetState,
  discountBps: bigint,
): bigint {
  let normalizedIn = mulDiv(checkU256(amountOut * scaleOf(assetOut.decimals)), assetOut.priceWad, assetIn.priceWad, 'ceil')
  normalizedIn = mulDiv(normalizedIn, BPS - discountBps, BPS, 'ceil')
  return ceilDiv(normalizedIn, scaleOf(assetIn.decimals))
}

export function improves(pre: Valuation, post: Valuation, outIndex: number, inIndex: number): boolean {
  return (
    abs(post.deviationsWad[outIndex] ?? 0n) <= abs(pre.deviationsWad[outIndex] ?? 0n) &&
    abs(post.deviationsWad[inIndex] ?? 0n) <= abs(pre.deviationsWad[inIndex] ?? 0n) &&
    post.maxAbsDeviationWad <= pre.maxAbsDeviationWad
  )
}
