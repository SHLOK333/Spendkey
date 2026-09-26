// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Powered by SwapVM — © Degensoft Ltd 2025. BUCKET protocol extension opcode set.

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Deadline, Salt } from "@1inch/swap-vm/contracts/instructions/Controls.sol";

import { BucketCapabilityGuard } from "./BucketCapabilityGuard.sol";
import { BucketQuote } from "./BucketQuote.sol";
import { BucketSpendLimit } from "./BucketSpendLimit.sol";
import { BucketWalletBalanceCheck } from "./BucketWalletBalanceCheck.sol";

/// @title BucketOpcodes
/// @notice The minimal instruction set of Bucket strategies: SwapVM `Deadline` and `Salt` plus the Bucket bank.
/// @dev Deliberately narrower than `AquaOpcodes`: a router that only understands the Bucket program has no curve,
///      fee or jump instruction a maker could combine with Bucket instructions to bypass them. Numbering is the fixed
///      SwapVM `OpcodeList`.
///
///      The canonical Bucket program, compiled by `BucketEngine.program` (and, byte-identically, by the TypeScript
///      package bucket-vm):
///        Deadline(strategyExpiry)                0x20  Aqua-level expiry of the strategy generation
///        Salt(strategyNonce)                     0x02  unique strategy hash per generation (Aqua immutability)
///        BucketCapabilityGuard(controller, id)   0xd0  identity, intent, capability chain, ENSv2
///        BucketQuote(controller, id)             0xd1  policy-bound price, rebalance direction, no overshoot
///        BucketSpendLimit(controller, id)        0xd2  per-execution, hourly, daily, turnover, intent and Aqua caps
///        BucketWalletBalanceCheck(controller, id) 0xd3  live ERC-20 wallet balance ≥ amountOut (self-custodial guard)
contract BucketOpcodes {
    error UnknownOpcode(uint256 opcode);

    function _runOpcode(Context memory ctx, uint256 opcode, bytes calldata args) internal virtual {
        if (opcode == BucketCapabilityGuard.opcode.asU8()) BucketCapabilityGuard.exec(ctx, args);
        else if (opcode == BucketQuote.opcode.asU8()) BucketQuote.exec(ctx, args);
        else if (opcode == BucketSpendLimit.opcode.asU8()) BucketSpendLimit.exec(ctx, args);
        else if (opcode == BucketWalletBalanceCheck.opcode.asU8()) BucketWalletBalanceCheck.exec(ctx, args);
        else if (opcode == Deadline.opcode.asU8()) Deadline.exec(ctx, args);
        else if (opcode == Salt.opcode.asU8()) Salt.exec(ctx, args);
        else revert UnknownOpcode(opcode);
    }
}
