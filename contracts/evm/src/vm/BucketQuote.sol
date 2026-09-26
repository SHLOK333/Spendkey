// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Powered by SwapVM — © Degensoft Ltd 2025. BUCKET protocol extension instruction.

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";

import { IBucketController } from "../interfaces/IBucketController.sol";
import { BucketMath } from "../libraries/BucketMath.sol";
import { AssetState, BucketSnapshot, ExecutionFrame, Intent, IntentKind } from "../types/BucketTypes.sol";
import { BucketInstructionArgs } from "./BucketInstructionArgs.sol";

/// @notice BucketQuote (0xd1): the price at which the Bucket accepts this fill.
/// @dev Encoding: [address controller, bytes32 bucketId] (52 bytes). A curve-family instruction: it reads the
///      taker-fixed amount and writes the missing amount into the swap registers.
///
///        READ_BALANCES          live holder balances and fresh reference prices
///        CALCULATE_DEVIATION    allocation and deviation from target
///        REBALANCE_REQUIRED     (REBALANCE) the Bucket is out of policy and the fill sells an overweight asset for
///                               an underweight one
///        PRICE                  reference price with a Dutch-auction concession that grows from 0 at the intent's
///                               opening to the tightest slippage limit (policy and every capability in the chain)
///        NO_OVERSHOOT           (REBALANCE) neither leg crosses its target
///
///      The instruction is `view`, so `quote` and `swap` evaluate identically.
library BucketQuote {
    error BucketWithinPolicy(uint256 maxAbsDeviationWad);
    error BucketDirectionInvalid(address tokenOut, address tokenIn);
    error BucketZeroAmount();
    error BucketTargetOvershoot(uint256 valueOut, uint256 excessOut, uint256 valueIn, uint256 deficitIn);

    Opcode constant opcode = Opcode.BucketQuote;

    function build(address controller, bytes32 bucketId) internal pure returns (bytes memory) {
        return BucketInstructionArgs.build(opcode, controller, bucketId);
    }

    function exec(Context memory ctx, bytes calldata args) internal view {
        (address controller, bytes32 bucketId) = BucketInstructionArgs.parse(args);
        ExecutionFrame memory frame = IBucketController(controller).loadFrame(
            bucketId, ctx.query.orderHash, ctx.query.tokenIn, ctx.query.tokenOut
        );
        BucketSnapshot memory bucket = frame.bucket;
        Intent memory intent = frame.intent;

        // READ_BALANCES + CALCULATE_DEVIATION
        BucketMath.requireFreshPrices(bucket.assets, bucket.params.maxPriceAge);
        BucketMath.Valuation memory valuation = BucketMath.valuate(bucket.assets);
        uint256 outIndex = BucketMath.indexOf(bucket.assets, ctx.query.tokenOut);
        uint256 inIndex = BucketMath.indexOf(bucket.assets, ctx.query.tokenIn);
        AssetState memory assetOut = bucket.assets[outIndex];
        AssetState memory assetIn = bucket.assets[inIndex];

        // REBALANCE_REQUIRED
        bool rebalance = intent.kind == IntentKind.REBALANCE;
        if (rebalance) {
            require(
                BucketMath.isOutOfPolicy(bucket.assets, bucket.params, valuation),
                BucketWithinPolicy(valuation.maxAbsDeviationWad)
            );
            require(
                valuation.deviationsWad[outIndex] > 0 && valuation.deviationsWad[inIndex] < 0,
                BucketDirectionInvalid(ctx.query.tokenOut, ctx.query.tokenIn)
            );
        }

        // PRICE
        uint256 discountBps = BucketMath.auctionDiscountBps(
            frame.limits.maxSlippageBps, bucket.params.auctionDuration, intent.openedAt, block.timestamp
        );
        if (ctx.query.isExactIn) {
            ctx.swap.amountOut = BucketMath.quoteExactIn(ctx.swap.amountIn, assetIn, assetOut, discountBps);
        } else {
            ctx.swap.amountIn = BucketMath.quoteExactOut(ctx.swap.amountOut, assetIn, assetOut, discountBps);
        }
        require(ctx.swap.amountIn > 0 && ctx.swap.amountOut > 0, BucketZeroAmount());

        // NO_OVERSHOOT
        if (rebalance) {
            uint256 valueOut =
                BucketMath.valueOf(ctx.swap.amountOut, assetOut.decimals, assetOut.priceWad, Math.Rounding.Ceil);
            uint256 valueIn =
                BucketMath.valueOf(ctx.swap.amountIn, assetIn.decimals, assetIn.priceWad, Math.Rounding.Ceil);
            uint256 excessOut = BucketMath.excessValue(valuation, assetOut.targetBps, outIndex);
            uint256 deficitIn = BucketMath.deficitValue(valuation, assetIn.targetBps, inIndex);
            require(
                valueOut <= excessOut && valueIn <= deficitIn,
                BucketTargetOvershoot(valueOut, excessOut, valueIn, deficitIn)
            );
        }
    }
}
