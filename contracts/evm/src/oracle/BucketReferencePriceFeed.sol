// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { Ownable, Ownable2Step } from "@openzeppelin/contracts/access/Ownable2Step.sol";

import { IBucketPriceFeed } from "../interfaces/IBucketPriceFeed.sol";

/// @title BucketReferencePriceFeed
/// @notice Reporter-published reference prices used to value Bucket assets.
/// @dev The protocol consumes prices only through `IBucketPriceFeed`; any oracle implementing it can replace this
///      contract. This implementation exists because testnet assets have no market: prices are published by
///      explicitly authorised reporters and every consumer enforces the Bucket's `maxPriceAge` on `updatedAt`.
contract BucketReferencePriceFeed is IBucketPriceFeed, Ownable2Step {
    struct Observation {
        uint192 priceWad;
        uint64 updatedAt;
    }

    event ReporterSet(address indexed reporter, bool enabled);
    event PriceUpdated(address indexed token, uint256 priceWad, uint64 updatedAt);

    error NotReporter(address caller);
    error LengthMismatch();
    error ZeroPrice(address token);

    mapping(address token => Observation) private _observations;
    mapping(address account => bool) public isReporter;

    constructor(address owner_) Ownable(owner_) { }

    function setReporter(address reporter, bool enabled) external onlyOwner {
        isReporter[reporter] = enabled;
        emit ReporterSet(reporter, enabled);
    }

    function setPrices(address[] calldata tokens, uint192[] calldata pricesWad) external {
        require(isReporter[msg.sender], NotReporter(msg.sender));
        require(tokens.length == pricesWad.length, LengthMismatch());
        uint64 timestamp = uint64(block.timestamp);
        for (uint256 i = 0; i < tokens.length; ++i) {
            require(pricesWad[i] > 0, ZeroPrice(tokens[i]));
            _observations[tokens[i]] = Observation({ priceWad: pricesWad[i], updatedAt: timestamp });
            emit PriceUpdated(tokens[i], pricesWad[i], timestamp);
        }
    }

    /// @inheritdoc IBucketPriceFeed
    function priceOf(address token) external view returns (uint256 priceWad, uint64 updatedAt) {
        Observation memory observation = _observations[token];
        require(observation.priceWad != 0, PriceUnavailable(token));
        return (observation.priceWad, observation.updatedAt);
    }
}
