// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import { Capability, CapabilityLimits, Usage, HOUR, DAY } from "../types/BucketTypes.sol";

/// @title CapabilityLib
/// @notice Identity and cross-chain commitment of Financial Capabilities.
library CapabilityLib {
    /// @dev Domain tag of capability identifiers, `keccak256("BUCKET_CAPABILITY_ID_V1")`.
    bytes32 internal constant ID_DOMAIN = keccak256("BUCKET_CAPABILITY_ID_V1");
    /// @dev Domain tag of the capability commitment, `keccak256("BUCKET_CAPABILITY_V1")`.
    bytes32 internal constant HASH_DOMAIN = keccak256("BUCKET_CAPABILITY_V1");

    /// @notice Deterministic capability identifier: computable before issuance from the Bucket's next nonce.
    function id(bytes32 bucketId, uint64 nonce) internal pure returns (bytes32) {
        return keccak256(abi.encode(ID_DOMAIN, bucketId, nonce));
    }

    /// @notice Canonical commitment to the immutable part of a capability, identical in Move and TypeScript.
    /// @dev keccak256 over a big-endian packed layout:
    ///      HASH_DOMAIN(32) | capabilityId(32) | bucketId(32) | parentId(32) | issuer(20) | operator(20) | depth(1) |
    ///      permissions(4) | assetMask(1) | venueMask(1) | validAfter(5) | validUntil(5) | policyVersion(4) |
    ///      epoch(4) | nonce(8) | payee(20) | maxExecutionValue(16) | maxHourlyValue(16) | maxDailyValue(16) |
    ///      maxSlippageBps(2) | maxDailyTurnoverBps(2) | maxExecutions(4)
    function hash(bytes32 capabilityId, Capability memory c) internal pure returns (bytes32) {
        bytes memory head = abi.encodePacked(
            HASH_DOMAIN,
            capabilityId,
            c.bucketId,
            c.parentId,
            c.issuer,
            c.operator,
            c.depth,
            c.permissions,
            c.assetMask,
            c.venueMask,
            c.validAfter,
            c.validUntil
        );
        CapabilityLimits memory l = c.limits;
        bytes memory tail = abi.encodePacked(
            c.policyVersion,
            c.epoch,
            c.nonce,
            c.payee,
            l.maxExecutionValue,
            l.maxHourlyValue,
            l.maxDailyValue,
            l.maxSlippageBps,
            l.maxDailyTurnoverBps,
            l.maxExecutions
        );
        return keccak256(bytes.concat(head, tail));
    }
}

/// @title UsageLib
/// @notice Deterministic cumulative spend accounting in fixed hour/day windows (`window = timestamp / size`).
/// @dev Fixed windows allow at most twice a window's limit across one window boundary; the daily limit bounds the
///      hourly boundary effect and every limit is additionally capped per execution.
library UsageLib {
    function hourOf(uint256 timestamp) internal pure returns (uint32) {
        // casting to uint32 is safe for timestamps below 2^32 hours
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(timestamp / HOUR);
    }

    function dayOf(uint256 timestamp) internal pure returns (uint32) {
        // casting to uint32 is safe for timestamps below 2^32 days
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint32(timestamp / DAY);
    }

    /// @notice Value spent in the hour window containing `timestamp`.
    function hourSpent(Usage memory u, uint256 timestamp) internal pure returns (uint256) {
        return u.hourWindow == hourOf(timestamp) ? u.hourValue : 0;
    }

    /// @notice Value spent in the day window containing `timestamp`.
    function daySpent(Usage memory u, uint256 timestamp) internal pure returns (uint256) {
        return u.dayWindow == dayOf(timestamp) ? u.dayValue : 0;
    }

    /// @notice `limit - spent`, floored at zero.
    function remaining(uint256 limit, uint256 spent) internal pure returns (uint256) {
        return spent >= limit ? 0 : limit - spent;
    }

    /// @notice Adds `value` to the windows containing `timestamp`, rolling expired windows first.
    function charge(Usage storage u, uint256 value, uint256 timestamp) internal {
        uint32 hour = hourOf(timestamp);
        uint32 day = dayOf(timestamp);
        uint256 hourValue = (u.hourWindow == hour ? u.hourValue : 0) + value;
        uint256 dayValue = (u.dayWindow == day ? u.dayValue : 0) + value;
        u.hourWindow = hour;
        u.dayWindow = day;
        u.hourValue = SafeCast.toUint128(hourValue);
        u.dayValue = SafeCast.toUint128(dayValue);
    }
}
