// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/contracts/libs/MakerTraits.sol";
import { Deadline, Salt } from "@1inch/swap-vm/contracts/instructions/Controls.sol";

import { IBucketCapabilities } from "../interfaces/IBucketCapabilities.sol";
import { IBucketController } from "../interfaces/IBucketController.sol";
import { IBucketPriceFeed } from "../interfaces/IBucketPriceFeed.sol";
import { BucketCapabilityGuard } from "../vm/BucketCapabilityGuard.sol";
import { BucketQuote } from "../vm/BucketQuote.sol";
import { BucketSpendLimit } from "../vm/BucketSpendLimit.sol";
import { BucketWalletBalanceCheck } from "../vm/BucketWalletBalanceCheck.sol";
import {
    BPS,
    AssetConfig,
    AssetState,
    BucketRecord,
    BucketSnapshot,
    EffectiveLimits,
    ExecutionKind,
    ExecutionReceipt,
    IntentKind,
    PolicyParams,
    Usage,
    VENUE_AQUA_SWAPVM
} from "../types/BucketTypes.sol";
import { BucketMath } from "./BucketMath.sol";
import { BucketPermissions } from "./BucketPermissions.sol";
import { UsageLib } from "./CapabilityLib.sol";

/// @title BucketEngine
/// @notice Linked (DELEGATECALL) library holding the controller's heavy deterministic logic: the policy compiler's
///         final stage (Bucket program and canonical Aqua strategies), rebalance planning, and settlement
///         verification. Running in the controller's context, `settle` reads the controller's transient
///         pre-settlement snapshot directly.
library BucketEngine {
    using SafeERC20 for IERC20;
    using UsageLib for Usage;

    /// @notice Immutable collaborators of the controller, passed into the delegatecalled engine.
    struct Context {
        address authority;
        IBucketCapabilities capabilities;
        IBucketPriceFeed priceFeed;
    }

    // =========================================================================================================
    // Delegated operations
    // =========================================================================================================

    /// @notice Validates a swap intent (`PERM_SWAP`, assets, holder balance, limits) before it is opened.
    function validateSwapIntent(
        bytes32 bucketId,
        BucketRecord storage b,
        Context memory ctx,
        bytes32 capabilityId,
        address tokenOut,
        address tokenIn,
        uint256 amountOut
    ) public view {
        require(amountOut > 0, IBucketController.ZeroAmount());
        require(tokenOut != tokenIn, IBucketController.SameAsset(tokenOut));
        BucketSnapshot memory s = snapshot(bucketId, b, ctx.authority, address(ctx.capabilities), ctx.priceFeed);
        BucketMath.requireFreshPrices(s.assets, b.params.maxPriceAge);
        uint256 outIndex = _assetIndex(bucketId, s.assets, tokenOut);
        uint256 inIndex = _assetIndex(bucketId, s.assets, tokenIn);
        ctx.capabilities.requireAuthorized(
            capabilityId, msg.sender, BucketPermissions.PERM_SWAP, _mask(outIndex, inIndex), VENUE_AQUA_SWAPVM
        );

        AssetState memory assetOut = s.assets[outIndex];
        require(
            amountOut <= assetOut.balance,
            IBucketController.InsufficientHolderBalance(tokenOut, assetOut.balance, amountOut)
        );
        uint256 value = BucketMath.valueOf(amountOut, assetOut.decimals, assetOut.priceWad, Math.Rounding.Ceil);
        uint256 max = maxValue(limits(b, ctx.capabilities, capabilityId, totalValue(s.assets)));
        require(value <= max, IBucketController.SpendLimitExceeded(value, max));
    }

    /// @notice Executes a capability-bound payment from the holder's wallet to the capability's fixed payee.
    /// @dev Checks -> effects (Bucket and capability-chain velocity) -> interaction (holder allowance only) ->
    ///      post-condition (exactly `amount` left the holder, nothing else moved).
    function executePayment(
        bytes32 bucketId,
        BucketRecord storage b,
        Context memory ctx,
        bytes32 capabilityId,
        address token,
        uint256 amount,
        bytes32 snapshotSlot
    ) public returns (ExecutionReceipt memory r) {
        require(amount > 0, IBucketController.ZeroAmount());
        BucketSnapshot memory s = snapshot(bucketId, b, ctx.authority, address(ctx.capabilities), ctx.priceFeed);
        BucketMath.requireFreshPrices(s.assets, b.params.maxPriceAge);
        uint256 index = _assetIndex(bucketId, s.assets, token);
        ctx.capabilities.requireAuthorized(capabilityId, msg.sender, BucketPermissions.PERM_PAY, _mask(index, index), 0);
        address payee = ctx.capabilities.getCapability(capabilityId).payee;

        AssetState memory asset = s.assets[index];
        require(amount <= asset.balance, IBucketController.InsufficientHolderBalance(token, asset.balance, amount));
        uint256 total = totalValue(s.assets);
        uint256 value = BucketMath.valueOf(amount, asset.decimals, asset.priceWad, Math.Rounding.Ceil);
        uint256 max = maxValue(limits(b, ctx.capabilities, capabilityId, total));
        require(value <= max, IBucketController.SpendLimitExceeded(value, max));

        chargeBucket(b, value, total);
        ctx.capabilities.consume(capabilityId, value);

        IERC20(token).safeTransferFrom(b.holder, payee, amount);

        r = settle(bucketId, b.holder, s.assets, token, address(0), amount, 0, snapshotSlot);
        r.kind = ExecutionKind.PAY;
        r.capabilityId = capabilityId;
        r.operator = msg.sender;
        r.recipient = payee;
    }

    // =========================================================================================================
    // Snapshots and limits (operate directly on the controller's storage)
    // =========================================================================================================

    /// @notice Live read model of a Bucket: holder balances of every policy asset at reference prices.
    /// @dev A missing price reads as zero; every consumer that needs prices enforces `requireFreshPrices`.
    function snapshot(
        bytes32 bucketId,
        BucketRecord storage b,
        address authority,
        address capabilities,
        IBucketPriceFeed priceFeed
    ) public view returns (BucketSnapshot memory s) {
        s.bucketId = bucketId;
        s.holder = b.holder;
        s.authority = authority;
        s.capabilities = capabilities;
        s.status = b.status;
        s.policyVersion = b.policyVersion;
        s.policyHash = b.policyHash;
        s.strategyHash = b.strategyHash;
        s.activeIntent = b.activeIntent;
        s.params = b.params;

        uint256 count = b.assets.length;
        s.assets = new AssetState[](count);
        for (uint256 i = 0; i < count; ++i) {
            AssetConfig memory config = b.assets[i];
            (uint256 priceWad, uint64 updatedAt) = _price(priceFeed, config.token);
            s.assets[i] = AssetState({
                token: config.token,
                decimals: config.decimals,
                targetBps: config.targetBps,
                minBps: config.minBps,
                maxBps: config.maxBps,
                balance: IERC20(config.token).balanceOf(b.holder),
                priceWad: priceWad,
                priceUpdatedAt: updatedAt
            });
        }
    }

    /// @notice Tightest bound of the next execution over the policy, the Bucket-wide usage and the capability chain.
    function limits(BucketRecord storage b, IBucketCapabilities capabilities, bytes32 capabilityId, uint256 total)
        public
        view
        returns (EffectiveLimits memory l)
    {
        l = capabilities.chainLimits(capabilityId, total);
        PolicyParams memory p = b.params;
        Usage memory u = b.usage;
        uint256 daySpent = u.daySpent(block.timestamp);
        l.maxExecutionValue = Math.min(l.maxExecutionValue, p.maxExecutionValue);
        l.remainingHourlyValue =
            Math.min(l.remainingHourlyValue, UsageLib.remaining(p.maxHourlyValue, u.hourSpent(block.timestamp)));
        l.remainingDailyValue = Math.min(l.remainingDailyValue, UsageLib.remaining(p.maxDailyValue, daySpent));
        l.remainingTurnoverValue = Math.min(
            l.remainingTurnoverValue, UsageLib.remaining(Math.mulDiv(total, p.maxDailyTurnoverBps, BPS), daySpent)
        );
        if (p.maxSlippageBps < l.maxSlippageBps) l.maxSlippageBps = p.maxSlippageBps;
    }

    /// @notice The single largest value the next execution may move.
    function maxValue(EffectiveLimits memory l) public pure returns (uint256) {
        return Math.min(
            Math.min(l.maxExecutionValue, l.remainingHourlyValue),
            Math.min(l.remainingDailyValue, l.remainingTurnoverValue)
        );
    }

    /// @notice Charges `value` to the Bucket-wide windows, re-checking the policy limits at settlement.
    function chargeBucket(BucketRecord storage b, uint256 value, uint256 total) public {
        PolicyParams memory p = b.params;
        Usage memory u = b.usage;
        uint256 daySpent = u.daySpent(block.timestamp);
        uint256 remaining = Math.min(
            Math.min(p.maxExecutionValue, UsageLib.remaining(p.maxHourlyValue, u.hourSpent(block.timestamp))),
            Math.min(
                UsageLib.remaining(p.maxDailyValue, daySpent),
                UsageLib.remaining(Math.mulDiv(total, p.maxDailyTurnoverBps, BPS), daySpent)
            )
        );
        require(value <= remaining, IBucketController.BucketVelocityExceeded(value, remaining));
        b.usage.charge(value, block.timestamp);
    }
    // =========================================================================================================
    // Strategy compilation
    // =========================================================================================================

    /// @notice The canonical Bucket SwapVM program of a strategy generation (see `BucketOpcodes`).
    function program(address controller, bytes32 bucketId, uint32 strategyNonce, uint40 strategyExpiry)
        public
        pure
        returns (bytes memory)
    {
        return bytes.concat(
            Deadline.build(strategyExpiry),
            Salt.build(uint64(strategyNonce)),
            BucketCapabilityGuard.build(controller, bucketId),
            BucketQuote.build(controller, bucketId),
            BucketSpendLimit.build(controller, bucketId),
            BucketWalletBalanceCheck.build(controller, bucketId)
        );
    }

    /// @notice The canonical Aqua strategy for a pair: maker = holder, Aqua settlement, both verification hooks on
    ///         the controller with the Bucket id as maker hook data, no receiver override and no other hooks.
    function strategyOrder(
        address controller,
        bytes32 bucketId,
        address holder,
        uint32 strategyNonce,
        uint40 strategyExpiry,
        address tokenX,
        address tokenY
    ) public pure returns (ISwapVM.Order memory) {
        (address tokenA, address tokenB) = tokenX < tokenY ? (tokenX, tokenY) : (tokenY, tokenX);
        bytes memory hookData = abi.encode(bucketId);
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: holder,
                receiver: address(0),
                tokenA: tokenA,
                tokenB: tokenB,
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: true,
                hasPreTransferOutHook: true,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: controller,
                postTransferInData: hookData,
                preTransferOutTarget: controller,
                preTransferOutData: hookData,
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program(controller, bucketId, strategyNonce, strategyExpiry)
            })
        );
    }

    /// @notice Aqua strategy hash (= SwapVM Aqua-mode order hash) of the canonical strategy for a pair.
    function strategyHash(
        address controller,
        bytes32 bucketId,
        address holder,
        uint32 strategyNonce,
        uint40 strategyExpiry,
        address tokenX,
        address tokenY
    ) public pure returns (bytes32) {
        return keccak256(
            abi.encode(strategyOrder(controller, bucketId, holder, strategyNonce, strategyExpiry, tokenX, tokenY))
        );
    }

    // =========================================================================================================
    // Rebalance planning
    // =========================================================================================================

    /// @notice The policy-computed rebalance leg among `assetMask`: sell the most overweight asset for the most
    ///         underweight one, sized at `min(excess, deficit, valueCap)`.
    function planRebalance(
        bytes32 bucketId,
        AssetState[] memory assets,
        PolicyParams memory params,
        uint8 assetMask,
        uint256 valueCap
    ) public view returns (uint256 outIndex, uint256 inIndex, uint256 budgetOut, uint256 maxDeviationWad) {
        BucketMath.requireFreshPrices(assets, params.maxPriceAge);
        BucketMath.Valuation memory v = BucketMath.valuate(assets);
        maxDeviationWad = v.maxAbsDeviationWad;
        require(
            BucketMath.isOutOfPolicy(assets, params, v), IBucketController.WithinPolicy(bucketId, maxDeviationWad)
        );
        (outIndex, inIndex) = BucketMath.selectLeg(v, assetMask);
        require(
            outIndex != type(uint256).max && inIndex != type(uint256).max,
            IBucketController.NothingToRebalance(bucketId)
        );
        AssetState memory assetOut = assets[outIndex];
        uint256 tradeValue = Math.min(
            Math.min(
                BucketMath.excessValue(v, assetOut.targetBps, outIndex),
                BucketMath.deficitValue(v, assets[inIndex].targetBps, inIndex)
            ),
            valueCap
        );
        budgetOut = BucketMath.amountOf(tradeValue, assetOut.decimals, assetOut.priceWad, Math.Rounding.Floor);
        require(budgetOut > 0, IBucketController.NothingToRebalance(bucketId));
    }

    // =========================================================================================================
    // Settlement verification
    // =========================================================================================================

    /// @notice Verifies exact balance deltas of a settlement and builds the state part of its receipt.
    /// @param reference_ Swaps: the post-settlement snapshot (pre-balances come from the controller's transient
    ///        snapshot at `snapshotSlot`). Payments (`tokenIn == address(0)`): the pre-payment snapshot (post-balances
    ///        are read live).
    function settle(
        bytes32 bucketId,
        address holder,
        AssetState[] memory reference_,
        address tokenOut,
        address tokenIn,
        uint256 amountOut,
        uint256 amountIn,
        bytes32 snapshotSlot
    ) public view returns (ExecutionReceipt memory r) {
        bool isSwap = tokenIn != address(0);
        uint256 count = reference_.length;
        r.preBalances = new uint256[](count);
        r.postBalances = new uint256[](count);
        r.pricesWad = new uint256[](count);
        bool outSeen;
        bool inSeen = !isSwap;
        for (uint256 i = 0; i < count; ++i) {
            AssetState memory asset = reference_[i];
            uint256 pre = isSwap ? _tload(bytes32(uint256(snapshotSlot) + i)) : asset.balance;
            uint256 post = isSwap ? asset.balance : IERC20(asset.token).balanceOf(holder);
            uint256 expected = pre;
            if (asset.token == tokenOut) {
                expected = pre - amountOut;
                outSeen = true;
            } else if (isSwap && asset.token == tokenIn) {
                expected = pre + amountIn;
                inSeen = true;
            }
            require(post == expected, IBucketController.BalanceDeltaMismatch(asset.token, expected, post));
            r.preBalances[i] = pre;
            r.postBalances[i] = post;
            r.pricesWad[i] = asset.priceWad;
        }
        require(outSeen, IBucketController.AssetNotAllowed(bucketId, tokenOut));
        require(inSeen, IBucketController.AssetNotAllowed(bucketId, tokenIn));

        (r.preTotalValue, r.preMaxDeviationWad) = _summary(reference_, r.preBalances);
        (r.postTotalValue, r.postMaxDeviationWad) = _summary(reference_, r.postBalances);
        r.bucketId = bucketId;
        r.tokenOut = tokenOut;
        r.tokenIn = tokenIn;
        r.amountOut = amountOut;
        r.amountIn = amountIn;
        r.preStateHash = BucketMath.stateHash(r.preBalances, r.pricesWad);
        r.postStateHash = BucketMath.stateHash(r.postBalances, r.pricesWad);
        uint256 outIndex = BucketMath.indexOf(reference_, tokenOut);
        r.valueOut = BucketMath.valueOf(
            amountOut, reference_[outIndex].decimals, reference_[outIndex].priceWad, Math.Rounding.Ceil
        );
    }

    /// @notice Post-state invariant of a swap settlement. REBALANCE: neither traded asset nor the Bucket moves away
    ///         from target. SWAP: both traded assets end inside their hard bands.
    /// @return withinPolicy True when the post-state no longer requires a rebalance
    function requireAllocationInvariant(
        IntentKind kind,
        AssetState[] memory assets,
        PolicyParams memory params,
        uint256[] memory preBalances,
        uint256[] memory postBalances,
        address tokenOut,
        address tokenIn
    ) public pure returns (bool withinPolicy) {
        uint256 outIndex = BucketMath.indexOf(assets, tokenOut);
        uint256 inIndex = BucketMath.indexOf(assets, tokenIn);
        BucketMath.Valuation memory pre = BucketMath.valuateAt(assets, preBalances);
        BucketMath.Valuation memory post = BucketMath.valuateAt(assets, postBalances);
        if (kind == IntentKind.REBALANCE) {
            require(
                BucketMath.improves(pre, post, outIndex, inIndex),
                IBucketController.PostStateNotImproved(pre.maxAbsDeviationWad, post.maxAbsDeviationWad)
            );
        } else {
            require(
                BucketMath.withinBand(assets[outIndex], post, outIndex),
                IBucketController.PostStateOutOfBand(tokenOut, post.weightsWad[outIndex])
            );
            require(
                BucketMath.withinBand(assets[inIndex], post, inIndex),
                IBucketController.PostStateOutOfBand(tokenIn, post.weightsWad[inIndex])
            );
        }
        withinPolicy = !BucketMath.isOutOfPolicy(assets, params, post);
    }

    /// @notice Total USD value (WAD) of the assets at their snapshot balances; never reverts.
    function totalValue(AssetState[] memory assets) public pure returns (uint256 total) {
        for (uint256 i = 0; i < assets.length; ++i) {
            total += BucketMath.valueOf(assets[i].balance, assets[i].decimals, assets[i].priceWad, Math.Rounding.Floor);
        }
    }

    /// @dev Total value and maximum absolute deviation; zeros for an empty Bucket instead of reverting.
    function _summary(AssetState[] memory assets, uint256[] memory balances)
        private
        pure
        returns (uint256 total, uint256 maxAbsDeviationWad)
    {
        for (uint256 i = 0; i < assets.length; ++i) {
            total += BucketMath.valueOf(balances[i], assets[i].decimals, assets[i].priceWad, Math.Rounding.Floor);
        }
        if (total == 0) return (0, 0);
        maxAbsDeviationWad = BucketMath.valuateAt(assets, balances).maxAbsDeviationWad;
    }

    function _assetIndex(bytes32 bucketId, AssetState[] memory assets, address token)
        private
        pure
        returns (uint256 index)
    {
        index = BucketMath.indexOf(assets, token);
        require(index != type(uint256).max, IBucketController.AssetNotAllowed(bucketId, token));
    }

    function _mask(uint256 a, uint256 b) private pure returns (uint8) {
        // casting to uint8 is safe because asset indices are < MAX_BUCKET_ASSETS (8)
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8((uint256(1) << a) | (uint256(1) << b));
    }

    function _price(IBucketPriceFeed priceFeed, address token) private view returns (uint256, uint64) {
        try priceFeed.priceOf(token) returns (uint256 priceWad, uint64 updatedAt) {
            return (priceWad, updatedAt);
        } catch {
            return (0, 0);
        }
    }

    function _tload(bytes32 slot) private view returns (uint256 value) {
        assembly ("memory-safe") {
            value := tload(slot)
        }
    }
}
