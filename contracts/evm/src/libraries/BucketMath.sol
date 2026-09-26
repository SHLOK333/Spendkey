// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { SafeCast } from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import { SignedMath } from "@openzeppelin/contracts/utils/math/SignedMath.sol";

import { AssetState, PolicyParams, BPS, WAD, BPS_TO_WAD, MAX_TOKEN_DECIMALS } from "../types/BucketTypes.sol";

/// @title BucketMath
/// @notice Deterministic fixed-point valuation, allocation, deviation and pricing for Buckets.
/// @dev Single source of financial truth for the controller, the Bucket SwapVM instructions and the post-execution
///      verifier. The TypeScript package bucket-vm mirrors every function bit-for-bit with `bigint`.
///
///      Units
///        amount      raw token units (token decimals)
///        normalized  amount scaled to 18 decimals: amount * 10^(18 - decimals)
///        priceWad    USD per whole token, 18 decimals
///        value       USD, 18 decimals
///        weightWad   fraction of total value, 18 decimals (1e18 = 100%)
///
///      Rounding (always in favour of the Bucket)
///        valuation            floor
///        excess (sell side)   target value rounded up   -> excess rounded down
///        deficit (buy side)   target value rounded down -> deficit rounded down
///        exact-in quote       amountOut rounded down (Bucket gives less)
///        exact-out quote      amountIn rounded up (Bucket receives more)
///        cap checks           trade values rounded up (conservative)
library BucketMath {
    using SafeCast for uint256;

    error BucketMathEmptyBucket();
    error BucketMathZeroPrice(address token);
    error BucketMathPriceStale(address token, uint64 updatedAt, uint32 maxPriceAge);
    error BucketMathBalancesLength(uint256 expected, uint256 actual);

    /// @notice Valuation of a Bucket at a set of balances and reference prices.
    struct Valuation {
        uint256 totalValue;
        uint256[] values;
        uint256[] weightsWad;
        int256[] deviationsWad;
        uint256 maxAbsDeviationWad;
    }

    function scaleOf(uint8 decimals) internal pure returns (uint256) {
        return 10 ** (MAX_TOKEN_DECIMALS - decimals);
    }

    /// @notice USD value (WAD) of `amount` raw units.
    function valueOf(uint256 amount, uint8 decimals, uint256 priceWad, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        return Math.mulDiv(amount * scaleOf(decimals), priceWad, WAD, rounding);
    }

    /// @notice Raw token units worth `value` USD (WAD).
    function amountOf(uint256 value, uint8 decimals, uint256 priceWad, Math.Rounding rounding)
        internal
        pure
        returns (uint256)
    {
        uint256 normalized = Math.mulDiv(value, WAD, priceWad, rounding);
        uint256 scale = scaleOf(decimals);
        return rounding == Math.Rounding.Ceil ? Math.ceilDiv(normalized, scale) : normalized / scale;
    }

    /// @notice Reverts unless every reference price is non-zero and no older than `maxPriceAge`.
    function requireFreshPrices(AssetState[] memory assets, uint32 maxPriceAge) internal view {
        for (uint256 i = 0; i < assets.length; ++i) {
            AssetState memory asset = assets[i];
            require(asset.priceWad > 0, BucketMathZeroPrice(asset.token));
            require(
                asset.priceUpdatedAt <= block.timestamp && block.timestamp - asset.priceUpdatedAt <= maxPriceAge,
                BucketMathPriceStale(asset.token, asset.priceUpdatedAt, maxPriceAge)
            );
        }
    }

    /// @notice Values the Bucket at its snapshot balances.
    function valuate(AssetState[] memory assets) internal pure returns (Valuation memory) {
        uint256[] memory balances = new uint256[](assets.length);
        for (uint256 i = 0; i < assets.length; ++i) {
            balances[i] = assets[i].balance;
        }
        return valuateAt(assets, balances);
    }

    /// @notice Values the Bucket at arbitrary balances (used for post-state verification).
    function valuateAt(AssetState[] memory assets, uint256[] memory balances)
        internal
        pure
        returns (Valuation memory v)
    {
        uint256 count = assets.length;
        require(balances.length == count, BucketMathBalancesLength(count, balances.length));

        v.values = new uint256[](count);
        v.weightsWad = new uint256[](count);
        v.deviationsWad = new int256[](count);

        for (uint256 i = 0; i < count; ++i) {
            AssetState memory asset = assets[i];
            uint256 value = valueOf(balances[i], asset.decimals, asset.priceWad, Math.Rounding.Floor);
            v.values[i] = value;
            v.totalValue += value;
        }
        require(v.totalValue > 0, BucketMathEmptyBucket());

        for (uint256 i = 0; i < count; ++i) {
            uint256 weight = Math.mulDiv(v.values[i], WAD, v.totalValue);
            int256 deviation = weight.toInt256() - (uint256(assets[i].targetBps) * BPS_TO_WAD).toInt256();
            v.weightsWad[i] = weight;
            v.deviationsWad[i] = deviation;
            uint256 absDeviation = abs(deviation);
            if (absDeviation > v.maxAbsDeviationWad) v.maxAbsDeviationWad = absDeviation;
        }
    }

    /// @notice True when any asset is outside its hard band or deviates from target by more than the threshold.
    function isOutOfPolicy(AssetState[] memory assets, PolicyParams memory params, Valuation memory v)
        internal
        pure
        returns (bool)
    {
        uint256 threshold = uint256(params.rebalanceThresholdBps) * BPS_TO_WAD;
        for (uint256 i = 0; i < assets.length; ++i) {
            uint256 weight = v.weightsWad[i];
            if (
                weight < uint256(assets[i].minBps) * BPS_TO_WAD || weight > uint256(assets[i].maxBps) * BPS_TO_WAD
                    || abs(v.deviationsWad[i]) > threshold
            ) return true;
        }
        return false;
    }

    /// @notice Selects the rebalance leg among the assets in `assetMask`: sell the most overweight asset, buy the most
    ///         underweight one. Ties resolve to the lowest index.
    /// @return outIndex Asset the Bucket sells (deviation > 0), `type(uint256).max` if none
    /// @return inIndex Asset the Bucket buys (deviation < 0), `type(uint256).max` if none
    function selectLeg(Valuation memory v, uint8 assetMask) internal pure returns (uint256 outIndex, uint256 inIndex) {
        outIndex = type(uint256).max;
        inIndex = type(uint256).max;
        int256 maxDeviation;
        int256 minDeviation;
        for (uint256 i = 0; i < v.deviationsWad.length; ++i) {
            if (uint256(assetMask) & (uint256(1) << i) == 0) continue;
            int256 deviation = v.deviationsWad[i];
            if (deviation > maxDeviation) (maxDeviation, outIndex) = (deviation, i);
            if (deviation < minDeviation) (minDeviation, inIndex) = (deviation, i);
        }
    }

    /// @notice Value the Bucket may sell of asset `i` before reaching its target (rounded down).
    function excessValue(Valuation memory v, uint16 targetBps, uint256 i) internal pure returns (uint256) {
        uint256 targetValue = Math.mulDiv(v.totalValue, targetBps, BPS, Math.Rounding.Ceil);
        return v.values[i] > targetValue ? v.values[i] - targetValue : 0;
    }

    /// @notice Value the Bucket may buy of asset `i` before reaching its target (rounded down).
    function deficitValue(Valuation memory v, uint16 targetBps, uint256 i) internal pure returns (uint256) {
        uint256 targetValue = Math.mulDiv(v.totalValue, targetBps, BPS, Math.Rounding.Floor);
        return targetValue > v.values[i] ? targetValue - v.values[i] : 0;
    }

    /// @notice Concession the Bucket grants at `timestamp`: grows linearly from 0 at `start` to `maxSlippageBps`
    ///         after `duration` seconds (Dutch-auction price discovery bounded by policy). Rounded down.
    function auctionDiscountBps(uint16 maxSlippageBps, uint32 duration, uint40 start, uint256 timestamp)
        internal
        pure
        returns (uint256)
    {
        if (timestamp <= start) return 0;
        uint256 elapsed = Math.min(timestamp - start, duration);
        return uint256(maxSlippageBps) * elapsed / duration;
    }

    /// @notice Tokens the Bucket gives for exactly `amountIn`, conceding `discountBps` of the value it gives.
    /// @dev valueOut * (BPS - discount) / BPS == valueIn, amountOut rounded down.
    function quoteExactIn(uint256 amountIn, AssetState memory assetIn, AssetState memory assetOut, uint256 discountBps)
        internal
        pure
        returns (uint256 amountOut)
    {
        uint256 normalizedOut = Math.mulDiv(
            amountIn * scaleOf(assetIn.decimals), assetIn.priceWad, assetOut.priceWad, Math.Rounding.Floor
        );
        normalizedOut = Math.mulDiv(normalizedOut, BPS, BPS - discountBps, Math.Rounding.Floor);
        amountOut = normalizedOut / scaleOf(assetOut.decimals);
    }

    /// @notice Tokens the Bucket requires in order to give exactly `amountOut`, rounded up.
    function quoteExactOut(
        uint256 amountOut,
        AssetState memory assetIn,
        AssetState memory assetOut,
        uint256 discountBps
    ) internal pure returns (uint256 amountIn) {
        uint256 normalizedIn = Math.mulDiv(
            amountOut * scaleOf(assetOut.decimals), assetOut.priceWad, assetIn.priceWad, Math.Rounding.Ceil
        );
        normalizedIn = Math.mulDiv(normalizedIn, BPS - discountBps, BPS, Math.Rounding.Ceil);
        amountIn = Math.ceilDiv(normalizedIn, scaleOf(assetIn.decimals));
    }

    /// @notice Post-state acceptance rule: the traded assets and the whole Bucket must not move away from target.
    function improves(Valuation memory pre, Valuation memory post, uint256 outIndex, uint256 inIndex)
        internal
        pure
        returns (bool)
    {
        return abs(post.deviationsWad[outIndex]) <= abs(pre.deviationsWad[outIndex])
            && abs(post.deviationsWad[inIndex]) <= abs(pre.deviationsWad[inIndex])
            && post.maxAbsDeviationWad <= pre.maxAbsDeviationWad;
    }

    /// @notice True when asset `i` sits inside its hard band [minBps, maxBps].
    function withinBand(AssetState memory asset, Valuation memory v, uint256 i) internal pure returns (bool) {
        uint256 weight = v.weightsWad[i];
        return weight >= uint256(asset.minBps) * BPS_TO_WAD && weight <= uint256(asset.maxBps) * BPS_TO_WAD;
    }

    /// @notice Commitment to a Bucket state: keccak256(abi.encode(balances, pricesWad)). Identical on Sui and in TS.
    function stateHash(uint256[] memory balances, uint256[] memory pricesWad) internal pure returns (bytes32) {
        return keccak256(abi.encode(balances, pricesWad));
    }

    /// @notice Index of `token` in `assets`, `type(uint256).max` when absent.
    function indexOf(AssetState[] memory assets, address token) internal pure returns (uint256) {
        for (uint256 i = 0; i < assets.length; ++i) {
            if (assets[i].token == token) return i;
        }
        return type(uint256).max;
    }

    function abs(int256 x) internal pure returns (uint256) {
        return SignedMath.abs(x);
    }
}
