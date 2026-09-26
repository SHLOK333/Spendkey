// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @title BucketTypes
/// @notice Canonical data model of the BUCKET protocol on the EVM execution layer.
/// @dev Mirrored field-for-field by the Sui Move package (`bucket::policy`, `bucket::capability`) and by
///      `@bucket/protocol-types`. `BucketPolicyLib.hash` and `CapabilityLib.hash` define the chain-neutral commitments
///      that bind the three representations.
///
///      Custody model: a Bucket never holds tokens. Its assets are the balances of the policy tokens in the owner's
///      own wallet (the Bucket `holder`, which is also the Aqua maker). Execution authority is delegated through
///      Financial Capabilities; the holder's wallet is only ever debited by (a) an Aqua `pull` inside a SwapVM fill of
///      a strategy the holder shipped, bounded by the strategy's Aqua virtual balance, or (b) a capability-bound
///      payment bounded by the holder's explicit ERC-20 allowance.

/// @dev Maximum number of assets a Bucket may hold. Bounds every loop over bucket assets and fits `assetMask`.
uint256 constant MAX_BUCKET_ASSETS = 8;
/// @dev Basis-point denominator (100% = 10_000).
uint256 constant BPS = 10_000;
/// @dev 18-decimal fixed-point unit used for USD values, prices and weights.
uint256 constant WAD = 1e18;
/// @dev Scale factor converting a basis-point quantity into a WAD fraction (1 bps = 1e14 WAD).
uint256 constant BPS_TO_WAD = 1e14;
/// @dev Tokens with more decimals than this are rejected so normalisation is a pure up-scaling.
uint8 constant MAX_TOKEN_DECIMALS = 18;
/// @dev Upper bound on `maxSlippageBps` (10%). A policy can never authorise worse execution than this.
uint16 constant MAX_SLIPPAGE_LIMIT_BPS = 1_000;
/// @dev Upper bound on `rebalanceThresholdBps` (50%).
uint16 constant MAX_THRESHOLD_LIMIT_BPS = 5_000;

/// @dev Spend-velocity windows. Windows are fixed and aligned to `timestamp / WINDOW`.
uint256 constant HOUR = 3_600;
uint256 constant DAY = 86_400;

/// @dev Maximum depth of a capability delegation chain (root = depth 0).
uint8 constant MAX_DELEGATION_DEPTH = 3;
/// @dev Maximum lifetime of a capability. Long-lived blanket authority is exactly what Buckets exist to avoid.
uint40 constant MAX_CAPABILITY_DURATION = 365 days;

/// @dev Execution venue flags carried in `PolicyParams.venueMask` and `Capability.venueMask`.
uint8 constant VENUE_AQUA_SWAPVM = 1 << 0;
uint8 constant ALL_VENUES = VENUE_AQUA_SWAPVM;

/// @notice Lifecycle of a Bucket. `CLOSED` is terminal.
enum BucketStatus {
    NONE,
    ACTIVE,
    PAUSED,
    CLOSED
}

/// @notice Lifecycle of a Financial Capability. `REVOKED` and `EXHAUSTED` are terminal.
/// @dev A capability can also be *invalid* while `ACTIVE` (expired, epoch killed, policy version superseded, ENSv2
///      identity lost, ancestor revoked). Validity is always evaluated live; `status` only records explicit events.
enum CapabilityStatus {
    NONE,
    ACTIVE,
    REVOKED,
    EXHAUSTED
}

/// @notice Kind of a financial intent an operator may open under a capability.
enum IntentKind {
    NONE,
    REBALANCE,
    SWAP
}

/// @notice Kind of an execution receipt.
enum ExecutionKind {
    NONE,
    REBALANCE,
    SWAP,
    PAY
}

/// @notice Per-asset allocation policy. Packs into a single storage slot (20 + 1 + 2 + 2 + 2 = 27 bytes).
/// @param token ERC-20 token held in the Bucket holder's wallet
/// @param decimals Token decimals (<= 18), committed in the policy so valuation never trusts a live call
/// @param targetBps Target weight of total Bucket value
/// @param minBps Hard lower band; a weight below it makes the Bucket out of policy regardless of threshold
/// @param maxBps Hard upper band; a weight above it makes the Bucket out of policy regardless of threshold
struct AssetConfig {
    address token;
    uint8 decimals;
    uint16 targetBps;
    uint16 minBps;
    uint16 maxBps;
}

/// @notice Scalar policy parameters. Every capability issued under the policy is bounded by them.
/// @param rebalanceThresholdBps Absolute weight deviation from target that makes a rebalance required
/// @param maxSlippageBps Maximum value the Bucket may concede on a single execution, relative to reference prices
/// @param maxPriceAge Maximum age in seconds of a reference price used for valuation
/// @param auctionDuration Seconds over which an intent's concession decays from 0 to its slippage limit
/// @param venueMask Allowed execution venues (`VENUE_*` flags)
/// @param maxDailyTurnoverBps Maximum value traded per day as a fraction of total Bucket value
/// @param delegablePermissions Capability permissions (`BucketPermissions.PERM_*`) the owner may delegate
/// @param maxExecutionValue Maximum USD value (WAD) moved by a single execution
/// @param maxHourlyValue Maximum USD value (WAD) moved per hour across every capability
/// @param maxDailyValue Maximum USD value (WAD) moved per day across every capability
struct PolicyParams {
    uint16 rebalanceThresholdBps;
    uint16 maxSlippageBps;
    uint32 maxPriceAge;
    uint32 auctionDuration;
    uint8 venueMask;
    uint16 maxDailyTurnoverBps;
    uint32 delegablePermissions;
    uint128 maxExecutionValue;
    uint128 maxHourlyValue;
    uint128 maxDailyValue;
}

/// @notice Complete Bucket policy.
struct BucketPolicy {
    PolicyParams params;
    AssetConfig[] assets;
}

/// @notice Cumulative execution usage in the current fixed hour/day windows.
struct Usage {
    uint32 hourWindow;
    uint32 dayWindow;
    uint128 hourValue;
    uint128 dayValue;
}

/// @notice Persistent Bucket record kept by `BucketController`.
/// @param holder The owner's wallet holding the Bucket assets; the Aqua maker of every Bucket strategy
/// @param strategyNonce Salt of the current strategy generation; rotating it retires every shipped strategy
/// @param strategyExpiry Aqua-level expiry (SwapVM `Deadline`) of the current strategy generation
/// @param strategyHash keccak256 of the canonical Bucket SwapVM program of the current generation
struct BucketRecord {
    address holder;
    BucketStatus status;
    uint32 policyVersion;
    uint40 createdAt;
    uint40 updatedAt;
    uint64 executionNonce;
    uint64 intentNonce;
    uint32 strategyNonce;
    uint40 strategyExpiry;
    bytes32 policyHash;
    bytes32 strategyHash;
    bytes32 activeIntent;
    bytes32 lastReceipt;
    bytes32 suiObjectId;
    Usage usage;
    PolicyParams params;
    AssetConfig[] assets;
}

/// @notice Flat read model of a Bucket's bookkeeping (everything in `BucketRecord` except policy and assets, which
///         `loadBucket` returns together with live balances).
struct BucketMeta {
    address holder;
    BucketStatus status;
    uint32 policyVersion;
    uint40 createdAt;
    uint40 updatedAt;
    uint64 executionNonce;
    uint64 intentNonce;
    uint32 strategyNonce;
    uint40 strategyExpiry;
    bytes32 policyHash;
    bytes32 strategyHash;
    bytes32 activeIntent;
    bytes32 lastReceipt;
    bytes32 suiObjectId;
    Usage usage;
}

/// @notice Live state of one Bucket asset as seen by the execution layer.
struct AssetState {
    address token;
    uint8 decimals;
    uint16 targetBps;
    uint16 minBps;
    uint16 maxBps;
    uint256 balance;
    uint256 priceWad;
    uint64 priceUpdatedAt;
}

/// @notice Read model of a Bucket consumed by the Bucket SwapVM instructions and by off-chain clients.
struct BucketSnapshot {
    bytes32 bucketId;
    address holder;
    address authority;
    address capabilities;
    BucketStatus status;
    uint32 policyVersion;
    bytes32 policyHash;
    bytes32 strategyHash;
    bytes32 activeIntent;
    PolicyParams params;
    AssetState[] assets;
}

/// @notice Quantitative limits of a capability. Every field is a ceiling; a child can only lower them.
/// @param maxExecutionValue Maximum USD value (WAD) of a single execution
/// @param maxHourlyValue Maximum USD value (WAD) per hour window, charged to the capability and all its ancestors
/// @param maxDailyValue Maximum USD value (WAD) per day window, charged to the capability and all its ancestors
/// @param maxSlippageBps Maximum concession below reference price an intent under this capability may grant
/// @param maxDailyTurnoverBps Maximum value traded per day as a fraction of total Bucket value
/// @param maxExecutions Maximum number of executions over the capability's lifetime (0 = unlimited)
struct CapabilityLimits {
    uint128 maxExecutionValue;
    uint128 maxHourlyValue;
    uint128 maxDailyValue;
    uint16 maxSlippageBps;
    uint16 maxDailyTurnoverBps;
    uint32 maxExecutions;
}

/// @notice Owner/operator input describing a capability to issue.
/// @param operatorLabel ENSv2 label of the operator under the issuer's name, e.g. `agent` for
///        `agent.trading.shlok.eth` (root) or `exec` for `exec.agent.trading.shlok.eth` (child)
/// @param permissions Capability permissions (`BucketPermissions.PERM_*`)
/// @param assetMask Bit `i` allows policy asset `i`
/// @param venueMask Allowed execution venues
/// @param validAfter First second the capability may be exercised
/// @param validUntil Last second the capability may be exercised
/// @param payee Only recipient of `PAY` executions; zero unless `PERM_PAY` is granted
struct CapabilityGrant {
    string operatorLabel;
    uint32 permissions;
    uint8 assetMask;
    uint8 venueMask;
    uint40 validAfter;
    uint40 validUntil;
    address payee;
    CapabilityLimits limits;
}

/// @notice A Financial Capability: narrowly scoped, time-bound, nonce-bound, policy-bound execution authority.
/// @param issuer Bucket owner (root) or the parent capability's operator (child) at issuance
/// @param operator Live ENSv2 owner of the operator name at issuance; must still own it at every use
/// @param operatorRegistry ENSv2 registry holding `operatorLabel` (subregistry of the issuer's name)
/// @param nonce Per-Bucket sequential capability nonce; `capabilityId = keccak256(DOMAIN, bucketId, nonce)`
/// @param epoch Bucket capability epoch at issuance; bumping the epoch kills every capability of the Bucket
/// @param policyVersion Policy version the capability was issued under; a policy change supersedes it
struct Capability {
    bytes32 bucketId;
    bytes32 parentId;
    address issuer;
    address operator;
    address operatorRegistry;
    uint8 depth;
    CapabilityStatus status;
    uint32 permissions;
    uint8 assetMask;
    uint8 venueMask;
    uint40 validAfter;
    uint40 validUntil;
    uint40 issuedAt;
    uint32 policyVersion;
    uint32 epoch;
    uint64 nonce;
    uint64 executions;
    address payee;
    CapabilityLimits limits;
    Usage usage;
    string operatorLabel;
}

/// @notice Effective limits of the next execution: the tightest bound over the policy, the Bucket-wide usage and
///         every capability in the delegation chain, evaluated at a timestamp. All values are USD (WAD).
/// @param remainingTurnoverValue Remaining daily turnover, `turnoverBps * totalValue / BPS - daySpent`
struct EffectiveLimits {
    uint256 maxExecutionValue;
    uint256 remainingHourlyValue;
    uint256 remainingDailyValue;
    uint256 remainingTurnoverValue;
    uint16 maxSlippageBps;
}

/// @notice An open financial intent: "fulfil this goal within these constraints", not "trade freely".
/// @param capabilityId Capability the intent was opened under (re-validated at fill time)
/// @param operator Only taker allowed to fulfil the intent (solver competition is an extension point)
/// @param remainingOut Remaining amount of `tokenOut` the Bucket may give under the intent
/// @param openedAt Start of the intent's Dutch auction (concession 0 at `openedAt`)
/// @param expiresAt Last second the intent can be filled
struct Intent {
    bytes32 bucketId;
    bytes32 capabilityId;
    address operator;
    IntentKind kind;
    address tokenOut;
    address tokenIn;
    uint256 remainingOut;
    uint40 openedAt;
    uint40 expiresAt;
    uint32 policyVersion;
    uint64 nonce;
}

/// @notice Everything the Bucket SwapVM instructions need to decide one fill.
struct ExecutionFrame {
    BucketSnapshot bucket;
    Intent intent;
    EffectiveLimits limits;
    bool strategyActive;
}

/// @notice Structured, verifiable evidence of one execution. Emitted by the controller and re-verified on Sui.
/// @dev Answers: WHO executed (operator, capabilityId), WHY it was allowed (kind, policy version/hash, strategy),
///      WHAT changed (pre/post balances, weights via prices), HOW MUCH moved (amounts, value) and the RESULT.
struct ExecutionReceipt {
    bytes32 bucketId;
    uint64 executionNonce;
    ExecutionKind kind;
    bytes32 capabilityId;
    bytes32 intentId;
    bytes32 orderHash;
    address operator;
    uint32 policyVersion;
    bytes32 policyHash;
    bytes32 strategyHash;
    address tokenOut;
    address tokenIn;
    uint256 amountOut;
    uint256 amountIn;
    uint256 valueOut;
    address recipient;
    uint256[] preBalances;
    uint256[] postBalances;
    uint256[] pricesWad;
    uint256 preTotalValue;
    uint256 postTotalValue;
    uint256 preMaxDeviationWad;
    uint256 postMaxDeviationWad;
    bytes32 preStateHash;
    bytes32 postStateHash;
    uint40 timestamp;
}
