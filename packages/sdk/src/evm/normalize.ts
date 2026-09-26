import type {
  AssetConfig,
  AssetState,
  BucketMeta,
  BucketSnapshot,
  BucketStatus,
  Capability,
  CapabilityLimits,
  CapabilityStatus,
  EffectiveLimits,
  ExecutionKind,
  ExecutionReceipt,
  Intent,
  IntentKind,
  PolicyParams,
  Usage,
} from '@bucket/protocol-types'
import { getAddress, type Address, type Hex } from 'viem'

/** Raw shapes as decoded by viem from the Bucket ABIs (small uints as number, uint64+ as bigint). */
interface RawParams {
  rebalanceThresholdBps: number
  maxSlippageBps: number
  maxPriceAge: number
  auctionDuration: number
  venueMask: number
  maxDailyTurnoverBps: number
  delegablePermissions: number
  maxExecutionValue: bigint
  maxHourlyValue: bigint
  maxDailyValue: bigint
}

interface RawAssetState {
  token: Address
  decimals: number
  targetBps: number
  minBps: number
  maxBps: number
  balance: bigint
  priceWad: bigint
  priceUpdatedAt: bigint
}

interface RawSnapshot {
  bucketId: Hex
  holder: Address
  authority: Address
  capabilities: Address
  status: number
  policyVersion: number
  policyHash: Hex
  strategyHash: Hex
  activeIntent: Hex
  params: RawParams
  assets: readonly RawAssetState[]
}

interface RawUsage {
  hourWindow: number
  dayWindow: number
  hourValue: bigint
  dayValue: bigint
}

interface RawMeta {
  holder: Address
  status: number
  policyVersion: number
  createdAt: number
  updatedAt: number
  executionNonce: bigint
  intentNonce: bigint
  strategyNonce: number
  strategyExpiry: number
  policyHash: Hex
  strategyHash: Hex
  activeIntent: Hex
  lastReceipt: Hex
  suiObjectId: Hex
  usage: RawUsage
}

interface RawLimits {
  maxExecutionValue: bigint
  maxHourlyValue: bigint
  maxDailyValue: bigint
  maxSlippageBps: number
  maxDailyTurnoverBps: number
  maxExecutions: number
}

interface RawCapability {
  bucketId: Hex
  parentId: Hex
  issuer: Address
  operator: Address
  operatorRegistry: Address
  depth: number
  status: number
  permissions: number
  assetMask: number
  venueMask: number
  validAfter: number
  validUntil: number
  issuedAt: number
  policyVersion: number
  epoch: number
  nonce: bigint
  executions: bigint
  payee: Address
  limits: RawLimits
  usage: RawUsage
  operatorLabel: string
}

interface RawIntent {
  bucketId: Hex
  capabilityId: Hex
  operator: Address
  kind: number
  tokenOut: Address
  tokenIn: Address
  remainingOut: bigint
  openedAt: number
  expiresAt: number
  policyVersion: number
  nonce: bigint
}

interface RawEffectiveLimits {
  maxExecutionValue: bigint
  remainingHourlyValue: bigint
  remainingDailyValue: bigint
  remainingTurnoverValue: bigint
  maxSlippageBps: number
}

interface RawReceipt {
  bucketId: Hex
  executionNonce: bigint
  kind: number
  capabilityId: Hex
  intentId: Hex
  orderHash: Hex
  operator: Address
  policyVersion: number
  policyHash: Hex
  strategyHash: Hex
  tokenOut: Address
  tokenIn: Address
  amountOut: bigint
  amountIn: bigint
  valueOut: bigint
  recipient: Address
  preBalances: readonly bigint[]
  postBalances: readonly bigint[]
  pricesWad: readonly bigint[]
  preTotalValue: bigint
  postTotalValue: bigint
  preMaxDeviationWad: bigint
  postMaxDeviationWad: bigint
  preStateHash: Hex
  postStateHash: Hex
  timestamp: number
}

export function toStatus(value: number): BucketStatus {
  if (value < 0 || value > 3) throw new RangeError(`unknown Bucket status ${value}`)
  return value as BucketStatus
}

export function toCapabilityStatus(value: number): CapabilityStatus {
  if (value < 0 || value > 3) throw new RangeError(`unknown capability status ${value}`)
  return value as CapabilityStatus
}

export function toIntentKind(value: number): IntentKind {
  if (value < 0 || value > 2) throw new RangeError(`unknown intent kind ${value}`)
  return value as IntentKind
}

export function toExecutionKind(value: number): ExecutionKind {
  if (value < 0 || value > 3) throw new RangeError(`unknown execution kind ${value}`)
  return value as ExecutionKind
}

export function toParams(raw: RawParams): PolicyParams {
  return { ...raw }
}

export function toAssetConfig(raw: Omit<RawAssetState, 'balance' | 'priceWad' | 'priceUpdatedAt'>): AssetConfig {
  return {
    token: getAddress(raw.token),
    decimals: raw.decimals,
    targetBps: raw.targetBps,
    minBps: raw.minBps,
    maxBps: raw.maxBps,
  }
}

export function toAssetState(raw: RawAssetState): AssetState {
  return { ...toAssetConfig(raw), balance: raw.balance, priceWad: raw.priceWad, priceUpdatedAt: raw.priceUpdatedAt }
}

export function toSnapshot(raw: RawSnapshot): BucketSnapshot {
  return {
    bucketId: raw.bucketId,
    holder: getAddress(raw.holder),
    authority: getAddress(raw.authority),
    capabilities: getAddress(raw.capabilities),
    status: toStatus(raw.status),
    policyVersion: raw.policyVersion,
    policyHash: raw.policyHash,
    strategyHash: raw.strategyHash,
    activeIntent: raw.activeIntent,
    params: toParams(raw.params),
    assets: raw.assets.map(toAssetState),
  }
}

export function toUsage(raw: RawUsage): Usage {
  return { ...raw }
}

export function toMeta(raw: RawMeta): BucketMeta {
  return {
    holder: getAddress(raw.holder),
    status: toStatus(raw.status),
    policyVersion: raw.policyVersion,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    executionNonce: raw.executionNonce,
    intentNonce: raw.intentNonce,
    strategyNonce: raw.strategyNonce,
    strategyExpiry: raw.strategyExpiry,
    policyHash: raw.policyHash,
    strategyHash: raw.strategyHash,
    activeIntent: raw.activeIntent,
    lastReceipt: raw.lastReceipt,
    suiObjectId: raw.suiObjectId,
    usage: toUsage(raw.usage),
  }
}

export function toLimits(raw: RawLimits): CapabilityLimits {
  return { ...raw }
}

export function toCapability(raw: RawCapability): Capability {
  return {
    bucketId: raw.bucketId,
    parentId: raw.parentId,
    issuer: getAddress(raw.issuer),
    operator: getAddress(raw.operator),
    operatorRegistry: getAddress(raw.operatorRegistry),
    depth: raw.depth,
    status: toCapabilityStatus(raw.status),
    permissions: raw.permissions,
    assetMask: raw.assetMask,
    venueMask: raw.venueMask,
    validAfter: raw.validAfter,
    validUntil: raw.validUntil,
    issuedAt: raw.issuedAt,
    policyVersion: raw.policyVersion,
    epoch: raw.epoch,
    nonce: raw.nonce,
    executions: raw.executions,
    payee: getAddress(raw.payee),
    limits: toLimits(raw.limits),
    usage: toUsage(raw.usage),
    operatorLabel: raw.operatorLabel,
  }
}

export function toIntent(raw: RawIntent): Intent {
  return {
    bucketId: raw.bucketId,
    capabilityId: raw.capabilityId,
    operator: getAddress(raw.operator),
    kind: toIntentKind(raw.kind),
    tokenOut: getAddress(raw.tokenOut),
    tokenIn: getAddress(raw.tokenIn),
    remainingOut: raw.remainingOut,
    openedAt: raw.openedAt,
    expiresAt: raw.expiresAt,
    policyVersion: raw.policyVersion,
    nonce: raw.nonce,
  }
}

export function toEffectiveLimits(raw: RawEffectiveLimits): EffectiveLimits {
  return { ...raw }
}

export function toOrder(raw: { maker: Address; traits: bigint; data: Hex }) {
  return { maker: getAddress(raw.maker), traits: raw.traits, data: raw.data }
}

export function toReceipt(raw: RawReceipt): ExecutionReceipt {
  return {
    bucketId: raw.bucketId,
    executionNonce: raw.executionNonce,
    kind: toExecutionKind(raw.kind),
    capabilityId: raw.capabilityId,
    intentId: raw.intentId,
    orderHash: raw.orderHash,
    operator: getAddress(raw.operator),
    policyVersion: raw.policyVersion,
    policyHash: raw.policyHash,
    strategyHash: raw.strategyHash,
    tokenOut: getAddress(raw.tokenOut),
    tokenIn: getAddress(raw.tokenIn),
    amountOut: raw.amountOut,
    amountIn: raw.amountIn,
    valueOut: raw.valueOut,
    recipient: getAddress(raw.recipient),
    preBalances: [...raw.preBalances],
    postBalances: [...raw.postBalances],
    pricesWad: [...raw.pricesWad],
    preTotalValue: raw.preTotalValue,
    postTotalValue: raw.postTotalValue,
    preMaxDeviationWad: raw.preMaxDeviationWad,
    postMaxDeviationWad: raw.postMaxDeviationWad,
    preStateHash: raw.preStateHash,
    postStateHash: raw.postStateHash,
    timestamp: raw.timestamp,
  }
}
