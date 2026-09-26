// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @custom:license-url https://github.com/1inch/swap-vm/blob/main/LICENSES/SwapVM-1.1.txt
/// @notice Powered by SwapVM — © Degensoft Ltd 2025. BUCKET protocol extension instruction.

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/contracts/libs/OpcodeList.sol";

import { IBucketCapabilities } from "../interfaces/IBucketCapabilities.sol";
import { IBucketController } from "../interfaces/IBucketController.sol";
import { BucketMath } from "../libraries/BucketMath.sol";
import { BucketPermissions } from "../libraries/BucketPermissions.sol";
import {
    BucketSnapshot,
    BucketStatus,
    ExecutionFrame,
    Intent,
    IntentKind,
    VENUE_AQUA_SWAPVM
} from "../types/BucketTypes.sol";
import { BucketInstructionArgs } from "./BucketInstructionArgs.sol";

/// @notice BucketCapabilityGuard (0xd0): may THIS taker fill THIS order right now, and under which capability?
/// @dev Encoding: [address controller, bytes32 bucketId] (52 bytes). A guard instruction: writes no registers.
///
///        BUCKET_LOAD            frame (Bucket snapshot, open intent, effective limits) from the controller
///        MAKER_CHECK            maker == Bucket holder (the wallet whose liquidity is at stake)
///        BUCKET_STATE           Bucket ACTIVE, venue allowed, order is a canonical strategy of the current generation
///        INTENT_CHECK           an intent is open, not expired, bound to the current policy version, and this fill
///                               goes in the intent's direction
///        OPERATOR_CHECK         taker == the intent's operator
///        CAPABILITY_VALIDATE    the whole delegation chain is valid now (status, epoch, policy version, validity
///                               window, ENSv2 names), and the leaf grants the intent's permission, both assets and
///                               the Aqua venue
library BucketCapabilityGuard {
    error BucketMakerMismatch(address holder, address maker);
    error BucketInactive(bytes32 bucketId, BucketStatus status);
    error BucketStrategyNotCanonical(bytes32 orderHash);
    error BucketVenueNotAllowed(uint8 venueMask);
    error BucketNoOpenIntent(bytes32 bucketId);
    error BucketIntentPolicyMismatch(uint32 intentVersion, uint32 policyVersion);
    error BucketIntentExpired(bytes32 intentId, uint40 expiresAt);
    error BucketIntentDirectionMismatch(address tokenOut, address tokenIn);
    error BucketTakerNotOperator(address taker, address operator);
    error BucketAssetNotAllowed(address token);

    Opcode constant opcode = Opcode.BucketCapabilityGuard;

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

        // MAKER_CHECK + BUCKET_STATE
        require(bucket.holder == ctx.query.maker, BucketMakerMismatch(bucket.holder, ctx.query.maker));
        require(bucket.status == BucketStatus.ACTIVE, BucketInactive(bucketId, bucket.status));
        require(frame.strategyActive, BucketStrategyNotCanonical(ctx.query.orderHash));
        require(bucket.params.venueMask & VENUE_AQUA_SWAPVM != 0, BucketVenueNotAllowed(bucket.params.venueMask));

        // INTENT_CHECK
        require(bucket.activeIntent != bytes32(0) && intent.kind != IntentKind.NONE, BucketNoOpenIntent(bucketId));
        require(
            intent.policyVersion == bucket.policyVersion,
            BucketIntentPolicyMismatch(intent.policyVersion, bucket.policyVersion)
        );
        require(block.timestamp <= intent.expiresAt, BucketIntentExpired(bucket.activeIntent, intent.expiresAt));
        require(
            intent.tokenOut == ctx.query.tokenOut && intent.tokenIn == ctx.query.tokenIn,
            BucketIntentDirectionMismatch(ctx.query.tokenOut, ctx.query.tokenIn)
        );

        // OPERATOR_CHECK
        require(ctx.query.taker == intent.operator, BucketTakerNotOperator(ctx.query.taker, intent.operator));

        // CAPABILITY_VALIDATE
        uint256 outIndex = BucketMath.indexOf(bucket.assets, ctx.query.tokenOut);
        uint256 inIndex = BucketMath.indexOf(bucket.assets, ctx.query.tokenIn);
        require(outIndex != type(uint256).max, BucketAssetNotAllowed(ctx.query.tokenOut));
        require(inIndex != type(uint256).max, BucketAssetNotAllowed(ctx.query.tokenIn));
        // casting to uint8 is safe because asset indices are < MAX_BUCKET_ASSETS (8)
        // forge-lint: disable-next-line(unsafe-typecast)
        uint8 assetMask = uint8((uint256(1) << outIndex) | (uint256(1) << inIndex));
        uint32 permission =
            intent.kind == IntentKind.REBALANCE ? BucketPermissions.PERM_REBALANCE : BucketPermissions.PERM_SWAP;
        IBucketCapabilities(bucket.capabilities).requireAuthorized(
            intent.capabilityId, ctx.query.taker, permission, assetMask, VENUE_AQUA_SWAPVM
        );
    }
}
