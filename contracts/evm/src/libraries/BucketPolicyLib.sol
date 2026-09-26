// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import {
    AssetConfig,
    PolicyParams,
    BPS,
    MAX_BUCKET_ASSETS,
    MAX_TOKEN_DECIMALS,
    MAX_SLIPPAGE_LIMIT_BPS,
    MAX_THRESHOLD_LIMIT_BPS,
    ALL_VENUES
} from "../types/BucketTypes.sol";
import { BucketPermissions } from "./BucketPermissions.sol";

/// @title BucketPolicyLib
/// @notice Validation and the canonical cross-chain commitment of a Bucket policy.
/// @dev Invariants enforced by `validate` (identically in Move and TypeScript):
///      I1   1 <= assets.length <= MAX_BUCKET_ASSETS
///      I2   every token is non-zero and unique; decimals <= 18
///      I3   for every asset: minBps <= targetBps <= maxBps <= BPS
///      I4   sum(targetBps) == BPS
///      I5   0 < rebalanceThresholdBps <= MAX_THRESHOLD_LIMIT_BPS
///      I6   maxSlippageBps <= MAX_SLIPPAGE_LIMIT_BPS
///      I7   0 < maxExecutionValue <= maxHourlyValue <= maxDailyValue
///      I8   maxPriceAge > 0, auctionDuration > 0, 0 < maxDailyTurnoverBps <= BPS
///      I9   venueMask is a non-empty subset of known venues
///      I10  delegablePermissions only contains delegable permissions
library BucketPolicyLib {
    /// @dev Domain tag of the policy commitment, `keccak256("BUCKET_POLICY_V2")`.
    bytes32 internal constant POLICY_DOMAIN = keccak256("BUCKET_POLICY_V2");

    error PolicyAssetCount(uint256 count);
    error PolicyTokenZero(uint256 index);
    error PolicyTokenDuplicate(address token);
    error PolicyTokenDecimals(address token, uint8 decimals);
    error PolicyWeightBand(address token, uint16 minBps, uint16 targetBps, uint16 maxBps);
    error PolicyTargetSum(uint256 sum);
    error PolicyThreshold(uint16 thresholdBps);
    error PolicySlippage(uint16 maxSlippageBps);
    error PolicyValueLimits(uint128 maxExecutionValue, uint128 maxHourlyValue, uint128 maxDailyValue);
    error PolicyPriceAge();
    error PolicyAuctionDuration();
    error PolicyTurnover(uint16 maxDailyTurnoverBps);
    error PolicyVenues(uint8 venueMask);
    error PolicyDelegablePermissions(uint32 permissions);

    function validate(PolicyParams memory params, AssetConfig[] memory assets) internal pure {
        uint256 count = assets.length;
        require(count > 0 && count <= MAX_BUCKET_ASSETS, PolicyAssetCount(count));

        uint256 targetSum;
        for (uint256 i = 0; i < count; ++i) {
            AssetConfig memory asset = assets[i];
            require(asset.token != address(0), PolicyTokenZero(i));
            require(asset.decimals <= MAX_TOKEN_DECIMALS, PolicyTokenDecimals(asset.token, asset.decimals));
            require(
                asset.minBps <= asset.targetBps && asset.targetBps <= asset.maxBps && asset.maxBps <= BPS,
                PolicyWeightBand(asset.token, asset.minBps, asset.targetBps, asset.maxBps)
            );
            for (uint256 j = 0; j < i; ++j) {
                require(assets[j].token != asset.token, PolicyTokenDuplicate(asset.token));
            }
            targetSum += asset.targetBps;
        }
        require(targetSum == BPS, PolicyTargetSum(targetSum));

        require(
            params.rebalanceThresholdBps > 0 && params.rebalanceThresholdBps <= MAX_THRESHOLD_LIMIT_BPS,
            PolicyThreshold(params.rebalanceThresholdBps)
        );
        require(params.maxSlippageBps <= MAX_SLIPPAGE_LIMIT_BPS, PolicySlippage(params.maxSlippageBps));
        require(
            params.maxExecutionValue > 0 && params.maxExecutionValue <= params.maxHourlyValue
                && params.maxHourlyValue <= params.maxDailyValue,
            PolicyValueLimits(params.maxExecutionValue, params.maxHourlyValue, params.maxDailyValue)
        );
        require(params.maxPriceAge > 0, PolicyPriceAge());
        require(params.auctionDuration > 0, PolicyAuctionDuration());
        require(
            params.maxDailyTurnoverBps > 0 && params.maxDailyTurnoverBps <= BPS,
            PolicyTurnover(params.maxDailyTurnoverBps)
        );
        require(params.venueMask != 0 && params.venueMask & ~ALL_VENUES == 0, PolicyVenues(params.venueMask));
        require(
            params.delegablePermissions & ~BucketPermissions.DELEGABLE_PERMISSIONS == 0,
            PolicyDelegablePermissions(params.delegablePermissions)
        );
    }

    /// @notice Canonical policy commitment shared with Sui and the SDK.
    /// @dev keccak256 over a big-endian packed layout:
    ///      POLICY_DOMAIN(32) | bucketId(32) | version(4) | thresholdBps(2) | maxSlippageBps(2) | maxPriceAge(4) |
    ///      auctionDuration(4) | venueMask(1) | maxDailyTurnoverBps(2) | delegablePermissions(4) |
    ///      maxExecutionValue(16) | maxHourlyValue(16) | maxDailyValue(16) | assetCount(1) |
    ///      assetCount * [token(20) | decimals(1) | target(2) | min(2) | max(2)]
    function hash(bytes32 bucketId, uint32 version, PolicyParams memory params, AssetConfig[] memory assets)
        internal
        pure
        returns (bytes32)
    {
        bytes memory encoded = abi.encodePacked(
            POLICY_DOMAIN,
            bucketId,
            version,
            params.rebalanceThresholdBps,
            params.maxSlippageBps,
            params.maxPriceAge,
            params.auctionDuration,
            params.venueMask,
            params.maxDailyTurnoverBps,
            params.delegablePermissions,
            params.maxExecutionValue,
            params.maxHourlyValue,
            params.maxDailyValue,
            uint8(assets.length)
        );
        for (uint256 i = 0; i < assets.length; ++i) {
            AssetConfig memory asset = assets[i];
            encoded = bytes.concat(
                encoded, abi.encodePacked(asset.token, asset.decimals, asset.targetBps, asset.minBps, asset.maxBps)
            );
        }
        return keccak256(encoded);
    }

    /// @notice Bit mask with one bit per policy asset.
    function fullAssetMask(uint256 assetCount) internal pure returns (uint8) {
        // casting to uint8 is safe because assetCount <= MAX_BUCKET_ASSETS (8)
        // forge-lint: disable-next-line(unsafe-typecast)
        return uint8((uint256(1) << assetCount) - 1);
    }
}
