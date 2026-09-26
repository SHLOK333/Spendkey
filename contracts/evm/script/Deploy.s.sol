// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { AquaRouter } from "@1inch/aqua/src/AquaRouter.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { BucketAuthority } from "../src/BucketAuthority.sol";
import { BucketCapabilities } from "../src/BucketCapabilities.sol";
import { BucketController } from "../src/BucketController.sol";
import { IBucketAuthority } from "../src/interfaces/IBucketAuthority.sol";
import { IBucketCapabilities } from "../src/interfaces/IBucketCapabilities.sol";
import { IBucketPriceFeed } from "../src/interfaces/IBucketPriceFeed.sol";
import { BucketReferencePriceFeed } from "../src/oracle/BucketReferencePriceFeed.sol";
import { BucketTestToken } from "../src/tokens/BucketTestToken.sol";
import { BucketSwapVMRouter } from "../src/vm/BucketSwapVMRouter.sol";

/// @title Deploy
/// @notice Deploys the BUCKET EVM execution layer.
/// @dev Environment
///        AQUA_ADDRESS        optional; an existing Aqua deployment to reuse. When unset the official, unmodified
///                            `AquaRouter` source vendored from github.com/1inch/aqua is deployed (the official
///                            deterministic deployment does not include Sepolia).
///        WETH_ADDRESS        WETH used by the SwapVM router (Sepolia canonical WETH by default)
///        PRICE_REPORTER      account allowed to publish reference prices (deployer by default)
///      Output: deployments/evm-<chainId>.json
contract Deploy is Script {
    address internal constant SEPOLIA_WETH = 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14;

    struct Deployed {
        address aqua;
        address router;
        address priceFeed;
        address authority;
        address capabilities;
        address controller;
        address usdc;
        address eth;
        address sui;
        address rogue;
    }

    function run() external returns (Deployed memory d) {
        address deployer = msg.sender;
        address weth = vm.envOr("WETH_ADDRESS", SEPOLIA_WETH);
        address reporter = vm.envOr("PRICE_REPORTER", deployer);
        address existingAqua = vm.envOr("AQUA_ADDRESS", address(0));

        vm.startBroadcast();

        d.aqua = existingAqua != address(0) ? existingAqua : address(new AquaRouter(deployer));
        d.router = address(new BucketSwapVMRouter(d.aqua, weth, deployer, "BucketSwapVMRouter", "1"));

        BucketReferencePriceFeed feed = new BucketReferencePriceFeed(deployer);
        feed.setReporter(reporter, true);
        d.priceFeed = address(feed);

        // Authority, capabilities and controller reference each other immutably: precompute the controller address.
        uint64 nonce = vm.getNonce(deployer);
        address predictedController = vm.computeCreateAddress(deployer, nonce + 2);
        d.authority = address(new BucketAuthority(predictedController));
        d.capabilities = address(new BucketCapabilities(d.authority, predictedController));
        d.controller = address(
            new BucketController(
                IAqua(d.aqua),
                d.router,
                IBucketAuthority(d.authority),
                IBucketCapabilities(d.capabilities),
                IBucketPriceFeed(d.priceFeed)
            )
        );
        require(d.controller == predictedController, "controller address mismatch");

        d.usdc = address(new BucketTestToken("Bucket Test USD Coin", "tUSDC", 6, deployer));
        d.eth = address(new BucketTestToken("Bucket Test Ether", "tETH", 18, deployer));
        d.sui = address(new BucketTestToken("Bucket Test SUI", "tSUI", 9, deployer));
        // A priced token that is deliberately never part of a Bucket policy (unapproved-asset scenarios).
        d.rogue = address(new BucketTestToken("Bucket Test Unapproved Token", "tPEPE", 18, deployer));

        vm.stopBroadcast();

        _write(d);
    }

    function _write(Deployed memory d) internal {
        string memory key = "evm";
        vm.serializeUint(key, "chainId", block.chainid);
        vm.serializeAddress(key, "aqua", d.aqua);
        vm.serializeAddress(key, "router", d.router);
        vm.serializeAddress(key, "priceFeed", d.priceFeed);
        vm.serializeAddress(key, "authority", d.authority);
        vm.serializeAddress(key, "capabilities", d.capabilities);
        vm.serializeAddress(key, "controller", d.controller);
        vm.serializeAddress(key, "tUSDC", d.usdc);
        vm.serializeAddress(key, "tETH", d.eth);
        vm.serializeAddress(key, "tSUI", d.sui);
        string memory json = vm.serializeAddress(key, "tPEPE", d.rogue);

        string memory path = string.concat(vm.projectRoot(), "/deployments/evm-", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
        console2.log("deployment written to", path);
    }
}
