// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
// Powered by SwapVM — © Degensoft Ltd 2025.

import {
  IntentKind,
  type AssetState,
  type BucketSnapshot,
  type EffectiveLimits,
  type Intent,
} from '@bucket/protocol-types'
import { isAddressEqual } from 'viem'

import {
  amountOf,
  BucketMathError,
  auctionDiscountBps,
  deficitValue,
  excessValue,
  improves,
  isOutOfPolicy,
  quoteExactIn,
  requireFreshPrices,
  selectLeg,
  valuate,
  valuateAt,
  valueOf,
  withinBand,
  type Valuation,
} from './math'

/** Mirror of `BucketController.openRebalanceIntent` leg selection, given the effective limits already fetched
 *  from `effectiveLimits(bucketId, capabilityId)` and the capability's `assetMask`. */
export type RebalancePlan =
  | {
      readonly required: true
      readonly valuation: Valuation
      readonly outIndex: number
      readonly inIndex: number
      readonly tradeValue: bigint
      readonly budgetOut: bigint
    }
  | {
      readonly required: false
      readonly valuation: Valuation
      readonly reason: 'WithinPolicy' | 'NothingToRebalance' | 'PriceStale' | 'LimitsExhausted'
    }

function maxValue(limits: EffectiveLimits): bigint {
  const min = (a: bigint, b: bigint): bigint => (a < b ? a : b)
  return min(min(limits.maxExecutionValue, limits.remainingHourlyValue), min(limits.remainingDailyValue, limits.remainingTurnoverValue))
}

export function planRebalance(
  snapshot: BucketSnapshot,
  limits: EffectiveLimits,
  assetMask: number,
  nowSeconds: bigint,
): RebalancePlan {
  const valuation = valuate(snapshot.assets)
  try {
    requireFreshPrices(snapshot.assets, snapshot.params.maxPriceAge, nowSeconds)
  } catch (error) {
    if (error instanceof BucketMathError && error.code === 'PriceStale') {
      return { required: false, valuation, reason: 'PriceStale' }
    }
    throw error
  }
  if (!isOutOfPolicy(snapshot.assets, snapshot.params, valuation)) {
    return { required: false, valuation, reason: 'WithinPolicy' }
  }
  const cap = maxValue(limits)
  if (cap <= 0n) return { required: false, valuation, reason: 'LimitsExhausted' }

  const { outIndex, inIndex } = selectLeg(valuation, assetMask)
  const assetOut = snapshot.assets[outIndex]
  const assetIn = snapshot.assets[inIndex]
  if (!assetOut || !assetIn) return { required: false, valuation, reason: 'NothingToRebalance' }

  let tradeValue = excessValue(valuation, assetOut.targetBps, outIndex)
  const deficit = deficitValue(valuation, assetIn.targetBps, inIndex)
  if (deficit < tradeValue) tradeValue = deficit
  if (cap < tradeValue) tradeValue = cap
  const budgetOut = amountOf(tradeValue, assetOut.decimals, assetOut.priceWad, 'floor')
  if (budgetOut === 0n) return { required: false, valuation, reason: 'NothingToRebalance' }

  return { required: true, valuation, outIndex, inIndex, tradeValue, budgetOut }
}

/** Names match the Solidity custom errors so UI and on-chain failures read the same. */
export type FillFailure =
  | 'BucketWithinPolicy'
  | 'BucketDirectionInvalid'
  | 'BucketZeroAmount'
  | 'BucketTargetOvershoot'
  | 'BucketExecutionLimitExceeded'
  | 'BucketHourlyLimitExceeded'
  | 'BucketDailyLimitExceeded'
  | 'BucketTurnoverLimitExceeded'
  | 'BucketIntentBudgetExceeded'
  | 'BucketAquaBudgetExceeded'
  | 'PostStateNotImproved'
  | 'PostStateOutOfBand'

export interface FillSimulation {
  readonly ok: boolean
  readonly failure: FillFailure | null
  readonly amountIn: bigint
  readonly amountOut: bigint
  readonly discountBps: bigint
  readonly valueOut: bigint
  readonly pre: Valuation
  readonly post: Valuation | null
  readonly outIndex: number
  readonly inIndex: number
}

/**
 * Exact-in fill simulation mirroring `BucketQuote` + `BucketSpendLimit` (the view instructions) and the
 * post-settlement invariant the controller's maker hooks enforce. `intent` and `limits` are read directly from
 * the controller (`loadFrame` / `effectiveLimits`) — capability-chain traversal happens on-chain, not here.
 *
 * @param nowSeconds block time used for the price-freshness check and the auction discount
 */
export function simulateFill(
  snapshot: BucketSnapshot,
  intent: Intent,
  limits: EffectiveLimits,
  amountIn: bigint,
  nowSeconds: bigint,
): FillSimulation {
  requireFreshPrices(snapshot.assets, snapshot.params.maxPriceAge, nowSeconds)
  const pre = valuate(snapshot.assets)
  const outIndex = snapshot.assets.findIndex((a) => isAddressEqual(a.token, intent.tokenOut))
  const inIndex = snapshot.assets.findIndex((a) => isAddressEqual(a.token, intent.tokenIn))
  const base = { amountIn, amountOut: 0n, discountBps: 0n, valueOut: 0n, pre, post: null, outIndex, inIndex }
  const fail = (failure: FillFailure, extra: Partial<FillSimulation> = {}): FillSimulation => ({
    ...base,
    ...extra,
    ok: false,
    failure,
  })

  const assetOut: AssetState | undefined = snapshot.assets[outIndex]
  const assetIn: AssetState | undefined = snapshot.assets[inIndex]
  if (!assetOut || !assetIn) return fail('BucketDirectionInvalid')

  const isRebalance = intent.kind === IntentKind.Rebalance
  if (isRebalance) {
    if (!isOutOfPolicy(snapshot.assets, snapshot.params, pre)) return fail('BucketWithinPolicy')
    if (!((pre.deviationsWad[outIndex] ?? 0n) > 0n && (pre.deviationsWad[inIndex] ?? 0n) < 0n)) {
      return fail('BucketDirectionInvalid')
    }
  }

  const discountBps = auctionDiscountBps(limits.maxSlippageBps, snapshot.params.auctionDuration, intent.openedAt, nowSeconds)
  const amountOut = quoteExactIn(amountIn, assetIn, assetOut, discountBps)
  const valueOut = amountOut === 0n ? 0n : valueOf(amountOut, assetOut.decimals, assetOut.priceWad, 'ceil')
  const priced = { amountOut, discountBps, valueOut }
  if (amountIn === 0n || amountOut === 0n) return fail('BucketZeroAmount', priced)

  if (isRebalance) {
    const excessOut = excessValue(pre, assetOut.targetBps, outIndex)
    const deficitIn = deficitValue(pre, assetIn.targetBps, inIndex)
    const valueIn = valueOf(amountIn, assetIn.decimals, assetIn.priceWad, 'ceil')
    if (valueOut > excessOut || valueIn > deficitIn) return fail('BucketTargetOvershoot', priced)
  }

  if (valueOut > limits.maxExecutionValue) return fail('BucketExecutionLimitExceeded', priced)
  if (valueOut > limits.remainingHourlyValue) return fail('BucketHourlyLimitExceeded', priced)
  if (valueOut > limits.remainingDailyValue) return fail('BucketDailyLimitExceeded', priced)
  if (valueOut > limits.remainingTurnoverValue) return fail('BucketTurnoverLimitExceeded', priced)
  if (amountOut > intent.remainingOut) return fail('BucketIntentBudgetExceeded', priced)

  const postBalances = snapshot.assets.map((asset, i) =>
    i === outIndex ? asset.balance - amountOut : i === inIndex ? asset.balance + amountIn : asset.balance,
  )
  const post = valuateAt(snapshot.assets, postBalances)
  if (isRebalance) {
    if (!improves(pre, post, outIndex, inIndex)) return fail('PostStateNotImproved', { ...priced, post })
  } else {
    if (!withinBand(assetOut, post, outIndex) || !withinBand(assetIn, post, inIndex)) {
      return fail('PostStateOutOfBand', { ...priced, post })
    }
  }

  return { ...base, ...priced, post, ok: true, failure: null }
}

/**
 * Largest exact-in amount the Bucket accepts with the concession evaluated at `discountAt`. Acceptance is an
 * interval in `amountIn` (dust below it, caps above it), so a binary search over the exact simulator finds the
 * on-chain maximum. `aquaBalanceOut` additionally caps `amountOut` — pass `intent.remainingOut` when unknown.
 */
export function maxFillAmountIn(
  snapshot: BucketSnapshot,
  intent: Intent,
  limits: EffectiveLimits,
  aquaBalanceOut: bigint,
  nowSeconds: bigint,
): FillSimulation | null {
  const assetIn = snapshot.assets.find((a) => isAddressEqual(a.token, intent.tokenIn))
  if (!assetIn) return null
  const pre = valuate(snapshot.assets)
  const inIndex = snapshot.assets.indexOf(assetIn)
  const deficit = deficitValue(pre, assetIn.targetBps, inIndex)
  let hi = amountOf(deficit, assetIn.decimals, assetIn.priceWad, 'floor')
  let lo = 0n
  let best: FillSimulation | null = null
  while (lo < hi) {
    const mid = (lo + hi + 1n) / 2n
    const sim = simulateFill(snapshot, intent, limits, mid, nowSeconds)
    if (sim.ok && sim.amountOut <= aquaBalanceOut) {
      best = sim
      lo = mid
    } else if (sim.failure === 'BucketZeroAmount') {
      lo = mid
    } else if (
      sim.failure === 'BucketExecutionLimitExceeded' ||
      sim.failure === 'BucketHourlyLimitExceeded' ||
      sim.failure === 'BucketDailyLimitExceeded' ||
      sim.failure === 'BucketTurnoverLimitExceeded' ||
      sim.failure === 'BucketTargetOvershoot' ||
      sim.failure === 'BucketIntentBudgetExceeded' ||
      sim.failure === 'PostStateNotImproved' ||
      sim.failure === 'PostStateOutOfBand' ||
      (sim.ok && sim.amountOut > aquaBalanceOut)
    ) {
      hi = mid - 1n
    } else {
      // Size-independent failure: no amount can fill.
      return null
    }
  }
  return best
}
