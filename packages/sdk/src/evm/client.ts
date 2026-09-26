import type {
  AssetConfig,
  BucketSnapshot,
  Capability,
  CapabilityGrant,
  EffectiveLimits,
  ExecutionFrame,
  ExecutionReceipt,
  Intent,
  PolicyParams,
  SwapVmOrder,
} from '@bucket/protocol-types'
import { buildTakerTraits } from '@bucket/vm'
import {
  erc20Abi,
  getAddress,
  isAddressEqual,
  maxUint256,
  parseEventLogs,
  type Account,
  type Address,
  type Chain,
  type Hash,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
} from 'viem'

import {
  aquaAbi,
  bucketAuthorityAbi,
  bucketCapabilitiesAbi,
  bucketControllerAbi,
  bucketPriceFeedAbi,
  bucketSwapVmRouterAbi,
} from '../abi/generated'
import { rethrowDecoded } from './errors'
import {
  toAssetConfig,
  toCapability,
  toEffectiveLimits,
  toIntent,
  toMeta,
  toOrder,
  toParams,
  toReceipt,
  toSnapshot,
} from './normalize'

export interface BucketEvmContracts {
  readonly aqua: Address
  readonly router: Address
  readonly authority: Address
  readonly capabilities: Address
  readonly controller: Address
  readonly priceFeed: Address
}

export type EvmWallet = WalletClient<Transport, Chain, Account>

export interface EvmTxResult<T = undefined> {
  readonly hash: Hash
  readonly receipt: TransactionReceipt
  readonly value: T
}

export interface OpenedIntent {
  readonly intentId: Hex
  readonly intent: Intent
}

/**
 * Typed access to the BUCKET EVM execution layer: `BucketController` (policy, strategy generations, intents,
 * payments), `BucketCapabilities` (issuance, delegation, revocation, limits) and `BucketAuthority` (ENSv2 owner /
 * guardian resolution). Reads use the public client; writes are simulated first so a policy or capability
 * violation surfaces as a decoded protocol error before any transaction is sent.
 */
export class BucketEvm {
  constructor(
    readonly publicClient: PublicClient,
    readonly contracts: BucketEvmContracts,
    /** First block to scan for Bucket events (deployment block). */
    readonly fromBlock: bigint = 0n,
  ) {}

  // ------------------------------------------------------------------------------------------------ controller reads

  async loadBucket(bucketId: Hex): Promise<BucketSnapshot> {
    const raw = await this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'loadBucket',
      args: [bucketId],
    })
    return toSnapshot(raw)
  }

  async getBucket(bucketId: Hex) {
    const raw = await this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'getBucket',
      args: [bucketId],
    })
    return toMeta(raw)
  }

  async getPolicy(bucketId: Hex): Promise<{ params: PolicyParams; assets: AssetConfig[] }> {
    const [params, assets] = await this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'getPolicy',
      args: [bucketId],
    })
    return { params: toParams(params), assets: assets.map(toAssetConfig) }
  }

  async getIntent(intentId: Hex): Promise<Intent> {
    const raw = await this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'getIntent',
      args: [intentId],
    })
    return toIntent(raw)
  }

  /** Everything a Bucket SwapVM instruction needs to decide a fill of `orderHash` in `tokenIn -> tokenOut`. */
  async loadFrame(bucketId: Hex, orderHash: Hex, tokenIn: Address, tokenOut: Address): Promise<ExecutionFrame> {
    const raw = await this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'loadFrame',
      args: [bucketId, orderHash, tokenIn, tokenOut],
    })
    return {
      bucket: toSnapshot(raw.bucket),
      intent: toIntent(raw.intent),
      limits: toEffectiveLimits(raw.limits),
      strategyActive: raw.strategyActive,
    }
  }

  async effectiveLimits(bucketId: Hex, capabilityId: Hex): Promise<EffectiveLimits> {
    const raw = await this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'effectiveLimits',
      args: [bucketId, capabilityId],
    })
    return toEffectiveLimits(raw)
  }

  async computeBucketId(registry: Address, labelId: bigint): Promise<Hex> {
    return this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'computeBucketId',
      args: [registry, labelId],
    })
  }

  async strategyOrder(bucketId: Hex, tokenX: Address, tokenY: Address): Promise<{ order: SwapVmOrder; orderHash: Hex }> {
    const [order, orderHash] = await this.publicClient.readContract({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'strategyOrder',
      args: [bucketId, tokenX, tokenY],
    })
    return { order: toOrder(order), orderHash }
  }

  // ------------------------------------------------------------------------------------------------ authority reads

  async ownerOf(bucketId: Hex): Promise<Address> {
    return this.publicClient.readContract({
      address: this.contracts.authority,
      abi: bucketAuthorityAbi,
      functionName: 'ownerOf',
      args: [bucketId],
    })
  }

  async nameOf(bucketId: Hex): Promise<{ registry: Address; labelId: bigint; label: string }> {
    const raw = await this.publicClient.readContract({
      address: this.contracts.authority,
      abi: bucketAuthorityAbi,
      functionName: 'nameOf',
      args: [bucketId],
    })
    return { registry: getAddress(raw.registry), labelId: raw.labelId, label: raw.label }
  }

  async isGuardian(bucketId: Hex, account: Address): Promise<boolean> {
    return this.publicClient.readContract({
      address: this.contracts.authority,
      abi: bucketAuthorityAbi,
      functionName: 'isGuardian',
      args: [bucketId, account],
    })
  }

  // ------------------------------------------------------------------------------------------------ capability reads

  async getCapability(capabilityId: Hex): Promise<Capability> {
    const raw = await this.publicClient.readContract({
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'getCapability',
      args: [capabilityId],
    })
    return toCapability(raw)
  }

  async chainLimits(capabilityId: Hex, totalValue: bigint): Promise<EffectiveLimits> {
    const raw = await this.publicClient.readContract({
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'chainLimits',
      args: [capabilityId, totalValue],
    })
    return toEffectiveLimits(raw)
  }

  async epochOf(bucketId: Hex): Promise<number> {
    return this.publicClient.readContract({
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'epochOf',
      args: [bucketId],
    })
  }

  async nextCapabilityId(bucketId: Hex): Promise<Hex> {
    return this.publicClient.readContract({
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'nextCapabilityId',
      args: [bucketId],
    })
  }

  async capabilitiesOf(bucketId: Hex): Promise<readonly Hex[]> {
    return this.publicClient.readContract({
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'capabilitiesOf',
      args: [bucketId],
    })
  }

  // ------------------------------------------------------------------------------------------------ misc reads

  /** Aqua virtual balance of `token` in a Bucket strategy (maker = holder, app = router). */
  async aquaBalance(holder: Address, strategyHash: Hex, token: Address): Promise<{ balance: bigint; tokensCount: number }> {
    const [balance, tokensCount] = await this.publicClient.readContract({
      address: this.contracts.aqua,
      abi: aquaAbi,
      functionName: 'rawBalances',
      args: [holder, this.contracts.router, strategyHash, token],
    })
    return { balance, tokensCount }
  }

  /** Ship the canonical Bucket strategy to Aqua so rawBalances is non-zero and pull/push work. */
  async shipAqua(wallet: EvmWallet, program: Hex, tokens: Address[], amounts: bigint[]): Promise<Hash> {
    const receipt = await this.write(wallet, {
      address: this.contracts.aqua,
      abi: aquaAbi,
      functionName: 'ship',
      args: [this.contracts.router, program, tokens, amounts],
    })
    return receipt.transactionHash
  }

  async price(token: Address): Promise<{ priceWad: bigint; updatedAt: bigint }> {
    const [priceWad, updatedAt] = await this.publicClient.readContract({
      address: this.contracts.priceFeed,
      abi: bucketPriceFeedAbi,
      functionName: 'priceOf',
      args: [token],
    })
    return { priceWad, updatedAt }
  }

  async blockTimestamp(): Promise<bigint> {
    const block = await this.publicClient.getBlock({ blockTag: 'latest' })
    return block.timestamp
  }

  async executions(bucketId: Hex): Promise<Array<{ receipt: ExecutionReceipt; txHash: Hash; blockNumber: bigint }>> {
    const logs = await this.publicClient.getContractEvents({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      eventName: 'ExecutionRecorded',
      args: { bucketId },
      fromBlock: this.fromBlock,
    })
    return logs.map((log) => ({
      receipt: toReceipt(log.args.receipt as Parameters<typeof toReceipt>[0]),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    }))
  }

  async intentsOpened(bucketId: Hex): Promise<Array<{ intentId: Hex; intent: Intent; txHash: Hash; blockNumber: bigint }>> {
    const logs = await this.publicClient.getContractEvents({
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      eventName: 'IntentOpened',
      args: { bucketId },
      fromBlock: this.fromBlock,
    })
    return logs.map((log) => ({
      intentId: log.args.intentId as Hex,
      intent: toIntent(log.args.intent as Parameters<typeof toIntent>[0]),
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
    }))
  }

  // ------------------------------------------------------------------------------------------------ controller writes

  async createBucket(
    wallet: EvmWallet,
    input: {
      registry: Address
      label: string
      suiObjectId: Hex
      strategyExpiry: number
      params: PolicyParams
      assets: readonly AssetConfig[]
    },
  ): Promise<EvmTxResult<{ bucketId: Hex }>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'createBucket',
      args: [
        {
          registry: input.registry,
          label: input.label,
          suiObjectId: input.suiObjectId,
          strategyExpiry: input.strategyExpiry,
          params: input.params,
          assets: input.assets.map(toAssetConfig),
        },
      ],
    })
    const [created] = parseEventLogs({ abi: bucketControllerAbi, eventName: 'BucketCreated', logs: receipt.logs })
    if (!created) throw new Error('BucketCreated event missing')
    return { hash: receipt.transactionHash, receipt, value: { bucketId: created.args.bucketId } }
  }

  async updatePolicy(wallet: EvmWallet, bucketId: Hex, params: PolicyParams, assets: readonly AssetConfig[]) {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'updatePolicy',
      args: [bucketId, params, assets.map(toAssetConfig)],
    })
    const [updated] = parseEventLogs({ abi: bucketControllerAbi, eventName: 'BucketPolicyUpdated', logs: receipt.logs })
    return {
      hash: receipt.transactionHash,
      receipt,
      value: { policyVersion: updated?.args.policyVersion, policyHash: updated?.args.policyHash },
    }
  }

  async setStatus(wallet: EvmWallet, bucketId: Hex, status: number): Promise<EvmTxResult> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'setStatus',
      args: [bucketId, status],
    })
    return { hash: receipt.transactionHash, receipt, value: undefined }
  }

  /** Emergency pause: the holder, the ENSv2 owner or a guardian. */
  async pause(wallet: EvmWallet, bucketId: Hex): Promise<EvmTxResult> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'pause',
      args: [bucketId],
    })
    return { hash: receipt.transactionHash, receipt, value: undefined }
  }

  async rotateStrategies(wallet: EvmWallet, bucketId: Hex, strategyExpiry: number): Promise<EvmTxResult> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'rotateStrategies',
      args: [bucketId, strategyExpiry],
    })
    return { hash: receipt.transactionHash, receipt, value: undefined }
  }

  /** Opens the policy-computed rebalance intent under a capability holding `PERM_REBALANCE`. */
  async openRebalanceIntent(wallet: EvmWallet, bucketId: Hex, capabilityId: Hex): Promise<EvmTxResult<OpenedIntent>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'openRebalanceIntent',
      args: [bucketId, capabilityId],
    })
    return this.intentResult(receipt)
  }

  /** Opens an operator-directed swap intent under a capability holding `PERM_SWAP`. */
  async openSwapIntent(
    wallet: EvmWallet,
    bucketId: Hex,
    capabilityId: Hex,
    tokenOut: Address,
    tokenIn: Address,
    amountOut: bigint,
  ): Promise<EvmTxResult<OpenedIntent>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'openSwapIntent',
      args: [bucketId, capabilityId, tokenOut, tokenIn, amountOut],
    })
    return this.intentResult(receipt)
  }

  async cancelIntent(wallet: EvmWallet, bucketId: Hex): Promise<EvmTxResult> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'cancelIntent',
      args: [bucketId],
    })
    return { hash: receipt.transactionHash, receipt, value: undefined }
  }

  /** Pays `amount` of `token` from the holder's wallet to the capability's fixed payee (`PERM_PAY`). */
  async pay(wallet: EvmWallet, bucketId: Hex, capabilityId: Hex, token: Address, amount: bigint): Promise<EvmTxResult<{ receiptHash: Hex }>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.controller,
      abi: bucketControllerAbi,
      functionName: 'pay',
      args: [bucketId, capabilityId, token, amount],
    })
    const [event] = parseEventLogs({ abi: bucketControllerAbi, eventName: 'ExecutionRecorded', logs: receipt.logs })
    return { hash: receipt.transactionHash, receipt, value: { receiptHash: event?.args.receiptHash ?? ('0x' as Hex) } }
  }

  /**
   * Fills a Bucket intent through the Bucket SwapVM router (requires the capability's `PERM_REBALANCE`/`PERM_SWAP`,
   * checked live by opcode 0xd0). The taker pays `tokenIn` with `transferFrom + Aqua push` and receives `tokenOut`
   * via Aqua `pull` from the holder's wallet.
   */
  async fillIntent(
    wallet: EvmWallet,
    input: { order: SwapVmOrder; intent: Intent; amountIn: bigint; minAmountOut: bigint; deadline?: number },
  ): Promise<EvmTxResult<{ executionNonce: bigint; receiptHash: Hex; receipt: ExecutionReceipt }>> {
    const taker = wallet.account.address
    const { tokenA } = sortTokens(input.intent.tokenOut, input.intent.tokenIn)
    const takerData = buildTakerTraits({
      taker,
      isExactIn: true,
      isAToB: isAddressEqual(input.intent.tokenIn, tokenA),
      threshold: input.minAmountOut,
      useTransferFromAndAquaPush: true,
      ...(input.deadline !== undefined ? { deadline: input.deadline } : {}),
    })
    await this.ensureAllowance(wallet, input.intent.tokenIn, this.contracts.router, input.amountIn)
    const receipt = await this.write(wallet, {
      address: this.contracts.router,
      abi: bucketSwapVmRouterAbi,
      functionName: 'swap',
      args: [input.order, input.amountIn, takerData],
    })
    const [executed] = parseEventLogs({ abi: bucketControllerAbi, eventName: 'ExecutionRecorded', logs: receipt.logs })
    if (!executed) throw new Error('ExecutionRecorded event missing')
    return {
      hash: receipt.transactionHash,
      receipt,
      value: {
        executionNonce: executed.args.executionNonce,
        receiptHash: executed.args.receiptHash,
        receipt: toReceipt(executed.args.receipt as Parameters<typeof toReceipt>[0]),
      },
    }
  }

  // ------------------------------------------------------------------------------------------------ capability writes

  async issueCapability(wallet: EvmWallet, bucketId: Hex, grant: CapabilityGrant): Promise<EvmTxResult<{ capabilityId: Hex }>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'issue',
      args: [bucketId, grant],
    })
    const [event] = parseEventLogs({ abi: bucketCapabilitiesAbi, eventName: 'CapabilityIssued', logs: receipt.logs })
    if (!event) throw new Error('CapabilityIssued event missing')
    return { hash: receipt.transactionHash, receipt, value: { capabilityId: event.args.capabilityId } }
  }

  async delegateCapability(wallet: EvmWallet, parentId: Hex, grant: CapabilityGrant): Promise<EvmTxResult<{ capabilityId: Hex }>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'delegate',
      args: [parentId, grant],
    })
    const [event] = parseEventLogs({ abi: bucketCapabilitiesAbi, eventName: 'CapabilityIssued', logs: receipt.logs })
    if (!event) throw new Error('CapabilityIssued event missing')
    return { hash: receipt.transactionHash, receipt, value: { capabilityId: event.args.capabilityId } }
  }

  async revokeCapability(wallet: EvmWallet, capabilityId: Hex): Promise<EvmTxResult> {
    const receipt = await this.write(wallet, {
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'revoke',
      args: [capabilityId],
    })
    return { hash: receipt.transactionHash, receipt, value: undefined }
  }

  /** Kill switch: invalidates every capability of the Bucket at once. Owner or guardian. */
  async revokeAllCapabilities(wallet: EvmWallet, bucketId: Hex): Promise<EvmTxResult<{ epoch: number }>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.capabilities,
      abi: bucketCapabilitiesAbi,
      functionName: 'revokeAll',
      args: [bucketId],
    })
    const [event] = parseEventLogs({ abi: bucketCapabilitiesAbi, eventName: 'CapabilityEpochAdvanced', logs: receipt.logs })
    return { hash: receipt.transactionHash, receipt, value: { epoch: event?.args.epoch ?? 0 } }
  }

  // ------------------------------------------------------------------------------------------------ authority writes

  async authorizeGuardian(wallet: EvmWallet, bucketId: Hex, label: string): Promise<EvmTxResult<{ guardian: Address }>> {
    const receipt = await this.write(wallet, {
      address: this.contracts.authority,
      abi: bucketAuthorityAbi,
      functionName: 'authorizeGuardian',
      args: [bucketId, label],
    })
    const [event] = parseEventLogs({ abi: bucketAuthorityAbi, eventName: 'GuardianAuthorized', logs: receipt.logs })
    if (!event) throw new Error('GuardianAuthorized event missing')
    return { hash: receipt.transactionHash, receipt, value: { guardian: getAddress(event.args.guardian) } }
  }

  async revokeGuardian(wallet: EvmWallet, bucketId: Hex, guardian: Address): Promise<EvmTxResult> {
    const receipt = await this.write(wallet, {
      address: this.contracts.authority,
      abi: bucketAuthorityAbi,
      functionName: 'revokeGuardian',
      args: [bucketId, guardian],
    })
    return { hash: receipt.transactionHash, receipt, value: undefined }
  }

  // ------------------------------------------------------------------------------------------------ helpers

  async ensureAllowance(wallet: EvmWallet, token: Address, spender: Address, amount: bigint): Promise<void> {
    const owner = wallet.account.address
    const allowance = await this.publicClient.readContract({
      address: token,
      abi: erc20Abi,
      functionName: 'allowance',
      args: [owner, spender],
    })
    if (allowance >= amount) return
    await this.write(wallet, { address: token, abi: erc20Abi, functionName: 'approve', args: [spender, maxUint256] })
  }

  /** Simulate, send, and wait. Reverts are decoded against every Bucket error definition. */
  async write(wallet: EvmWallet, call: Parameters<PublicClient['simulateContract']>[0]): Promise<TransactionReceipt> {
    try {
      const { request } = await this.publicClient.simulateContract({ ...call, account: wallet.account })
      const hash = await wallet.writeContract(request as Parameters<EvmWallet['writeContract']>[0])
      const receipt = await this.publicClient.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
      return receipt
    } catch (error) {
      return rethrowDecoded(error)
    }
  }

  private intentResult(receipt: TransactionReceipt): EvmTxResult<OpenedIntent> {
    const [event] = parseEventLogs({ abi: bucketControllerAbi, eventName: 'IntentOpened', logs: receipt.logs })
    if (!event) throw new Error('IntentOpened event missing')
    return {
      hash: receipt.transactionHash,
      receipt,
      value: { intentId: event.args.intentId, intent: toIntent(event.args.intent as Parameters<typeof toIntent>[0]) },
    }
  }
}

export function sortTokens(a: Address, b: Address): { tokenA: Address; tokenB: Address } {
  return BigInt(a) < BigInt(b) ? { tokenA: getAddress(a), tokenB: getAddress(b) } : { tokenA: getAddress(b), tokenB: getAddress(a) }
}
