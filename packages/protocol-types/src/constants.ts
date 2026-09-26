/**
 * Protocol constants. Every value here is mirrored exactly by the EVM `BucketTypes.sol` / `BucketPermissions.sol`
 * and, where a Sui-native equivalent exists, by the Sui `bucket::policy` / `bucket::capability` modules.
 */

/** Maximum number of assets a Bucket may hold (bounds the `u8` asset mask). */
export const MAX_BUCKET_ASSETS = 8

/** Basis-point denominator (100% = 10_000). */
export const BPS = 10_000n

/** 18-decimal fixed-point unit for USD values, prices and weights. */
export const WAD = 10n ** 18n

/** One basis point expressed as a WAD fraction. */
export const BPS_TO_WAD = 10n ** 14n

/** Tokens with more decimals are rejected; normalisation is always an up-scaling. */
export const MAX_TOKEN_DECIMALS = 18

/** Upper bound on a policy's `maxSlippageBps` (10%). */
export const MAX_SLIPPAGE_LIMIT_BPS = 1_000

/** Upper bound on a policy's `rebalanceThresholdBps` (50%). */
export const MAX_THRESHOLD_LIMIT_BPS = 5_000

/** Fixed spend-velocity windows, seconds. */
export const HOUR = 3_600
export const DAY = 86_400

/** Maximum depth of a capability delegation chain (root = depth 0). */
export const MAX_DELEGATION_DEPTH = 3

/** Maximum lifetime of a capability, seconds (365 days). */
export const MAX_CAPABILITY_DURATION = 365 * DAY

/** Execution venue flags carried in `PolicyParams.venueMask` / `Capability.venueMask` (EVM only; Sui has none). */
export const Venue = {
  AquaSwapVM: 1,
} as const
export const ALL_VENUES = Venue.AquaSwapVM

/** Domain tags. */
export const POLICY_DOMAIN_TAG = 'BUCKET_POLICY_V2'
export const BUCKET_ID_DOMAIN_TAG = 'BUCKET_ID_V1'
export const INTENT_ID_DOMAIN_TAG = 'BUCKET_INTENT_V1'
export const CAPABILITY_ID_DOMAIN_TAG = 'BUCKET_CAPABILITY_ID_V1'
export const CAPABILITY_HASH_DOMAIN_TAG = 'BUCKET_CAPABILITY_V1'

/** Bucket lifecycle, identical numbering on the EVM (`BucketStatus`) and on Sui (`STATUS_*`). */
export const BucketStatus = {
  None: 0,
  Active: 1,
  Paused: 2,
  Closed: 3,
} as const
export type BucketStatus = (typeof BucketStatus)[keyof typeof BucketStatus]

export const BUCKET_STATUS_LABEL: Record<BucketStatus, string> = {
  [BucketStatus.None]: 'NONE',
  [BucketStatus.Active]: 'ACTIVE',
  [BucketStatus.Paused]: 'PAUSED',
  [BucketStatus.Closed]: 'CLOSED',
}

/** Lifecycle of a Financial Capability. `Revoked` and `Exhausted` are terminal; validity is still re-checked live. */
export const CapabilityStatus = {
  None: 0,
  Active: 1,
  Revoked: 2,
  Exhausted: 3,
} as const
export type CapabilityStatus = (typeof CapabilityStatus)[keyof typeof CapabilityStatus]

export const CAPABILITY_STATUS_LABEL: Record<CapabilityStatus, string> = {
  [CapabilityStatus.None]: 'NONE',
  [CapabilityStatus.Active]: 'ACTIVE',
  [CapabilityStatus.Revoked]: 'REVOKED',
  [CapabilityStatus.Exhausted]: 'EXHAUSTED',
}

/** Kind of a financial intent (EVM Aqua/SwapVM execution). */
export const IntentKind = {
  None: 0,
  Rebalance: 1,
  Swap: 2,
} as const
export type IntentKind = (typeof IntentKind)[keyof typeof IntentKind]

/** Kind of an execution receipt. */
export const ExecutionKind = {
  None: 0,
  Rebalance: 1,
  Swap: 2,
  Pay: 3,
} as const
export type ExecutionKind = (typeof ExecutionKind)[keyof typeof ExecutionKind]

export const EXECUTION_KIND_LABEL: Record<ExecutionKind, string> = {
  [ExecutionKind.None]: 'NONE',
  [ExecutionKind.Rebalance]: 'REBALANCE',
  [ExecutionKind.Swap]: 'SWAP',
  [ExecutionKind.Pay]: 'PAY',
}

/** SwapVM opcodes used by Bucket programs (fixed numbering of the SwapVM `OpcodeList`, Bucket bank 0xd0-0xd3). */
export const Opcode = {
  Salt: 0x02,
  Deadline: 0x20,
  BucketCapabilityGuard: 0xd0,
  BucketQuote: 0xd1,
  BucketSpendLimit: 0xd2,
  BucketWalletBalanceCheck: 0xd3,
} as const
export type Opcode = (typeof Opcode)[keyof typeof Opcode]
