import {
  Permission,
  computeBucketId,
  hasPermissions,
  labelId,
  type AssetConfig,
  IntentKind,
  type BucketSnapshot,
  type Capability,
  type EffectiveLimits,
  type ExecutionReceipt,
  type Intent,
  type PolicyParams,
} from '@bucket/protocol-types'
import {
  diagnoseUnfillable,
  isOutOfPolicy,
  maxFillAmountIn,
  planRebalance,
  quoteExactOut,
  simulateFill,
  valuate,
  verifyBucketOrder,
  type FillSimulation,
  type RebalancePlan,
  type Valuation,
} from '@bucket/vm'
import { erc20Abi, isAddressEqual, zeroHash, type Address, type Hash, type Hex } from 'viem'

import { EnsV2 } from './ens/ensv2'
import { BucketEvm, type EvmWallet, type OpenedIntent } from './evm/client'

export interface AllocationRow {
  readonly index: number
  readonly symbol: string
  readonly token: Address
  readonly decimals: number
  readonly balance: bigint
  readonly priceWad: bigint
  readonly valueWad: bigint
  readonly weightWad: bigint
  readonly targetBps: number
  readonly minBps: number
  readonly maxBps: number
  readonly deviationWad: bigint
}

export interface BucketAllocation {
  readonly totalValueWad: bigint
  readonly rows: readonly AllocationRow[]
  readonly maxAbsDeviationWad: bigint
  readonly outOfPolicy: boolean
  readonly valuation: Valuation
}

export interface BucketView {
  readonly bucketId: Hex
  readonly ensName: string
  readonly owner: Address
  readonly snapshot: BucketSnapshot
  readonly allocation: BucketAllocation
  readonly plan: RebalancePlan | null
  readonly activeIntent: OpenedIntent | null
}

export type RebalanceStage = 'capability-check' | 'policy-check' | 'open-intent' | 'quote-verify' | 'execution' | 'post-state'

export interface StageUpdate {
  readonly stage: RebalanceStage
  readonly status: 'running' | 'done' | 'skipped'
  readonly detail?: string
  readonly txHash?: Hash
}

export interface RebalanceExecution {
  readonly openTx: Hash | null
  readonly intentId: Hex
  readonly fillTx: Hash
  /** Pre-trade simulation (sizing and the taker's minAmountOut); the auction concession grows until inclusion. */
  readonly fill: FillSimulation
  /** The controller's on-chain receipt: the executed amounts. */
  readonly receipt: ExecutionReceipt
}

export interface SwapPreview {
  readonly snapshot: BucketSnapshot
  readonly limits: EffectiveLimits
  readonly capability: Capability
  /** Exact simulation of the fill (amounts, USD value, failure mirroring the on-chain error name). */
  readonly fill: FillSimulation
  readonly now: bigint
}

export interface SwapExecution {
  readonly openTx: Hash
  readonly intentId: Hex
  readonly fillTx: Hash
  /** Pre-trade simulation; the executed amounts are in `receipt`. */
  readonly fill: FillSimulation
  readonly receipt: ExecutionReceipt
}

export class BucketClientError extends Error {
  override name = 'BucketClientError'
}

/**
 * High-level EVM Bucket API. Every read is taken from chain state; nothing is cached across calls.
 *
 *   WHO   ENSv2               owner = live owner of the Bucket name; guardians resolved through the same registry
 *   WHAT  BucketCapabilities  a Financial Capability defines what an operator may do (see @bucket/protocol-types)
 *   HOW    Aqua + SwapVM       the Bucket program (0xd0 guard, 0xd1 quote, 0xd2 spend limit) enforces it per fill
 *
 * For the Sui-native stack (independent capabilities, native payments, no price feed), see `SuiBucketClient`.
 */
export class BucketClient {
  constructor(
    readonly evm: BucketEvm,
    readonly ens: EnsV2,
    readonly chainId: number,
  ) {}

  // ---------------------------------------------------------------------------------------------- create

  async createBucket(input: {
    wallet: EvmWallet
    /** ENSv2 registry that holds the Bucket label, e.g. the subregistry of `shlok.eth`. */
    registry: Address
    label: string
    suiObjectId?: Hex
    strategyExpiry: number
    params: PolicyParams
    assets: readonly AssetConfig[]
  }): Promise<{ bucketId: Hex; evmTx: Hash }> {
    const name = await this.ens.locate(input.registry, input.label)
    if (!isAddressEqual(name.owner, input.wallet.account.address)) {
      throw new BucketClientError(`${name.name} is owned by ${name.owner}, not ${input.wallet.account.address}`)
    }
    const bucketId = computeBucketId(this.chainId, this.evm.contracts.controller, input.registry, input.label)
    const onChainId = await this.evm.computeBucketId(input.registry, labelId(input.label))
    if (onChainId !== bucketId) throw new BucketClientError('bucketId derivation mismatch with controller')

    const created = await this.evm.createBucket(input.wallet, {
      registry: input.registry,
      label: input.label,
      suiObjectId: input.suiObjectId ?? zeroHash,
      strategyExpiry: input.strategyExpiry,
      params: input.params,
      assets: input.assets,
    })
    return { bucketId, evmTx: created.hash }
  }

  // ---------------------------------------------------------------------------------------------- read

  async getBucket(bucketId: Hex): Promise<BucketView> {
    const [snapshot, meta, owner, name] = await Promise.all([
      this.evm.loadBucket(bucketId),
      this.evm.getBucket(bucketId),
      this.evm.ownerOf(bucketId),
      this.evm.nameOf(bucketId),
    ])
    const ensName = await this.ens.fullName(name.registry, name.label)
    const allocation = this.allocationOf(snapshot, await this.symbols(snapshot))

    let plan: RebalancePlan | null = null
    let activeIntent: OpenedIntent | null = null
    if (snapshot.activeIntent !== zeroHash) {
      const intent = await this.evm.getIntent(snapshot.activeIntent)
      activeIntent = { intentId: snapshot.activeIntent, intent }
    } else {
      const now = await this.evm.blockTimestamp()
      // A plan without a capability context is informational only (no effective limits applied).
      plan = planRebalance(snapshot, unboundedLimits(), 0xff, now)
    }

    return { bucketId, ensName, owner, snapshot, allocation, plan, activeIntent }
  }

  async getBucketAllocation(bucketId: Hex): Promise<BucketAllocation> {
    const snapshot = await this.evm.loadBucket(bucketId)
    return this.allocationOf(snapshot, await this.symbols(snapshot))
  }

  // ---------------------------------------------------------------------------------------------- rebalance

  /**
   * Full execution path: capability check -> policy check -> open intent -> SwapVM program verification -> exact
   * fill -> post-state check. `onStage` receives progress for UIs.
   */
  async executeRebalance(input: {
    bucketId: Hex
    capabilityId: Hex
    /** Operator wallet: must be the capability's live operator, holding `PERM_REBALANCE`. */
    wallet: EvmWallet
    reuseActiveIntent?: boolean
    onStage?: (update: StageUpdate) => void
  }): Promise<RebalanceExecution> {
    const emit = input.onStage ?? (() => undefined)
    const operator = input.wallet.account.address

    emit({ stage: 'capability-check', status: 'running' })
    const capability = await this.evm.getCapability(input.capabilityId)
    if (!isAddressEqual(capability.operator, operator)) {
      throw new BucketClientError(`${operator} is not the operator of capability ${input.capabilityId}`)
    }
    if (!hasPermissions(capability.permissions, Permission.Rebalance)) {
      throw new BucketClientError(`capability ${input.capabilityId} lacks REBALANCE`)
    }
    emit({ stage: 'capability-check', status: 'done', detail: `capability ${input.capabilityId}` })

    emit({ stage: 'policy-check', status: 'running' })
    let snapshot = await this.evm.loadBucket(input.bucketId)
    const now = await this.evm.blockTimestamp()
    const limits = await this.evm.effectiveLimits(input.bucketId, input.capabilityId)
    const plan = planRebalance(snapshot, limits, capability.assetMask, now)
    if (!plan.required) throw new BucketClientError(`Bucket is within policy or limits exhausted (${plan.reason})`)
    emit({ stage: 'policy-check', status: 'done', detail: `max deviation ${plan.valuation.maxAbsDeviationWad}` })

    emit({ stage: 'open-intent', status: 'running' })
    const planTokenOut = snapshot.assets[plan.outIndex]?.token
    const planTokenIn = snapshot.assets[plan.inIndex]?.token
    let opened: OpenedIntent | null = null
    let openTx: Hash | null = null
    if (snapshot.activeIntent !== zeroHash) {
      // The bucket has at most one open intent (controller invariant C3), so a leftover intent occupies
      // the slot. Only reuse it when the caller opted in AND it is a live rebalance in this exact
      // direction; otherwise (expired, a swap/pay intent, or the wrong leg) cancel it and open fresh —
      // reusing a stale or mismatched intent is why a rebalance can report "no fillable amount".
      const existingIntent = await this.evm.getIntent(snapshot.activeIntent)
      const currentTime = Number(await this.evm.blockTimestamp())
      const reusable =
        !!input.reuseActiveIntent &&
        existingIntent.expiresAt > currentTime &&
        existingIntent.kind === IntentKind.Rebalance &&
        !!planTokenOut &&
        !!planTokenIn &&
        isAddressEqual(existingIntent.tokenOut, planTokenOut) &&
        isAddressEqual(existingIntent.tokenIn, planTokenIn)
      if (reusable) {
        opened = { intentId: snapshot.activeIntent, intent: existingIntent }
      } else {
        await this.evm.cancelIntent(input.wallet, input.bucketId)
        snapshot = await this.evm.loadBucket(input.bucketId)
      }
    }
    if (!opened) {
      const result = await this.evm.openRebalanceIntent(input.wallet, input.bucketId, input.capabilityId)
      opened = result.value
      openTx = result.hash
      snapshot = await this.evm.loadBucket(input.bucketId)
    }
    emit({ stage: 'open-intent', status: 'done', ...(openTx ? { txHash: openTx } : {}), detail: opened.intentId })

    emit({ stage: 'quote-verify', status: 'running' })
    const { order, orderHash } = await this.evm.strategyOrder(input.bucketId, opened.intent.tokenOut, opened.intent.tokenIn)
    verifyBucketOrder(order, {
      holder: snapshot.holder,
      controller: this.evm.contracts.controller,
      bucketId: input.bucketId,
      strategyNonce: (await this.evm.getBucket(input.bucketId)).strategyNonce,
      strategyExpiry: (await this.evm.getBucket(input.bucketId)).strategyExpiry,
    })
    const aqua = await this.evm.aquaBalance(snapshot.holder, orderHash, opened.intent.tokenOut)
    const fillNow = await this.evm.blockTimestamp()
    // Apply 0.1% safety margin on value caps so the binary search never lands exactly at the on-chain
    // limit — a few seconds of additional auction discount at fill time would otherwise cause BucketExecutionLimitExceeded.
    const conservativeLimits = {
      ...limits,
      maxExecutionValue: limits.maxExecutionValue * 999n / 1000n,
      remainingHourlyValue: limits.remainingHourlyValue * 999n / 1000n,
      remainingDailyValue: limits.remainingDailyValue * 999n / 1000n,
      remainingTurnoverValue: limits.remainingTurnoverValue * 999n / 1000n,
    }
    // Also cap at 99.9% of the intent's remaining budget so the binary search never lands exactly at
    // remainingOut — mining delay grows the auction discount, causing on-chain amountOut to exceed it.
    const intentBudgetCap = opened.intent.remainingOut * 999n / 1000n
    const aquaCap = aqua.balance < intentBudgetCap ? aqua.balance : intentBudgetCap
    const sized = maxFillAmountIn(snapshot, opened.intent, conservativeLimits, aquaCap, fillNow)
    if (!sized) {
      throw new BucketClientError(
        `no fillable amount under the current policy/limits — ${diagnoseUnfillable(snapshot, opened.intent, conservativeLimits, aquaCap, fillNow)}`,
      )
    }
    const fill = simulateFill(snapshot, opened.intent, limits, sized.amountIn, fillNow + 1n)
    if (!fill.ok) throw new BucketClientError(`fill rejected by policy: ${fill.failure}`)
    emit({ stage: 'quote-verify', status: 'done', detail: `program verified; amountIn=${fill.amountIn}` })

    emit({ stage: 'execution', status: 'running' })
    const balanceIn = await this.evm.publicClient.readContract({
      address: opened.intent.tokenIn,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [operator],
    })
    if (balanceIn < fill.amountIn) {
      throw new BucketClientError(`executor holds ${balanceIn} of ${opened.intent.tokenIn}, needs ${fill.amountIn}`)
    }
    const executed = await this.evm.fillIntent(input.wallet, {
      order,
      intent: opened.intent,
      amountIn: fill.amountIn,
      minAmountOut: fill.amountOut,
    })
    emit({ stage: 'execution', status: 'done', txHash: executed.hash })

    emit({ stage: 'post-state', status: 'running' })
    if (executed.value.receipt.postMaxDeviationWad > executed.value.receipt.preMaxDeviationWad) {
      throw new BucketClientError('controller accepted a worsening execution')
    }
    emit({
      stage: 'post-state',
      status: 'done',
      detail: `max deviation ${executed.value.receipt.preMaxDeviationWad} -> ${executed.value.receipt.postMaxDeviationWad}`,
    })

    return { openTx, intentId: opened.intentId, fillTx: executed.hash, fill, receipt: executed.value.receipt }
  }

  // ---------------------------------------------------------------------------------------------- swap

  /**
   * Read-only quote + policy check of an operator-directed swap in which the holder sells `amountOut` of `tokenOut`
   * for `tokenIn`, evaluated exactly as `BucketQuote` + `BucketSpendLimit` + the SWAP post-state band check would
   * for an intent opened now under `capabilityId`. Nothing is submitted.
   */
  async previewSwap(input: {
    bucketId: Hex
    capabilityId: Hex
    tokenOut: Address
    tokenIn: Address
    amountOut: bigint
  }): Promise<SwapPreview> {
    const [snapshot, limits, capability, now] = await Promise.all([
      this.evm.loadBucket(input.bucketId),
      this.evm.effectiveLimits(input.bucketId, input.capabilityId),
      this.evm.getCapability(input.capabilityId),
      this.evm.blockTimestamp(),
    ])
    const intent = this.hypotheticalSwapIntent(input, capability.operator, Number(now), snapshot.policyVersion)
    const amountIn = this.swapAmountIn(snapshot, intent, input.amountOut, limits.maxSlippageBps)
    const fill = simulateFill(snapshot, intent, limits, amountIn, now)
    return { snapshot, limits, capability, fill, now }
  }

  /**
   * Full operator-directed swap: capability check -> open SWAP intent -> canonical order + program verification ->
   * exact-in fill through Aqua + SwapVM -> the controller's receipt. The holder's wallet pays `amountOut` of
   * `tokenOut` (at most) and receives `tokenIn`; the operator supplies `tokenIn`.
   */
  async executeSwap(input: {
    bucketId: Hex
    capabilityId: Hex
    /** Operator wallet: must be the capability's live operator, holding `PERM_SWAP`. */
    wallet: EvmWallet
    tokenOut: Address
    tokenIn: Address
    amountOut: bigint
    onStage?: (update: StageUpdate) => void
  }): Promise<SwapExecution> {
    const emit = input.onStage ?? (() => undefined)
    const operator = input.wallet.account.address

    emit({ stage: 'capability-check', status: 'running' })
    const capability = await this.evm.getCapability(input.capabilityId)
    if (!isAddressEqual(capability.operator, operator)) {
      throw new BucketClientError(`${operator} is not the operator of capability ${input.capabilityId}`)
    }
    if (!hasPermissions(capability.permissions, Permission.Swap)) {
      throw new BucketClientError(`capability ${input.capabilityId} lacks SWAP`)
    }
    emit({ stage: 'capability-check', status: 'done', detail: `capability ${input.capabilityId}` })

    emit({ stage: 'policy-check', status: 'running' })
    const preview = await this.previewSwap(input)
    if (!preview.fill.ok) throw new BucketClientError(`swap rejected by policy: ${preview.fill.failure}`)
    emit({ stage: 'policy-check', status: 'done', detail: `value ${preview.fill.valueOut}` })

    emit({ stage: 'open-intent', status: 'running' })
    // A bucket has at most one open intent (controller invariant C3). Clear any leftover intent first,
    // otherwise openSwapIntent reverts and later runs report a stale intent as unfillable.
    const preSwap = await this.evm.loadBucket(input.bucketId)
    if (preSwap.activeIntent !== zeroHash) {
      await this.evm.cancelIntent(input.wallet, input.bucketId)
    }
    const opened = await this.evm.openSwapIntent(
      input.wallet,
      input.bucketId,
      input.capabilityId,
      input.tokenOut,
      input.tokenIn,
      input.amountOut,
    )
    emit({ stage: 'open-intent', status: 'done', txHash: opened.hash, detail: opened.value.intentId })

    emit({ stage: 'quote-verify', status: 'running' })
    const snapshot = await this.evm.loadBucket(input.bucketId)
    const meta = await this.evm.getBucket(input.bucketId)
    const { order } = await this.evm.strategyOrder(input.bucketId, input.tokenOut, input.tokenIn)
    verifyBucketOrder(order, {
      holder: snapshot.holder,
      controller: this.evm.contracts.controller,
      bucketId: input.bucketId,
      strategyNonce: meta.strategyNonce,
      strategyExpiry: meta.strategyExpiry,
    })
    const limits = await this.evm.effectiveLimits(input.bucketId, input.capabilityId)
    const fillNow = (await this.evm.blockTimestamp()) + 1n
    const intent = opened.value.intent
    const amountIn = this.swapAmountIn(snapshot, intent, intent.remainingOut, limits.maxSlippageBps)
    const fill = simulateFill(snapshot, intent, limits, amountIn, fillNow)
    if (!fill.ok) throw new BucketClientError(`fill rejected by policy: ${fill.failure}`)
    emit({ stage: 'quote-verify', status: 'done', detail: `program verified; amountIn=${fill.amountIn}` })

    emit({ stage: 'execution', status: 'running' })
    const executed = await this.evm.fillIntent(input.wallet, {
      order,
      intent,
      amountIn: fill.amountIn,
      minAmountOut: fill.amountOut,
    })
    emit({ stage: 'execution', status: 'done', txHash: executed.hash })
    emit({ stage: 'post-state', status: 'done', detail: 'both assets inside their hard bands' })
    return { openTx: opened.hash, intentId: opened.value.intentId, fillTx: executed.hash, fill, receipt: executed.value.receipt }
  }

  private hypotheticalSwapIntent(
    input: { bucketId: Hex; capabilityId: Hex; tokenOut: Address; tokenIn: Address; amountOut: bigint },
    operator: Address,
    now: number,
    policyVersion: number,
  ): Intent {
    return {
      bucketId: input.bucketId,
      capabilityId: input.capabilityId,
      operator,
      kind: IntentKind.Swap,
      tokenOut: input.tokenOut,
      tokenIn: input.tokenIn,
      remainingOut: input.amountOut,
      openedAt: now,
      expiresAt: now,
      policyVersion,
      nonce: 0n,
    }
  }

  /** Exact-in amount sized at the largest auction concession the capability chain allows, so the output never
   *  exceeds `budgetOut` however far the concession has grown by inclusion (the intent budget is a hard cap). */
  private swapAmountIn(snapshot: BucketSnapshot, intent: Intent, budgetOut: bigint, maxSlippageBps: number): bigint {
    const assetOut = snapshot.assets.find((a) => isAddressEqual(a.token, intent.tokenOut))
    const assetIn = snapshot.assets.find((a) => isAddressEqual(a.token, intent.tokenIn))
    if (!assetOut || !assetIn) throw new BucketClientError('token is not a policy asset of this Bucket')
    return quoteExactOut((budgetOut * 999n) / 1000n, assetIn, assetOut, BigInt(maxSlippageBps))
  }

  // ---------------------------------------------------------------------------------------------- helpers

  allocationOf(snapshot: BucketSnapshot, symbols: readonly string[]): BucketAllocation {
    const valuation = valuate(snapshot.assets)
    const rows = snapshot.assets.map((asset, index) => ({
      index,
      symbol: symbols[index] ?? asset.token,
      token: asset.token,
      decimals: asset.decimals,
      balance: asset.balance,
      priceWad: asset.priceWad,
      valueWad: valuation.values[index] ?? 0n,
      weightWad: valuation.weightsWad[index] ?? 0n,
      targetBps: asset.targetBps,
      minBps: asset.minBps,
      maxBps: asset.maxBps,
      deviationWad: valuation.deviationsWad[index] ?? 0n,
    }))
    return {
      totalValueWad: valuation.totalValue,
      rows,
      maxAbsDeviationWad: valuation.maxAbsDeviationWad,
      outOfPolicy: isOutOfPolicy(snapshot.assets, snapshot.params, valuation),
      valuation,
    }
  }

  private async symbols(snapshot: BucketSnapshot): Promise<string[]> {
    return Promise.all(
      snapshot.assets.map((asset) =>
        this.evm.publicClient
          .readContract({ address: asset.token, abi: erc20Abi, functionName: 'symbol' })
          .catch(() => asset.token),
      ),
    )
  }
}

/** Unbounded limits, for display-only planning before a capability is chosen. */
function unboundedLimits() {
  return {
    maxExecutionValue: (1n << 128n) - 1n,
    remainingHourlyValue: (1n << 128n) - 1n,
    remainingDailyValue: (1n << 128n) - 1n,
    remainingTurnoverValue: (1n << 128n) - 1n,
    maxSlippageBps: 1_000,
  }
}

export { BucketStatus } from '@bucket/protocol-types'
export * from './sui-client'
