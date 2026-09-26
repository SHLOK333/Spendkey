// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Powered by SwapVM — © Degensoft Ltd 2025. BUCKET protocol extension instruction.

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";

import { IBucketController } from "../interfaces/IBucketController.sol";
import { BucketMath } from "../libraries/BucketMath.sol";
import { AssetState, EffectiveLimits, ExecutionFrame } from "../types/BucketTypes.sol";
import { BucketInstructionArgs } from "./BucketInstructionArgs.sol";

/// @notice BucketSpendLimit (0xd2): is the priced fill within every quantitative bound?
/// @dev Encoding: [address controller, bytes32 bucketId] (52 bytes). Runs after `BucketQuote`, on final amounts.
///
///        AMOUNT_LIMIT_CHECK     value given <= min(policy, capability chain) per-execution limit
///        SPEND_VELOCITY_CHECK   value given <= remaining hourly and daily budget of the Bucket and of every
///                               capability in the chain, and <= remaining daily turnover
///        INTENT_BUDGET          amount given <= what the intent still allows
///        AQUA_BUDGET            amount given <= the strategy's Aqua virtual balance (infrastructure-level cap)
///
///      The same limits are charged, and re-checked, at settlement by the controller and `BucketCapabilities`.
library BucketSpendLimit {
    error BucketExecutionLimitExceeded(uint256 value, uint256 limit);
    error BucketHourlyLimitExceeded(uint256 value, uint256 remaining);
    error BucketDailyLimitExceeded(uint256 value, uint256 remaining);
    error BucketTurnoverLimitExceeded(uint256 value, uint256 remaining);
    error BucketIntentBudgetExceeded(uint256 amountOut, uint256 remainingOut);
    error BucketAquaBudgetExceeded(uint256 amountOut, uint256 balanceOut);

    Opcode constant opcode = Opcode.BucketSpendLimit;

    function build(address controller, bytes32 bucketId) internal pure returns (bytes memory) {
        return BucketInstructionArgs.build(opcode, controller, bucketId);
    }

    function exec(Context memory ctx, bytes calldata args) internal view {
        (address controller, bytes32 bucketId) = BucketInstructionArgs.parse(args);
        ExecutionFrame memory frame = IBucketController(controller).loadFrame(
            bucketId, ctx.query.orderHash, ctx.query.tokenIn, ctx.query.tokenOut
        );
        AssetState memory assetOut = frame.bucket.assets[BucketMath.indexOf(frame.bucket.assets, ctx.query.tokenOut)];
        uint256 valueOut =
            BucketMath.valueOf(ctx.swap.amountOut, assetOut.decimals, assetOut.priceWad, Math.Rounding.Ceil);

        EffectiveLimits memory limits = frame.limits;
        require(
            valueOut <= limits.maxExecutionValue, BucketExecutionLimitExceeded(valueOut, limits.maxExecutionValue)
        );
        require(
            valueOut <= limits.remainingHourlyValue, BucketHourlyLimitExceeded(valueOut, limits.remainingHourlyValue)
        );
        require(
            valueOut <= limits.remainingDailyValue, BucketDailyLimitExceeded(valueOut, limits.remainingDailyValue)
        );
        require(
            valueOut <= limits.remainingTurnoverValue,
            BucketTurnoverLimitExceeded(valueOut, limits.remainingTurnoverValue)
        );
        require(
            ctx.swap.amountOut <= frame.intent.remainingOut,
            BucketIntentBudgetExceeded(ctx.swap.amountOut, frame.intent.remainingOut)
        );
        require(
            ctx.swap.amountOut <= ctx.swap.balanceOut, BucketAquaBudgetExceeded(ctx.swap.amountOut, ctx.swap.balanceOut)
        );
    }
}
