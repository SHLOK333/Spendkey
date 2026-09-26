// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { IPermissionedRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";

import {
    AssetConfig,
    BucketMeta,
    BucketSnapshot,
    BucketStatus,
    EffectiveLimits,
    ExecutionFrame,
    ExecutionReceipt,
    Intent,
    PolicyParams
} from "../types/BucketTypes.sol";

/// @title IBucketController
/// @notice The EVM execution layer of Buckets: policy, strategy generations, financial intents, capability-bound
///         payments and post-execution verification of every Aqua + SwapVM fill.
/// @dev The controller never holds or transfers Bucket tokens on its own authority. Swaps move tokens only through
///      Aqua `pull`/`push` of strategies the holder shipped; payments move tokens only through the holder's explicit
///      ERC-20 allowance, and only to a capability's fixed payee.
interface IBucketController {
    /// @notice Parameters of `createBucket`.
    /// @param registry ENSv2 registry holding the Bucket name label (e.g. the subregistry of `shlok.eth`)
    /// @param label Bucket name label (e.g. `trading` for `trading.shlok.eth`)
    /// @param suiObjectId Object ID of the canonical Sui `Bucket` this execution representation is bound to
    /// @param strategyExpiry Aqua-level expiry (SwapVM `Deadline`) of the first strategy generation
    struct CreateBucketParams {
        IPermissionedRegistry registry;
        string label;
        bytes32 suiObjectId;
        uint40 strategyExpiry;
        PolicyParams params;
        AssetConfig[] assets;
    }

    /// @notice Why an intent stopped being fillable.
    enum IntentCloseReason {
        CANCELLED,
        FULFILLED,
        SUPERSEDED,
        BUCKET_CHANGED
    }

    event BucketCreated(
        bytes32 indexed bucketId,
        address indexed holder,
        address indexed registry,
        uint256 labelId,
        string label,
        bytes32 suiObjectId
    );
    event BucketPolicyUpdated(bytes32 indexed bucketId, uint32 indexed policyVersion, bytes32 policyHash);
    event BucketStatusUpdated(bytes32 indexed bucketId, BucketStatus status, address indexed by);
    event BucketSuiObjectBound(bytes32 indexed bucketId, bytes32 suiObjectId);
    event StrategyGenerationRotated(
        bytes32 indexed bucketId, uint32 strategyNonce, uint40 strategyExpiry, bytes32 strategyHash
    );
    event IntentOpened(
        bytes32 indexed bucketId,
        bytes32 indexed intentId,
        bytes32 indexed capabilityId,
        Intent intent,
        uint256 maxDeviationWad
    );
    event IntentClosed(bytes32 indexed bucketId, bytes32 indexed intentId, IntentCloseReason reason);
    event ExecutionRecorded(
        bytes32 indexed bucketId,
        uint64 indexed executionNonce,
        bytes32 indexed capabilityId,
        ExecutionReceipt receipt,
        bytes32 receiptHash
    );

    error BucketNotFound(bytes32 bucketId);
    error BucketExists(bytes32 bucketId);
    error BucketNotActive(bytes32 bucketId, BucketStatus status);
    error BucketClosed(bytes32 bucketId);
    error InvalidStatusTransition(BucketStatus from, BucketStatus to);
    error NotBucketOwner(address caller, address owner);
    error NotOwnerOrGuardian(address caller);
    error HolderIsNotOwner(address holder, address owner);
    error AssetClaimedByBucket(address token, bytes32 bucketId);
    error AssetNotAllowed(bytes32 bucketId, address token);
    error SameAsset(address token);
    error ZeroAmount();
    error ZeroAddress();
    error StrategyExpiryInvalid(uint40 strategyExpiry);
    error WithinPolicy(bytes32 bucketId, uint256 maxDeviationWad);
    error NothingToRebalance(bytes32 bucketId);
    error LimitsExhausted(bytes32 bucketId, bytes32 capabilityId);
    error SpendLimitExceeded(uint256 value, uint256 limit);
    error InsufficientHolderBalance(address token, uint256 balance, uint256 amount);
    error NoOpenIntent(bytes32 bucketId);
    error NotIntentOperator(address caller, address operator);
    error ExecutionInProgress();
    error OnlyRouter(address caller);
    error StrategyNotCanonical(bytes32 orderHash);
    error MakerMismatch(address expected, address actual);
    error UnsupportedHook();
    error UnexpectedFee(uint256 fee);
    error SnapshotMissing(bytes32 orderHash);
    error BalanceDeltaMismatch(address token, uint256 expected, uint256 actual);
    error PostStateNotImproved(uint256 preMaxDeviationWad, uint256 postMaxDeviationWad);
    error PostStateOutOfBand(address token, uint256 weightWad);
    error BucketVelocityExceeded(uint256 value, uint256 remaining);

    // ---------------------------------------------------------------------------------------------- lifecycle

    /// @notice Creates a Bucket over the caller's own wallet. The caller must own the ENSv2 name and becomes the holder.
    function createBucket(CreateBucketParams calldata params) external returns (bytes32 bucketId);

    /// @notice Installs a new policy version (owner). Every capability issued under an older version stops working.
    function updatePolicy(bytes32 bucketId, PolicyParams calldata params, AssetConfig[] calldata assets) external;

    /// @notice Owner status transition (ACTIVE <-> PAUSED, -> CLOSED).
    function setStatus(bytes32 bucketId, BucketStatus status) external;

    /// @notice Emergency pause by the owner or a guardian. Only the owner can resume.
    function pause(bytes32 bucketId) external;

    function setSuiObject(bytes32 bucketId, bytes32 suiObjectId) external;

    /// @notice Starts a new strategy generation: every previously shipped Bucket strategy stops being canonical.
    function rotateStrategies(bytes32 bucketId, uint40 strategyExpiry) external;

    // ---------------------------------------------------------------------------------------------- intents

    /// @notice Opens the policy-computed rebalance intent under a capability holding `PERM_REBALANCE`.
    function openRebalanceIntent(bytes32 bucketId, bytes32 capabilityId) external returns (bytes32 intentId);

    /// @notice Opens an operator-directed swap intent under a capability holding `PERM_SWAP`.
    function openSwapIntent(bytes32 bucketId, bytes32 capabilityId, address tokenOut, address tokenIn, uint256 amountOut)
        external
        returns (bytes32 intentId);

    /// @notice Closes the open intent (its operator, the owner or a guardian).
    function cancelIntent(bytes32 bucketId) external;

    // ---------------------------------------------------------------------------------------------- payments

    /// @notice Pays `amount` of `token` from the holder's wallet to the capability's fixed payee (`PERM_PAY`).
    function pay(bytes32 bucketId, bytes32 capabilityId, address token, uint256 amount)
        external
        returns (bytes32 receiptHash);

    // ---------------------------------------------------------------------------------------------- views

    function computeBucketId(IPermissionedRegistry registry, uint256 labelId) external view returns (bytes32);
    function loadBucket(bytes32 bucketId) external view returns (BucketSnapshot memory);
    function getBucket(bytes32 bucketId) external view returns (BucketMeta memory);
    function getPolicy(bytes32 bucketId) external view returns (PolicyParams memory params, AssetConfig[] memory assets);
    function getIntent(bytes32 intentId) external view returns (Intent memory);

    /// @notice Everything a Bucket SwapVM instruction needs to decide a fill of `orderHash` in direction
    ///         `tokenOut -> tokenIn`.
    function loadFrame(bytes32 bucketId, bytes32 orderHash, address tokenIn, address tokenOut)
        external
        view
        returns (ExecutionFrame memory);

    /// @notice Tightest limits of the next execution under `capabilityId` (policy, Bucket usage, capability chain).
    function effectiveLimits(bytes32 bucketId, bytes32 capabilityId) external view returns (EffectiveLimits memory);

    /// @notice Policy context consumed by `BucketCapabilities`.
    function policyContext(bytes32 bucketId)
        external
        view
        returns (BucketStatus status, address holder, uint32 policyVersion, PolicyParams memory params, uint256 assetCount);

    /// @notice The canonical Aqua strategy of the current generation for the pair (`tokenX`, `tokenY`), and its hash.
    ///         The holder ships exactly this order; any other order is rejected by the program and the hooks.
    function strategyOrder(bytes32 bucketId, address tokenX, address tokenY)
        external
        view
        returns (ISwapVM.Order memory order, bytes32 orderHash);

    /// @notice The canonical Bucket SwapVM program of the current generation.
    function strategyProgram(bytes32 bucketId) external view returns (bytes memory);
}
