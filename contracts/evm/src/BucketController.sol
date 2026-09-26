// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { ReentrancyGuardTransient } from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { IMakerHooks } from "@1inch/swap-vm/contracts/interfaces/IMakerHooks.sol";
import { IPermissionedRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";

import { IBucketAuthority } from "./interfaces/IBucketAuthority.sol";
import { IBucketCapabilities } from "./interfaces/IBucketCapabilities.sol";
import { IBucketController } from "./interfaces/IBucketController.sol";
import { IBucketPriceFeed } from "./interfaces/IBucketPriceFeed.sol";
import { BucketEngine } from "./libraries/BucketEngine.sol";
import { BucketPermissions } from "./libraries/BucketPermissions.sol";
import { BucketPolicyLib } from "./libraries/BucketPolicyLib.sol";
import {
    AssetConfig,
    BucketMeta,
    BucketRecord,
    BucketSnapshot,
    BucketStatus,
    Capability,
    EffectiveLimits,
    ExecutionFrame,
    ExecutionKind,
    ExecutionReceipt,
    Intent,
    IntentKind,
    PolicyParams,
    VENUE_AQUA_SWAPVM
} from "./types/BucketTypes.sol";

/// @title BucketController
/// @notice The EVM execution layer of Buckets: policy, strategy generations, financial intents, capability-bound
///         payments and post-execution verification of every Aqua + SwapVM fill.
/// @dev Custody. A Bucket's assets are the policy-token balances of its `holder`, the owner's own wallet. The
///      controller has no transfer authority of its own:
///        - swaps move tokens only through Aqua `pull`/`push` of the canonical strategies the holder shipped
///          (`strategyOrder`), inside the holder's Aqua virtual balances and ERC-20 allowance to Aqua;
///        - payments move tokens only through the holder's explicit ERC-20 allowance to this contract, only to the
///          fixed payee of a `PERM_PAY` capability, and only within that capability's limits.
///      The holder can exit at any time without this contract: `Aqua.dock` or revoking the Aqua allowance.
///
///      Execution lifecycle of a fill (`BucketSwapVMRouter.swap`):
///        program   0xd0 guard -> 0xd1 quote -> 0xd2 spend limit -> 0xd3 wallet balance  (pre-execution, view)
///        hook      preTransferOut: canonical strategy, open intent, snapshot holder balances
///        Aqua      pull(tokenOut: holder -> operator), push(tokenIn: operator -> holder)
///        hook      postTransferIn: exact balance deltas, post-state invariant, velocity charge, receipt
///
///      Invariants
///      C1  Only the live ENSv2 owner of a name can create the Bucket bound to it, over its own wallet.
///      C2  A wallet token belongs to at most one open Bucket (no double counting of holdings).
///      C3  A Bucket has at most one open intent; an intent is fillable only under the policy version it was opened
///          under, before its expiry, in its direction, by its operator, under a live capability.
///      C4  A settled fill changes exactly two holder balances, by exactly the swapped amounts, with no fee.
///      C5  A settled REBALANCE does not increase the deviation of either traded asset nor the maximum deviation;
///          a settled SWAP leaves both traded assets inside their hard bands.
///      C6  Cumulative value moved never exceeds the policy's per-execution, hourly, daily and turnover limits.
///      C7  No Bucket operation can run while a settlement is in progress.
contract BucketController is IBucketController, IMakerHooks, ReentrancyGuardTransient {
    /// @notice Domain tag of Bucket identifiers.
    bytes32 public constant BUCKET_ID_DOMAIN = keccak256("BUCKET_ID_V1");
    /// @notice Domain tag of intent identifiers.
    bytes32 public constant INTENT_ID_DOMAIN = keccak256("BUCKET_INTENT_V1");

    /// @dev Transient slot holding the order hash of the settlement in progress.
    bytes32 private constant _EXECUTION_SLOT = keccak256("bucket.controller.execution");
    /// @dev Transient slot holding the Bucket of the settlement in progress.
    bytes32 private constant _EXECUTION_BUCKET_SLOT = keccak256("bucket.controller.execution.bucket");
    /// @dev Transient base slot of the pre-settlement balance snapshot (one slot per asset index).
    bytes32 private constant _SNAPSHOT_SLOT = keccak256("bucket.controller.snapshot");

    IAqua public immutable AQUA;
    address public immutable ROUTER;
    IBucketAuthority public immutable AUTHORITY;
    IBucketCapabilities public immutable CAPABILITIES;
    IBucketPriceFeed public immutable PRICE_FEED;

    mapping(bytes32 bucketId => BucketRecord) private _buckets;
    mapping(bytes32 intentId => Intent) private _intents;
    /// @notice The open Bucket a wallet token belongs to (C2).
    mapping(address holder => mapping(address token => bytes32 bucketId)) public assetClaim;

    modifier notExecuting() {
        require(_tload(_EXECUTION_SLOT) == 0, ExecutionInProgress());
        _;
    }

    constructor(
        IAqua aqua,
        address router,
        IBucketAuthority authority,
        IBucketCapabilities capabilities,
        IBucketPriceFeed priceFeed
    ) {
        require(
            address(aqua) != address(0) && router != address(0) && address(authority) != address(0)
                && address(capabilities) != address(0) && address(priceFeed) != address(0),
            ZeroAddress()
        );
        AQUA = aqua;
        ROUTER = router;
        AUTHORITY = authority;
        CAPABILITIES = capabilities;
        PRICE_FEED = priceFeed;
    }

    // =========================================================================================================
    // Lifecycle
    // =========================================================================================================

    /// @inheritdoc IBucketController
    function createBucket(CreateBucketParams calldata p) external nonReentrant notExecuting returns (bytes32 bucketId) {
        uint256 labelId = uint256(keccak256(bytes(p.label)));
        address owner = p.registry.getOwner(labelId);
        require(owner != address(0) && msg.sender == owner, NotBucketOwner(msg.sender, owner));

        bucketId = computeBucketId(p.registry, labelId);
        BucketRecord storage b = _buckets[bucketId];
        require(b.status == BucketStatus.NONE, BucketExists(bucketId));
        BucketPolicyLib.validate(p.params, p.assets);
        require(p.strategyExpiry > block.timestamp, StrategyExpiryInvalid(p.strategyExpiry));

        b.holder = msg.sender;
        b.status = BucketStatus.ACTIVE;
        b.policyVersion = 1;
        b.createdAt = uint40(block.timestamp);
        b.updatedAt = uint40(block.timestamp);
        b.suiObjectId = p.suiObjectId;
        b.params = p.params;
        for (uint256 i = 0; i < p.assets.length; ++i) {
            b.assets.push(p.assets[i]);
        }
        _claimAssets(bucketId, b);
        b.policyHash = BucketPolicyLib.hash(bucketId, 1, p.params, p.assets);
        b.strategyNonce = 1;
        b.strategyExpiry = p.strategyExpiry;
        b.strategyHash = keccak256(BucketEngine.program(address(this), bucketId, 1, p.strategyExpiry));

        AUTHORITY.bindBucket(bucketId, p.registry, p.label);

        emit BucketCreated(bucketId, msg.sender, address(p.registry), labelId, p.label, p.suiObjectId);
        emit BucketPolicyUpdated(bucketId, 1, b.policyHash);
        emit StrategyGenerationRotated(bucketId, 1, p.strategyExpiry, b.strategyHash);
    }

    /// @inheritdoc IBucketController
    function updatePolicy(bytes32 bucketId, PolicyParams calldata params, AssetConfig[] calldata assets)
        external
        nonReentrant
        notExecuting
    {
        BucketRecord storage b = _requireOpen(bucketId);
        _requireOwnerHolder(bucketId, b);
        BucketPolicyLib.validate(params, assets);

        _closeIntent(bucketId, b, IntentCloseReason.BUCKET_CHANGED);
        _releaseAssets(bucketId, b);
        delete b.assets;
        for (uint256 i = 0; i < assets.length; ++i) {
            b.assets.push(assets[i]);
        }
        _claimAssets(bucketId, b);
        b.params = params;
        uint32 version = b.policyVersion + 1;
        b.policyVersion = version;
        b.updatedAt = uint40(block.timestamp);
        b.policyHash = BucketPolicyLib.hash(bucketId, version, params, assets);

        emit BucketPolicyUpdated(bucketId, version, b.policyHash);
    }

    /// @inheritdoc IBucketController
    function setStatus(bytes32 bucketId, BucketStatus status) external nonReentrant notExecuting {
        BucketRecord storage b = _requireOpen(bucketId);
        BucketStatus current = b.status;
        require(
            status != current
                && (status == BucketStatus.ACTIVE || status == BucketStatus.PAUSED || status == BucketStatus.CLOSED),
            InvalidStatusTransition(current, status)
        );
        if (status == BucketStatus.ACTIVE) {
            // Resuming delegated execution requires the ENSv2 owner, who must still be the holder.
            _requireOwnerHolder(bucketId, b);
        } else {
            // The holder can always stop execution over its own wallet, even after losing the ENSv2 name.
            require(msg.sender == b.holder, NotBucketOwner(msg.sender, b.holder));
            _closeIntent(bucketId, b, IntentCloseReason.BUCKET_CHANGED);
            if (status == BucketStatus.CLOSED) _releaseAssets(bucketId, b);
        }
        b.status = status;
        b.updatedAt = uint40(block.timestamp);
        emit BucketStatusUpdated(bucketId, status, msg.sender);
    }

    /// @inheritdoc IBucketController
    function pause(bytes32 bucketId) external nonReentrant notExecuting {
        BucketRecord storage b = _requireActive(bucketId);
        require(
            msg.sender == b.holder || msg.sender == AUTHORITY.ownerOf(bucketId)
                || AUTHORITY.isGuardian(bucketId, msg.sender),
            NotOwnerOrGuardian(msg.sender)
        );
        _closeIntent(bucketId, b, IntentCloseReason.BUCKET_CHANGED);
        b.status = BucketStatus.PAUSED;
        b.updatedAt = uint40(block.timestamp);
        emit BucketStatusUpdated(bucketId, BucketStatus.PAUSED, msg.sender);
    }

    /// @inheritdoc IBucketController
    function setSuiObject(bytes32 bucketId, bytes32 suiObjectId) external nonReentrant notExecuting {
        BucketRecord storage b = _requireOpen(bucketId);
        _requireOwnerHolder(bucketId, b);
        b.suiObjectId = suiObjectId;
        b.updatedAt = uint40(block.timestamp);
        emit BucketSuiObjectBound(bucketId, suiObjectId);
    }

    /// @inheritdoc IBucketController
    function rotateStrategies(bytes32 bucketId, uint40 strategyExpiry) external nonReentrant notExecuting {
        BucketRecord storage b = _requireOpen(bucketId);
        require(msg.sender == b.holder, NotBucketOwner(msg.sender, b.holder));
        require(strategyExpiry > block.timestamp, StrategyExpiryInvalid(strategyExpiry));
        uint32 nonce = b.strategyNonce + 1;
        b.strategyNonce = nonce;
        b.strategyExpiry = strategyExpiry;
        b.strategyHash = keccak256(BucketEngine.program(address(this), bucketId, nonce, strategyExpiry));
        b.updatedAt = uint40(block.timestamp);
        emit StrategyGenerationRotated(bucketId, nonce, strategyExpiry, b.strategyHash);
    }

    // =========================================================================================================
    // Intents
    // =========================================================================================================

    /// @inheritdoc IBucketController
    function openRebalanceIntent(bytes32 bucketId, bytes32 capabilityId)
        external
        nonReentrant
        notExecuting
        returns (bytes32 intentId)
    {
        BucketRecord storage b = _requireActive(bucketId);
        CAPABILITIES.requireAuthorized(capabilityId, msg.sender, BucketPermissions.PERM_REBALANCE, 0, VENUE_AQUA_SWAPVM);
        BucketSnapshot memory s = _snapshot(bucketId, b);
        uint256 maxValue = _maxValue(_limits(b, capabilityId, BucketEngine.totalValue(s.assets)));
        require(maxValue > 0, LimitsExhausted(bucketId, capabilityId));

        // The leg is selected among the capability's assets only, so it is within the capability by construction.
        (uint8 assetMask, uint40 validUntil) = _capabilityScope(capabilityId);
        (uint256 outIndex, uint256 inIndex, uint256 budgetOut, uint256 maxDeviationWad) =
            BucketEngine.planRebalance(bucketId, s.assets, b.params, assetMask, maxValue);

        intentId = _openIntent(
            bucketId,
            b,
            capabilityId,
            IntentKind.REBALANCE,
            s.assets[outIndex].token,
            s.assets[inIndex].token,
            budgetOut,
            validUntil,
            maxDeviationWad
        );
    }

    /// @inheritdoc IBucketController
    function openSwapIntent(bytes32 bucketId, bytes32 capabilityId, address tokenOut, address tokenIn, uint256 amountOut)
        external
        nonReentrant
        notExecuting
        returns (bytes32 intentId)
    {
        BucketRecord storage b = _requireActive(bucketId);
        BucketEngine.validateSwapIntent(bucketId, b, _context(), capabilityId, tokenOut, tokenIn, amountOut);
        (, uint40 validUntil) = _capabilityScope(capabilityId);
        intentId = _openIntent(bucketId, b, capabilityId, IntentKind.SWAP, tokenOut, tokenIn, amountOut, validUntil, 0);
    }

    /// @inheritdoc IBucketController
    function cancelIntent(bytes32 bucketId) external nonReentrant notExecuting {
        BucketRecord storage b = _requireBucket(bucketId);
        bytes32 intentId = b.activeIntent;
        require(intentId != bytes32(0), NoOpenIntent(bucketId));
        address operator = _intents[intentId].operator;
        require(
            msg.sender == operator || msg.sender == b.holder || msg.sender == AUTHORITY.ownerOf(bucketId)
                || AUTHORITY.isGuardian(bucketId, msg.sender),
            NotIntentOperator(msg.sender, operator)
        );
        _closeIntent(bucketId, b, IntentCloseReason.CANCELLED);
    }

    // =========================================================================================================
    // Payments
    // =========================================================================================================

    /// @inheritdoc IBucketController
    function pay(bytes32 bucketId, bytes32 capabilityId, address token, uint256 amount)
        external
        nonReentrant
        notExecuting
        returns (bytes32 receiptHash)
    {
        BucketRecord storage b = _requireActive(bucketId);
        ExecutionReceipt memory r =
            BucketEngine.executePayment(bucketId, b, _context(), capabilityId, token, amount, _SNAPSHOT_SLOT);
        receiptHash = _recordReceipt(bucketId, b, r);
    }

    // =========================================================================================================
    // SwapVM maker hooks (settlement verification)
    // =========================================================================================================

    /// @notice Snapshots holder balances immediately before the Aqua `pull` of `tokenOut`.
    function preTransferOut(
        address maker,
        address,
        address tokenIn,
        address tokenOut,
        uint256,
        uint256,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata
    ) external {
        require(msg.sender == ROUTER, OnlyRouter(msg.sender));
        require(_tload(_EXECUTION_SLOT) == 0, ExecutionInProgress());
        bytes32 bucketId = abi.decode(makerData, (bytes32));
        BucketRecord storage b = _requireActive(bucketId);
        require(maker == b.holder, MakerMismatch(b.holder, maker));
        require(_isCanonical(bucketId, b, orderHash, tokenIn, tokenOut), StrategyNotCanonical(orderHash));
        require(b.activeIntent != bytes32(0), NoOpenIntent(bucketId));

        _tstore(_EXECUTION_SLOT, uint256(orderHash));
        _tstore(_EXECUTION_BUCKET_SLOT, uint256(bucketId));
        uint256 count = b.assets.length;
        for (uint256 i = 0; i < count; ++i) {
            _tstore(bytes32(uint256(_SNAPSHOT_SLOT) + i), IERC20(b.assets[i].token).balanceOf(maker));
        }
    }

    /// @notice Verifies the settled state after the operator's Aqua `push`, charges limits and records the receipt.
    function postTransferIn(
        address maker,
        address taker,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 amountOut,
        uint256 feeIn,
        bytes32 orderHash,
        bytes calldata makerData,
        bytes calldata
    ) external {
        require(msg.sender == ROUTER, OnlyRouter(msg.sender));
        require(_tload(_EXECUTION_SLOT) == uint256(orderHash), SnapshotMissing(orderHash));
        require(feeIn == 0, UnexpectedFee(feeIn));
        bytes32 bucketId = abi.decode(makerData, (bytes32));
        require(_tload(_EXECUTION_BUCKET_SLOT) == uint256(bucketId), SnapshotMissing(orderHash));
        BucketRecord storage b = _buckets[bucketId];
        require(maker == b.holder, MakerMismatch(b.holder, maker));
        bytes32 intentId = b.activeIntent;
        Intent storage intent = _intents[intentId];

        // Post-state: exact deltas (C4) and the intent kind's allocation invariant (C5).
        BucketSnapshot memory post = _snapshot(bucketId, b);
        ExecutionReceipt memory r =
            BucketEngine.settle(bucketId, b.holder, post.assets, tokenOut, tokenIn, amountOut, amountIn, _SNAPSHOT_SLOT);
        bool withinPolicy = BucketEngine.requireAllocationInvariant(
            intent.kind, post.assets, b.params, r.preBalances, r.postBalances, tokenOut, tokenIn
        );

        r.kind = intent.kind == IntentKind.REBALANCE ? ExecutionKind.REBALANCE : ExecutionKind.SWAP;
        r.capabilityId = intent.capabilityId;
        r.intentId = intentId;
        r.orderHash = orderHash;
        r.operator = taker;
        r.recipient = taker;

        // Effects: velocity is charged (and re-checked) on the Bucket and every capability of the chain (C6).
        _chargeBucket(b, r.valueOut, r.preTotalValue);
        CAPABILITIES.consume(intent.capabilityId, r.valueOut);
        intent.remainingOut -= amountOut;
        _recordReceipt(bucketId, b, r);

        _tstore(_EXECUTION_SLOT, 0);
        _tstore(_EXECUTION_BUCKET_SLOT, 0);

        bool rebalanced = intent.kind == IntentKind.REBALANCE && withinPolicy;
        if (intent.remainingOut == 0 || rebalanced) _closeIntent(bucketId, b, IntentCloseReason.FULFILLED);
    }

    function preTransferIn(address, address, address, address, uint256, uint256, bytes32, bytes calldata, bytes calldata)
        external
        pure
    {
        revert UnsupportedHook();
    }

    function postTransferOut(
        address,
        address,
        address,
        address,
        uint256,
        uint256,
        uint256,
        bytes32,
        bytes calldata,
        bytes calldata
    ) external pure {
        revert UnsupportedHook();
    }

    // =========================================================================================================
    // Views
    // =========================================================================================================

    /// @inheritdoc IBucketController
    function computeBucketId(IPermissionedRegistry registry, uint256 labelId) public view returns (bytes32) {
        return keccak256(abi.encode(BUCKET_ID_DOMAIN, block.chainid, address(this), address(registry), labelId));
    }

    /// @inheritdoc IBucketController
    function loadBucket(bytes32 bucketId) external view returns (BucketSnapshot memory) {
        return _snapshot(bucketId, _requireBucket(bucketId));
    }

    /// @inheritdoc IBucketController
    function getBucket(bytes32 bucketId) external view returns (BucketMeta memory m) {
        BucketRecord storage b = _requireBucket(bucketId);
        m.holder = b.holder;
        m.status = b.status;
        m.policyVersion = b.policyVersion;
        m.createdAt = b.createdAt;
        m.updatedAt = b.updatedAt;
        m.executionNonce = b.executionNonce;
        m.intentNonce = b.intentNonce;
        m.strategyNonce = b.strategyNonce;
        m.strategyExpiry = b.strategyExpiry;
        m.policyHash = b.policyHash;
        m.strategyHash = b.strategyHash;
        m.activeIntent = b.activeIntent;
        m.lastReceipt = b.lastReceipt;
        m.suiObjectId = b.suiObjectId;
        m.usage = b.usage;
    }

    /// @inheritdoc IBucketController
    function getPolicy(bytes32 bucketId) external view returns (PolicyParams memory params, AssetConfig[] memory assets) {
        BucketRecord storage b = _requireBucket(bucketId);
        return (b.params, b.assets);
    }

    /// @inheritdoc IBucketController
    function getIntent(bytes32 intentId) external view returns (Intent memory) {
        return _intents[intentId];
    }

    /// @inheritdoc IBucketController
    function loadFrame(bytes32 bucketId, bytes32 orderHash, address tokenIn, address tokenOut)
        external
        view
        returns (ExecutionFrame memory frame)
    {
        BucketRecord storage b = _requireBucket(bucketId);
        frame.bucket = _snapshot(bucketId, b);
        frame.intent = _intents[b.activeIntent];
        frame.strategyActive = _isCanonical(bucketId, b, orderHash, tokenIn, tokenOut);
        if (frame.intent.capabilityId != bytes32(0)) {
            frame.limits = _limits(b, frame.intent.capabilityId, BucketEngine.totalValue(frame.bucket.assets));
        }
    }

    /// @inheritdoc IBucketController
    function effectiveLimits(bytes32 bucketId, bytes32 capabilityId) external view returns (EffectiveLimits memory) {
        BucketRecord storage b = _requireBucket(bucketId);
        return _limits(b, capabilityId, BucketEngine.totalValue(_snapshot(bucketId, b).assets));
    }

    /// @inheritdoc IBucketController
    function policyContext(bytes32 bucketId)
        external
        view
        returns (BucketStatus status, address holder, uint32 policyVersion, PolicyParams memory params, uint256 assetCount)
    {
        BucketRecord storage b = _buckets[bucketId];
        return (b.status, b.holder, b.policyVersion, b.params, b.assets.length);
    }

    /// @inheritdoc IBucketController
    function strategyOrder(bytes32 bucketId, address tokenX, address tokenY)
        external
        view
        returns (ISwapVM.Order memory order, bytes32 orderHash)
    {
        BucketRecord storage b = _requireBucket(bucketId);
        require(tokenX != tokenY, SameAsset(tokenX));
        require(_isAsset(b, tokenX), AssetNotAllowed(bucketId, tokenX));
        require(_isAsset(b, tokenY), AssetNotAllowed(bucketId, tokenY));
        order = BucketEngine.strategyOrder(
            address(this), bucketId, b.holder, b.strategyNonce, b.strategyExpiry, tokenX, tokenY
        );
        orderHash = keccak256(abi.encode(order));
    }

    /// @inheritdoc IBucketController
    function strategyProgram(bytes32 bucketId) external view returns (bytes memory) {
        BucketRecord storage b = _requireBucket(bucketId);
        return BucketEngine.program(address(this), bucketId, b.strategyNonce, b.strategyExpiry);
    }

    // =========================================================================================================
    // Internal: strategies and capabilities
    // =========================================================================================================

    /// @dev True when `orderHash` is the canonical strategy of the current generation for the fill's pair.
    function _isCanonical(bytes32 bucketId, BucketRecord storage b, bytes32 orderHash, address tokenIn, address tokenOut)
        private
        view
        returns (bool)
    {
        if (tokenIn == tokenOut || !_isAsset(b, tokenIn) || !_isAsset(b, tokenOut)) return false;
        return BucketEngine.strategyHash(
            address(this), bucketId, b.holder, b.strategyNonce, b.strategyExpiry, tokenIn, tokenOut
        ) == orderHash;
    }

    /// @dev Asset scope and expiry of a capability's leaf (the chain is validated separately).
    function _capabilityScope(bytes32 capabilityId) private view returns (uint8 assetMask, uint40 validUntil) {
        Capability memory c = CAPABILITIES.getCapability(capabilityId);
        return (c.assetMask, c.validUntil);
    }

    // =========================================================================================================
    // Internal: intents
    // =========================================================================================================

    function _openIntent(
        bytes32 bucketId,
        BucketRecord storage b,
        bytes32 capabilityId,
        IntentKind kind,
        address tokenOut,
        address tokenIn,
        uint256 amountOut,
        uint40 capabilityValidUntil,
        uint256 maxDeviationWad
    ) private returns (bytes32 intentId) {
        _closeIntent(bucketId, b, IntentCloseReason.SUPERSEDED);

        uint64 nonce = ++b.intentNonce;
        intentId = keccak256(abi.encode(INTENT_ID_DOMAIN, bucketId, nonce));
        uint256 auctionEnd = block.timestamp + b.params.auctionDuration;
        Intent memory intent = Intent({
            bucketId: bucketId,
            capabilityId: capabilityId,
            operator: msg.sender,
            kind: kind,
            tokenOut: tokenOut,
            tokenIn: tokenIn,
            remainingOut: amountOut,
            openedAt: uint40(block.timestamp),
            expiresAt: uint40(Math.min(auctionEnd, capabilityValidUntil)),
            policyVersion: b.policyVersion,
            nonce: nonce
        });
        _intents[intentId] = intent;
        b.activeIntent = intentId;
        b.updatedAt = uint40(block.timestamp);
        emit IntentOpened(bucketId, intentId, capabilityId, intent, maxDeviationWad);
    }

    function _closeIntent(bytes32 bucketId, BucketRecord storage b, IntentCloseReason reason) private {
        bytes32 intentId = b.activeIntent;
        if (intentId == bytes32(0)) return;
        b.activeIntent = bytes32(0);
        emit IntentClosed(bucketId, intentId, reason);
    }

    // =========================================================================================================
    // Internal: limits
    // =========================================================================================================

    function _limits(BucketRecord storage b, bytes32 capabilityId, uint256 total)
        private
        view
        returns (EffectiveLimits memory)
    {
        return BucketEngine.limits(b, CAPABILITIES, capabilityId, total);
    }

    function _maxValue(EffectiveLimits memory l) private pure returns (uint256) {
        return BucketEngine.maxValue(l);
    }

    /// @dev Charges `value` to the Bucket-wide windows, re-checking the policy limits at settlement (C6).
    function _chargeBucket(BucketRecord storage b, uint256 value, uint256 total) private {
        BucketEngine.chargeBucket(b, value, total);
    }

    // =========================================================================================================
    // Internal: receipts and snapshots
    // =========================================================================================================

    function _recordReceipt(bytes32 bucketId, BucketRecord storage b, ExecutionReceipt memory r)
        private
        returns (bytes32 receiptHash)
    {
        r.executionNonce = ++b.executionNonce;
        r.policyVersion = b.policyVersion;
        r.policyHash = b.policyHash;
        r.strategyHash = b.strategyHash;
        r.timestamp = uint40(block.timestamp);
        receiptHash = keccak256(abi.encode(r));
        b.lastReceipt = receiptHash;
        b.updatedAt = uint40(block.timestamp);
        emit ExecutionRecorded(bucketId, r.executionNonce, r.capabilityId, r, receiptHash);
    }

    function _context() private view returns (BucketEngine.Context memory) {
        return BucketEngine.Context({ authority: address(AUTHORITY), capabilities: CAPABILITIES, priceFeed: PRICE_FEED });
    }

    function _snapshot(bytes32 bucketId, BucketRecord storage b) private view returns (BucketSnapshot memory) {
        return BucketEngine.snapshot(bucketId, b, address(AUTHORITY), address(CAPABILITIES), PRICE_FEED);
    }

    // =========================================================================================================
    // Internal: access and assets
    // =========================================================================================================

    function _requireBucket(bytes32 bucketId) private view returns (BucketRecord storage b) {
        b = _buckets[bucketId];
        require(b.status != BucketStatus.NONE, BucketNotFound(bucketId));
    }

    function _requireOpen(bytes32 bucketId) private view returns (BucketRecord storage b) {
        b = _requireBucket(bucketId);
        require(b.status != BucketStatus.CLOSED, BucketClosed(bucketId));
    }

    function _requireActive(bytes32 bucketId) private view returns (BucketRecord storage b) {
        b = _requireBucket(bucketId);
        require(b.status == BucketStatus.ACTIVE, BucketNotActive(bucketId, b.status));
    }

    /// @dev The caller must be the live ENSv2 owner and the holder: authority and custody coincide.
    function _requireOwnerHolder(bytes32 bucketId, BucketRecord storage b) private view {
        address owner = AUTHORITY.ownerOf(bucketId);
        require(owner != address(0) && msg.sender == owner, NotBucketOwner(msg.sender, owner));
        require(owner == b.holder, HolderIsNotOwner(b.holder, owner));
    }

    function _claimAssets(bytes32 bucketId, BucketRecord storage b) private {
        address holder = b.holder;
        uint256 count = b.assets.length;
        for (uint256 i = 0; i < count; ++i) {
            address token = b.assets[i].token;
            bytes32 claimed = assetClaim[holder][token];
            require(claimed == bytes32(0) || claimed == bucketId, AssetClaimedByBucket(token, claimed));
            assetClaim[holder][token] = bucketId;
        }
    }

    function _releaseAssets(bytes32 bucketId, BucketRecord storage b) private {
        address holder = b.holder;
        uint256 count = b.assets.length;
        for (uint256 i = 0; i < count; ++i) {
            address token = b.assets[i].token;
            if (assetClaim[holder][token] == bucketId) delete assetClaim[holder][token];
        }
    }

    function _isAsset(BucketRecord storage b, address token) private view returns (bool) {
        uint256 count = b.assets.length;
        for (uint256 i = 0; i < count; ++i) {
            if (b.assets[i].token == token) return true;
        }
        return false;
    }

    // =========================================================================================================
    // Internal: transient storage
    // =========================================================================================================

    function _tload(bytes32 slot) private view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }

    function _tstore(bytes32 slot, uint256 value) private {
        assembly ("memory-safe") {
            tstore(slot, value)
        }
    }
}
