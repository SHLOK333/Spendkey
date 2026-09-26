// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Powered by SwapVM — © Degensoft Ltd 2025. BUCKET protocol extension instruction.

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";

import { BucketInstructionArgs } from "./BucketInstructionArgs.sol";

/// @notice BucketWalletBalanceCheck (0xd3): does the holder's live on-chain wallet balance cover the fill?
/// @dev Encoding: [address controller, bytes32 bucketId] (52 bytes).
///
///      In BUCKET's self-custodial model the Bucket holder's assets remain in their own wallet throughout
///      the protocol's lifetime. `BucketSpendLimit` (0xd2) validates `amountOut` against the Aqua virtual
///      balance (`ctx.swap.balanceOut`), which is derived from the holder's docked amount and/or the Aqua
///      allowance the holder has granted. That virtual balance can diverge from the holder's real ERC-20
///      balance if:
///        - the holder transfers tokens out of their wallet via a path Aqua does not track, or
///        - the holder's ERC-20 approval was partially consumed by another execution.
///
///      This instruction reads `IERC20(tokenOut).balanceOf(holder)` directly from the ERC-20 state — an
///      independent on-chain source — and reverts with a descriptive error before ANY state is modified,
///      making the Financial Capability unexercisable rather than reverting deep inside a transfer.
///
///      Position in the canonical program: LAST (runs after `BucketQuote` has set `amountOut`).
///
///        LIVE_BALANCE_CHECK     IERC20(tokenOut).balanceOf(holder) ≥ amountOut
library BucketWalletBalanceCheck {
    error BucketInsufficientWalletBalance(address token, address holder, uint256 balance, uint256 required);

    Opcode constant opcode = Opcode.BucketWalletBalanceCheck;

    function build(address controller, bytes32 bucketId) internal pure returns (bytes memory) {
        return BucketInstructionArgs.build(opcode, controller, bucketId);
    }

    /// @dev `args` is bound to (controller, bucketId) by the strategy hash; the instruction reads only the
    ///      Context fields set by earlier instructions in the canonical program.
    function exec(Context memory ctx, bytes calldata) internal view {
        uint256 balance = IERC20(ctx.query.tokenOut).balanceOf(ctx.query.maker);
        require(
            balance >= ctx.swap.amountOut,
            BucketInsufficientWalletBalance(ctx.query.tokenOut, ctx.query.maker, balance, ctx.swap.amountOut)
        );
    }
}
