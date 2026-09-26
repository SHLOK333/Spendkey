// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Powered by SwapVM — © Degensoft Ltd 2025. BUCKET protocol extension.

import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";
import { InstructionArgs } from "@1inch/swap-vm/contracts/libs/InstructionArgs.sol";

/// @title BucketInstructionArgs
/// @notice Shared wire format of the Bucket bank (0xd0-0xd2): `[opcode][52][controller: 20][bucketId: 32]`.
/// @dev The arguments are part of the maker-shipped program and therefore of the Aqua strategy hash: a taker can
///      never point an instruction at a different controller or Bucket.
library BucketInstructionArgs {
    using InstructionArgs for bytes;

    error BucketInstructionArgsLength(uint256 length);

    uint256 internal constant ARGS_LENGTH = 20 + 32;

    function build(Opcode opcode, address controller, bytes32 bucketId) internal pure returns (bytes memory) {
        // casting to uint8 is safe because ARGS_LENGTH (52) < 256
        // forge-lint: disable-next-line(unsafe-typecast)
        return abi.encodePacked(opcode.asU8(), uint8(ARGS_LENGTH), controller, bucketId);
    }

    function parse(bytes calldata args) internal pure returns (address controller, bytes32 bucketId) {
        require(args.length == ARGS_LENGTH, BucketInstructionArgsLength(args.length));
        controller = args.at(0).asAddress();
        bucketId = args.at(20).asBytes32();
    }
}
