// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @title IBucketPriceFeed
/// @notice Reference valuation source for Bucket assets.
/// @dev Prices are USD per whole token with 18 decimals. Freshness is enforced by the consumer against the
///      Bucket policy's `maxPriceAge`, so a feed never decides on its own whether a price is usable.
interface IBucketPriceFeed {
    error PriceUnavailable(address token);

    /// @return priceWad USD per whole token, 18 decimals
    /// @return updatedAt Timestamp of the observation
    function priceOf(address token) external view returns (uint256 priceWad, uint64 updatedAt);
}
