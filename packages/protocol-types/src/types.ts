import type { Address, Hex } from 'viem'

import type { BucketStatus, CapabilityStatus, ExecutionKind, IntentKind } from './constants'

/**
 * Integer conventions (mirrors Solidity / Move widths):
 *  - `number` only for values that fit in u32 (bps, decimals, versions, permission masks, timestamps in seconds)
 *  - `bigint` for token amounts, USD values, prices, weights (WAD) and anything u64+
 * No floating point is used anywhere in protocol state.
 */

// ============================================================================================ EVM: policy

/** Per-asset allocation policy (EVM `AssetConfig`). */
export interface AssetConfig {
  readonly token: Address
  readonly decimals: number
  readonly targetBps: number
  readonly minBps: number
  readonly maxBps: number
}

/** Scalar policy parameters (EVM `PolicyParams`). Every capability issued under a Bucket is bounded by these. */
export interface PolicyParams {
  readonly rebalanceThresholdBps: number
  readonly maxSlippageBps: number
  readonly maxPriceAge: number
  readonly auctionDuration: number
  readonly venueMask: number
  readonly maxDailyTurnoverBps: number
  readonly delegablePermissions: number
  /** USD, WAD. */
  readonly maxExecutionValue: bigint
  readonly maxHourlyValue: bigint
  readonly maxDailyValue: bigint
}

export interface BucketPolicy {
  readonly params: PolicyParams
  readonly assets: readonly AssetConfig[]
}

/** Live asset state as seen by the execution layer (EVM `AssetState`). */
export interface AssetState extends AssetConfig {
  readonly balance: bigint
  readonly priceWad: bigint
  readonly priceUpdatedAt: bigint
}

/** EVM `BucketSnapshot`. */
export interface BucketSnapshot {
  readonly bucketId: Hex
  readonly holder: Address
  readonly authority: Address
  readonly capabilities: Address
  readonly status: BucketStatus
  readonly policyVersion: number
  readonly policyHash: Hex
  readonly strategyHash: Hex
  readonly activeIntent: Hex
  readonly params: PolicyParams
  readonly assets: readonly AssetState[]
}

/** Flat bookkeeping read model (EVM `BucketMeta`, `IBucketController.getBucket`). */
export interface BucketMeta {
  readonly holder: Address
  readonly status: BucketStatus
  readonly policyVersion: number
  readonly createdAt: number
  readonly updatedAt: number
  readonly executionNonce: bigint
  readonly intentNonce: bigint
  readonly strategyNonce: number
  readonly strategyExpiry: number
  readonly policyHash: Hex
  readonly strategyHash: Hex
  readonly activeIntent: Hex
  readonly lastReceipt: Hex
  readonly suiObjectId: Hex
  readonly usage: Usage
}

/** Cumulative spend usage in fixed hour/day windows (EVM `Usage`, Sui `capability::Usage`). */
export interface Usage {
  readonly hourWindow: number
  readonly dayWindow: number
  readonly hourValue: bigint
  readonly dayValue: bigint
}

// ============================================================================================ EVM: capabilities

/** Quantitative limits of a capability; a child's are each `<=` its parent's (EVM `CapabilityLimits`). */
export interface CapabilityLimits {
  readonly maxExecutionValue: bigint
  readonly maxHourlyValue: bigint
  readonly maxDailyValue: bigint
  readonly maxSlippageBps: number
  readonly maxDailyTurnoverBps: number
  /** 0 = unlimited lifetime executions. */
  readonly maxExecutions: number
}

/** Owner/operator input describing a capability to issue (EVM `CapabilityGrant`). */
export interface CapabilityGrant {
  /** ENSv2 label of the operator under the issuer's name, e.g. `agent` for `agent.trading.shlok.eth`. */
  readonly operatorLabel: string
  readonly permissions: number
  /** Bit `i` allows policy asset `i`. */
  readonly assetMask: number
  readonly venueMask: number
  readonly validAfter: number
  readonly validUntil: number
  /** Only recipient of `PAY` executions; zero address unless `PERM_PAY` is granted. */
  readonly payee: Address
  readonly limits: CapabilityLimits
}

/** A Financial Capability (EVM `Capability`). */
export interface Capability {
  readonly bucketId: Hex
  readonly parentId: Hex
  readonly issuer: Address
  readonly operator: Address
  readonly operatorRegistry: Address
  readonly depth: number
  readonly status: CapabilityStatus
  readonly permissions: number
  readonly assetMask: number
  readonly venueMask: number
  readonly validAfter: number
  readonly validUntil: number
  readonly issuedAt: number
  readonly policyVersion: number
  readonly epoch: number
  readonly nonce: bigint
  readonly executions: bigint
  readonly payee: Address
  readonly limits: CapabilityLimits
  readonly usage: Usage
  readonly operatorLabel: string
}

/** Tightest bound of the next execution over the policy, Bucket-wide usage and the capability chain (WAD USD). */
export interface EffectiveLimits {
  readonly maxExecutionValue: bigint
  readonly remainingHourlyValue: bigint
  readonly remainingDailyValue: bigint
  readonly remainingTurnoverValue: bigint
  readonly maxSlippageBps: number
}

/** An open financial intent: "fulfil this goal within these constraints" (EVM `Intent`). */
export interface Intent {
  readonly bucketId: Hex
  readonly capabilityId: Hex
  readonly operator: Address
  readonly kind: IntentKind
  readonly tokenOut: Address
  readonly tokenIn: Address
  readonly remainingOut: bigint
  readonly openedAt: number
  readonly expiresAt: number
  readonly policyVersion: number
  readonly nonce: bigint
}

/** Everything the Bucket SwapVM instructions need to decide one fill (EVM `ExecutionFrame`). */
export interface ExecutionFrame {
  readonly bucket: BucketSnapshot
  readonly intent: Intent
  readonly limits: EffectiveLimits
  readonly strategyActive: boolean
}

/** SwapVM order (`ISwapVM.Order`). */
export interface SwapVmOrder {
  readonly maker: Address
  readonly traits: bigint
  readonly data: Hex
}

/** Structured, verifiable evidence of one execution (EVM `ExecutionReceipt`). */
export interface ExecutionReceipt {
  readonly bucketId: Hex
  readonly executionNonce: bigint
  readonly kind: ExecutionKind
  readonly capabilityId: Hex
  readonly intentId: Hex
  readonly orderHash: Hex
  readonly operator: Address
  readonly policyVersion: number
  readonly policyHash: Hex
  readonly strategyHash: Hex
  readonly tokenOut: Address
  readonly tokenIn: Address
  readonly amountOut: bigint
  readonly amountIn: bigint
  readonly valueOut: bigint
  readonly recipient: Address
  readonly preBalances: readonly bigint[]
  readonly postBalances: readonly bigint[]
  readonly pricesWad: readonly bigint[]
  readonly preTotalValue: bigint
  readonly postTotalValue: bigint
  readonly preMaxDeviationWad: bigint
  readonly postMaxDeviationWad: bigint
  readonly preStateHash: Hex
  readonly postStateHash: Hex
  readonly timestamp: number
}

// ============================================================================================ Sui-native

/** Sui-native asset policy entry (`bucket::policy::AssetPolicy`): a Move coin type and its target weight. */
export interface SuiAssetPolicy {
  /** Fully qualified Move coin type, e.g. `0x2::sui::SUI`. */
  readonly coinType: string
  readonly targetBps: number
}

/** Sui-native Bucket policy (`bucket::policy::Policy`): a payment/settlement policy, no price feed involved. */
export interface SuiPolicy {
  readonly version: number
  readonly maxPerTx: bigint
  readonly maxHourlySpend: bigint
  readonly maxDailySpend: bigint
  readonly maxDailyTurnoverBps: number
  readonly delegablePermissions: number
  readonly assets: readonly SuiAssetPolicy[]
}

/** Sui-native capability limits (`bucket::capability::Limits`). */
export interface SuiCapabilityLimits {
  readonly maxPerTx: bigint
  readonly maxHourlySpend: bigint
  readonly maxDailySpend: bigint
  readonly maxDailyTurnoverBps: number
  readonly maxExecutions: number
}

/** Sui-native capability (`bucket::capability::Capability`), decoded from its BCS-encoded `Grant` + live state. */
export interface SuiCapability {
  readonly capabilityId: Hex
  readonly parentId: Hex
  readonly issuer: string
  readonly operator: string
  readonly operatorName: string
  readonly depth: number
  readonly permissions: number
  readonly assetMask: number
  readonly validAfter: number
  readonly validUntil: number
  readonly policyVersion: number
  readonly epoch: number
  readonly nonce: bigint
  readonly payee: string
  readonly limits: SuiCapabilityLimits
  readonly status: CapabilityStatus
  readonly executions: bigint
  readonly usage: Usage
  readonly capabilityHash: Hex
  readonly issuedAtMs: bigint
}

/** Optional, attribution-only association with an independently governed EVM twin (`bucket::bucket::EvmBinding`). */
export interface SuiEvmBinding {
  readonly chainId: number
  readonly controller: Address
  readonly bucketId: Hex
  readonly holder: Address
}

/** A receiving Bucket's inbound-payment policy (`bucket::bucket::ReceivingPolicy`). */
export interface SuiReceivingPolicy {
  readonly acceptedSenders: readonly string[] | null
  readonly minAmount: bigint
  readonly maxAmount: bigint
}

/** Decoded state of the Sui-native `Bucket` object. */
export interface SuiBucketState {
  readonly objectId: string
  readonly name: string
  readonly owner: string
  readonly evm: SuiEvmBinding | null
  readonly policy: SuiPolicy
  readonly policyHash: Hex
  readonly capabilityEpoch: number
  readonly capabilityNonce: bigint
  readonly usage: Usage
  readonly guardians: readonly string[]
  readonly receivingPolicy: SuiReceivingPolicy | null
  readonly evmExecutionNonce: bigint
  readonly evmReceiptsRecorded: bigint
  readonly lastEvmTx: Hex | null
  readonly status: BucketStatus
  readonly version: bigint
  readonly createdAtMs: bigint
  readonly updatedAtMs: bigint
}
