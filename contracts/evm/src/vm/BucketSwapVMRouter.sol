// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Powered by SwapVM — © Degensoft Ltd 2025. BUCKET protocol extension router.

import { Simulator } from "@1inch/solidity-utils/contracts/mixins/Simulator.sol";

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { SwapVM } from "@1inch/swap-vm/contracts/SwapVM.sol";

import { BucketOpcodes } from "./BucketOpcodes.sol";

/// @title BucketSwapVMRouter
/// @notice SwapVM router whose instruction set is the Bucket program set (`BucketOpcodes`). Bucket strategies are shipped to
///         Aqua with this router as the app, so Aqua virtual balances and SwapVM programs share one execution path.
contract BucketSwapVMRouter is Simulator, SwapVM, BucketOpcodes {
    constructor(address aqua, address weth, address owner, string memory name, string memory version)
        SwapVM(aqua, weth, owner, name, version)
    { }

    function _dispatch(Context memory ctx, uint256 opcode, bytes calldata args) internal override {
        _runOpcode(ctx, opcode, args);
    }
}
