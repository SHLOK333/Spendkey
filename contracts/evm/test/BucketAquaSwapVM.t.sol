// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Test, Vm } from "forge-std/Test.sol";

import { AquaRouter } from "@1inch/aqua/src/AquaRouter.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import { IPermissionedRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import { ISwapVM } from "@1inch/swap-vm/contracts/interfaces/ISwapVM.sol";
import { SwapVM } from "@1inch/swap-vm/contracts/SwapVM.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/contracts/libs/TakerTraits.sol";

import { BucketAuthority } from "../src/BucketAuthority.sol";
import { BucketCapabilities } from "../src/BucketCapabilities.sol";
import { BucketController } from "../src/BucketController.sol";
import { IBucketAuthority } from "../src/interfaces/IBucketAuthority.sol";
import { IBucketCapabilities } from "../src/interfaces/IBucketCapabilities.sol";
import { IBucketController } from "../src/interfaces/IBucketController.sol";
import { IBucketPriceFeed } from "../src/interfaces/IBucketPriceFeed.sol";
import { BucketMath } from "../src/libraries/BucketMath.sol";
import { BucketPermissions } from "../src/libraries/BucketPermissions.sol";
import { BucketReferencePriceFeed } from "../src/oracle/BucketReferencePriceFeed.sol";
import { BucketTestToken } from "../src/tokens/BucketTestToken.sol";
import { BucketCapabilityGuard } from "../src/vm/BucketCapabilityGuard.sol";
import { BucketQuote } from "../src/vm/BucketQuote.sol";
import { BucketSpendLimit } from "../src/vm/BucketSpendLimit.sol";
import { BucketSwapVMRouter } from "../src/vm/BucketSwapVMRouter.sol";
import { BucketWalletBalanceCheck } from "../src/vm/BucketWalletBalanceCheck.sol";
import {
    AssetConfig,
    BucketMeta,
    BucketSnapshot,
    BucketStatus,
    CapabilityGrant,
    CapabilityLimits,
    Intent,
    PolicyParams,
    VENUE_AQUA_SWAPVM
} from "../src/types/BucketTypes.sol";

/// @dev ENSv2 PermissionedRegistry stand-in (only the ENSv2 interfaces are vendored in lib/, not an implementation).
///      Implements exactly the reads BUCKET performs: `getOwner` and `getSubregistry`. Owners can be changed to model
///      name transfers.
contract EnsRegistryStub {
    mapping(uint256 => address) private _owners;
    mapping(bytes32 => address) private _subs;

    function setOwner(string calldata label, address owner) external {
        _owners[uint256(keccak256(bytes(label)))] = owner;
    }

    function setSubreg(string calldata label, address reg) external {
        _subs[keccak256(bytes(label))] = reg;
    }

    function getOwner(uint256 anyId) external view returns (address) {
        return _owners[anyId];
    }

    function getSubregistry(string calldata label) external view returns (IRegistry) {
        return IRegistry(_subs[keccak256(bytes(label))]);
    }

    fallback() external { }
}

/// @notice End-to-end execution through the REAL 1inch Aqua (`AquaRouter`) and the REAL SwapVM runtime
///         (`BucketSwapVMRouter`), with the real reference price feed. A fill is a taker call to `router.swap`; the
///         canonical program (Deadline, Salt, 0xd0, 0xd1, 0xd2, 0xd3) runs inside SwapVM, Aqua `pull`s tokenOut from the
///         holder's own wallet and `push`es tokenIn back to it, and the controller hooks verify the settlement.
contract BucketAquaSwapVMTest is Test {
    address internal owner = vm.addr(11);
    address internal operator = vm.addr(12);
    address internal payOperator = vm.addr(13);
    address internal payee = vm.addr(14);
    address internal guardian = vm.addr(15);
    address internal enemy = vm.addr(16);

    BucketTestToken internal usdc;
    BucketTestToken internal eth;

    EnsRegistryStub internal bucketReg;
    EnsRegistryStub internal subReg;

    AquaRouter internal aqua;
    BucketSwapVMRouter internal router;
    BucketReferencePriceFeed internal feed;
    BucketAuthority internal authority;
    BucketCapabilities internal capabilities;
    BucketController internal controller;

    bytes32 internal bucketId;
    bytes32 internal rebalanceCap;
    bytes32 internal payCap;

    // 8,000 USDC ($8,000, 72.7 %) + 1.5 ETH ($3,000, 27.3 %): USDC above its 70 % hard band → out of policy.
    uint256 internal constant INIT_USDC = 8_000e6;
    uint256 internal constant INIT_ETH = 1.5e18;

    function setUp() public {
        usdc = new BucketTestToken("Test USD Coin", "tUSDC", 6, address(this));
        eth = new BucketTestToken("Test Ether", "tETH", 18, address(this));

        bucketReg = new EnsRegistryStub();
        subReg = new EnsRegistryStub();
        bucketReg.setOwner("trading", owner);
        bucketReg.setSubreg("trading", address(subReg));
        subReg.setOwner("agent", operator);
        subReg.setOwner("payagent", payOperator);
        subReg.setOwner("guard", guardian);

        aqua = new AquaRouter(address(this));
        router = new BucketSwapVMRouter(address(aqua), address(0xdead), address(this), "BucketSwapVMRouter", "1");

        feed = new BucketReferencePriceFeed(address(this));
        feed.setReporter(address(this), true);
        _publishPrices();

        uint64 nonce = vm.getNonce(address(this));
        address predicted = vm.computeCreateAddress(address(this), nonce + 2);
        authority = new BucketAuthority(predicted);
        capabilities = new BucketCapabilities(address(authority), predicted);
        controller = new BucketController(
            IAqua(address(aqua)),
            address(router),
            IBucketAuthority(address(authority)),
            IBucketCapabilities(address(capabilities)),
            IBucketPriceFeed(address(feed))
        );
        assertEq(address(controller), predicted);

        usdc.mint(owner, INIT_USDC);
        eth.mint(owner, INIT_ETH);
        eth.mint(operator, 10e18);
        usdc.mint(operator, 10_000e6);

        vm.startPrank(owner);
        bucketId = controller.createBucket(
            IBucketController.CreateBucketParams({
                registry: IPermissionedRegistry(address(bucketReg)),
                label: "trading",
                suiObjectId: bytes32(0),
                strategyExpiry: uint40(block.timestamp + 30 days),
                params: _policy(),
                assets: _assets()
            })
        );
        // Self-custody: the holder only grants allowances; nothing is deposited anywhere.
        usdc.approve(address(aqua), type(uint256).max);
        eth.approve(address(aqua), type(uint256).max);
        usdc.approve(address(controller), type(uint256).max);
        _ship();
        rebalanceCap = capabilities.issue(bucketId, _grant("agent", BucketPermissions.PERM_REBALANCE, address(0), 5_000e18));
        payCap = capabilities.issue(bucketId, _grant("payagent", BucketPermissions.PERM_PAY, payee, 5_000e18));
        vm.stopPrank();

        vm.startPrank(operator);
        eth.approve(address(router), type(uint256).max);
        usdc.approve(address(router), type(uint256).max);
        vm.stopPrank();
    }

    // ============================================================================================ helpers

    function _publishPrices() internal {
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(eth);
        uint192[] memory prices = new uint192[](2);
        prices[0] = 1e18;
        prices[1] = 2_000e18;
        feed.setPrices(tokens, prices);
    }

    function _policy() internal pure returns (PolicyParams memory) {
        return PolicyParams({
            rebalanceThresholdBps: 1_000,
            maxSlippageBps: 100,
            maxPriceAge: 3_600,
            auctionDuration: 300,
            venueMask: VENUE_AQUA_SWAPVM,
            maxDailyTurnoverBps: 5_000,
            delegablePermissions: BucketPermissions.PERM_REBALANCE | BucketPermissions.PERM_SWAP
                | BucketPermissions.PERM_PAY | BucketPermissions.PERM_DELEGATE,
            maxExecutionValue: 10_000e18,
            maxHourlyValue: 50_000e18,
            maxDailyValue: 100_000e18
        });
    }

    function _assets() internal view returns (AssetConfig[] memory a) {
        a = new AssetConfig[](2);
        a[0] = AssetConfig({ token: address(usdc), decimals: 6, targetBps: 6_000, minBps: 5_000, maxBps: 7_000 });
        a[1] = AssetConfig({ token: address(eth), decimals: 18, targetBps: 4_000, minBps: 3_000, maxBps: 5_000 });
    }

    function _grant(string memory label, uint32 perm, address _payee, uint128 maxExec)
        internal
        view
        returns (CapabilityGrant memory)
    {
        return CapabilityGrant({
            operatorLabel: label,
            permissions: perm,
            assetMask: 3,
            venueMask: VENUE_AQUA_SWAPVM,
            validAfter: 0,
            validUntil: uint40(block.timestamp + 7 days),
            payee: _payee,
            limits: CapabilityLimits({
                maxExecutionValue: maxExec,
                maxHourlyValue: 20_000e18,
                maxDailyValue: 50_000e18,
                maxSlippageBps: 100,
                maxDailyTurnoverBps: 5_000,
                maxExecutions: 1_000
            })
        });
    }

    /// @dev Holder ships the canonical strategy of the current generation to the real Aqua, as the demo/SDK do.
    function _ship() internal returns (bytes32 orderHash) {
        ISwapVM.Order memory order;
        (order, orderHash) = controller.strategyOrder(bucketId, address(usdc), address(eth));
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(eth);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = 1e30;
        amounts[1] = 1e30;
        bytes32 shipped = aqua.ship(address(router), abi.encode(order), tokens, amounts);
        assertEq(shipped, orderHash, "Aqua strategy hash == SwapVM order hash");
    }

    function _order() internal view returns (ISwapVM.Order memory order, bytes32 orderHash) {
        return controller.strategyOrder(bucketId, address(usdc), address(eth));
    }

    /// @dev Exact-in taker data: the taker gives `tokenIn` (the Bucket's buy leg) via transferFrom + Aqua push.
    function _takerData(address taker, address tokenIn) internal view returns (bytes memory) {
        (address tokenA,) = address(usdc) < address(eth) ? (address(usdc), address(eth)) : (address(eth), address(usdc));
        TakerTraitsLib.Args memory a;
        a.taker = taker;
        a.isExactIn = true;
        a.isAToB = tokenIn == tokenA;
        a.threshold = abi.encode(uint256(1));
        a.useTransferFromAndAquaPush = true;
        return TakerTraitsLib.build(a);
    }

    function _swap(address taker, address tokenIn, uint256 amountIn) internal returns (uint256, uint256, bytes32) {
        (ISwapVM.Order memory order,) = _order();
        bytes memory td = _takerData(taker, tokenIn);
        vm.prank(taker);
        return router.swap(order, amountIn, td);
    }

    /// @dev Prepares the order before arming the revert expectation, so it applies to `router.swap` itself.
    ///      `selector == 0` expects any revert.
    function _swapReverts(address taker, address tokenIn, uint256 amountIn, bytes4 selector) internal {
        (ISwapVM.Order memory order,) = _order();
        bytes memory td = _takerData(taker, tokenIn);
        if (selector == bytes4(0)) vm.expectRevert();
        else vm.expectPartialRevert(selector);
        vm.prank(taker);
        router.swap(order, amountIn, td);
    }

    function _openRebalance() internal returns (bytes32 intentId) {
        vm.prank(operator);
        intentId = controller.openRebalanceIntent(bucketId, rebalanceCap);
    }

    function _weightBps(uint256 usdcBal, uint256 ethBal) internal pure returns (uint256 usdcBps) {
        uint256 usdcVal = usdcBal * 1e12; // 6 → 18 decimals at $1
        uint256 ethVal = ethBal * 2_000;
        return usdcVal * 10_000 / (usdcVal + ethVal);
    }

    // ============================================================================ 9-11  real Aqua + SwapVM fill

    /// A rebalance fill executes end-to-end through the real router and Aqua: SwapVM quote == executed amounts,
    /// tokens move wallet-to-wallet, Aqua virtual balances move by exactly the fill, the controller records the
    /// receipt, and no contract ends up holding user funds.
    function test_Aqua_RealRebalanceFill_EndToEnd() public {
        bytes32 intentId = _openRebalance();
        Intent memory intent = controller.getIntent(intentId);
        assertEq(intent.tokenOut, address(usdc));
        assertEq(intent.tokenIn, address(eth));

        (ISwapVM.Order memory order, bytes32 orderHash) = _order();
        uint256 amountIn = 0.1e18; // $200 of ETH into the Bucket

        bytes memory td = _takerData(operator, address(eth));
        vm.prank(operator); // SwapVM quotes for msg.sender as taker; 0xd0 requires the intent's operator
        (uint256 qIn, uint256 qOut,) = router.quote(order, amountIn, td);

        uint256 ownerUsdc0 = usdc.balanceOf(owner);
        uint256 ownerEth0 = eth.balanceOf(owner);
        uint256 opUsdc0 = usdc.balanceOf(operator);
        uint256 opEth0 = eth.balanceOf(operator);
        (uint248 aquaUsdc0,) = aqua.rawBalances(owner, address(router), orderHash, address(usdc));
        (uint248 aquaEth0,) = aqua.rawBalances(owner, address(router), orderHash, address(eth));
        uint256 nonce0 = controller.getBucket(bucketId).executionNonce;

        vm.recordLogs();
        (uint256 amtIn, uint256 amtOut, bytes32 filledHash) = _swap(operator, address(eth), amountIn);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        // SwapVM quote and execution agree; the fill went through the canonical order.
        assertEq(filledHash, orderHash);
        assertEq(amtIn, qIn);
        assertEq(amtOut, qOut);
        assertEq(amtIn, amountIn);
        assertEq(amtOut, 200e6, "fresh intent: zero auction discount at the reference price");

        // 10  Actual ERC-20 movement: wallet ↔ wallet, exact amounts.
        assertEq(usdc.balanceOf(owner), ownerUsdc0 - amtOut);
        assertEq(eth.balanceOf(owner), ownerEth0 + amtIn);
        assertEq(usdc.balanceOf(operator), opUsdc0 + amtOut);
        assertEq(eth.balanceOf(operator), opEth0 - amtIn);

        // 7  Self-custody: no protocol contract holds any user funds after the fill.
        for (uint256 i = 0; i < 2; ++i) {
            BucketTestToken t = i == 0 ? usdc : eth;
            assertEq(t.balanceOf(address(aqua)), 0, "Aqua holds nothing");
            assertEq(t.balanceOf(address(router)), 0, "router holds nothing");
            assertEq(t.balanceOf(address(controller)), 0, "controller holds nothing");
        }

        // Aqua virtual balances moved by exactly the fill (pull out of USDC, push into ETH).
        (uint248 aquaUsdc1,) = aqua.rawBalances(owner, address(router), orderHash, address(usdc));
        (uint248 aquaEth1,) = aqua.rawBalances(owner, address(router), orderHash, address(eth));
        assertEq(aquaUsdc1, aquaUsdc0 - amtOut);
        assertEq(aquaEth1, aquaEth0 + amtIn);

        // 11  Post-execution allocation invariant: USDC moved toward target, not past it.
        uint256 w0 = _weightBps(ownerUsdc0, ownerEth0);
        uint256 w1 = _weightBps(usdc.balanceOf(owner), eth.balanceOf(owner));
        assertLt(w1, w0);
        assertGe(w1, 6_000);

        // Controller receipt + events from every layer.
        assertEq(controller.getBucket(bucketId).executionNonce, nonce0 + 1);
        bool sawExecution;
        bool sawSwapped;
        bool sawPulled;
        bool sawPushed;
        for (uint256 i = 0; i < logs.length; ++i) {
            bytes32 sig = logs[i].topics[0];
            if (logs[i].emitter == address(controller) && sig == IBucketController.ExecutionRecorded.selector) {
                sawExecution = true;
            }
            if (logs[i].emitter == address(router) && sig == SwapVM.Swapped.selector) sawSwapped = true;
            if (logs[i].emitter == address(aqua) && sig == IAqua.Pulled.selector) sawPulled = true;
            if (logs[i].emitter == address(aqua) && sig == IAqua.Pushed.selector) sawPushed = true;
        }
        assertTrue(sawExecution, "controller ExecutionRecorded");
        assertTrue(sawSwapped, "SwapVM Swapped");
        assertTrue(sawPulled, "Aqua Pulled");
        assertTrue(sawPushed, "Aqua Pushed");
    }

    /// Repeated real fills bring the Bucket back into policy; the intent closes as FULFILLED.
    function test_Aqua_RebalancesIntoPolicy_ClosesIntent() public {
        _openRebalance();
        _swap(operator, address(eth), 0.69e18); // $1,380 of the $1,400 excess
        BucketMeta memory m = controller.getBucket(bucketId);
        assertEq(m.activeIntent, bytes32(0), "rebalanced -> intent closed");
        uint256 w = _weightBps(usdc.balanceOf(owner), eth.balanceOf(owner));
        assertLe(w, 7_000, "USDC back inside its hard band");
        assertGe(w, 6_000, "no overshoot past target");
    }

    // ================================================================================== 8  opcode rejections

    /// 0xd0: no open intent → the guard rejects before any transfer.
    function test_d0_Rejects_NoOpenIntent() public {
        _swapReverts(operator, address(eth), 0.1e18, BucketCapabilityGuard.BucketNoOpenIntent.selector);
    }

    /// 0xd0: a taker that is not the intent's operator cannot fill it.
    function test_d0_Rejects_TakerNotOperator() public {
        _openRebalance();
        eth.mint(enemy, 1e18);
        vm.prank(enemy);
        eth.approve(address(router), type(uint256).max);
        _swapReverts(enemy, address(eth), 0.1e18, BucketCapabilityGuard.BucketTakerNotOperator.selector);
    }

    /// 0xd0: filling against the intent's direction (Bucket buys the overweight asset) is rejected.
    function test_d0_Rejects_WrongDirection() public {
        _openRebalance();
        _swapReverts(operator, address(usdc), 100e6, BucketCapabilityGuard.BucketIntentDirectionMismatch.selector);
    }

    /// 0xd0: revoking the capability after the intent opened makes the open intent unfillable.
    function test_d0_Rejects_CapabilityRevokedMidIntent() public {
        _openRebalance();
        vm.prank(owner);
        capabilities.revoke(rebalanceCap);
        _swapReverts(operator, address(eth), 0.1e18, IBucketCapabilities.CapabilityRevokedError.selector);
    }

    /// 0xd0 + ENSv2: the operator's authority is the live name; transferring `agent` away kills the capability.
    function test_d0_Rejects_OperatorLostEnsName() public {
        _openRebalance();
        subReg.setOwner("agent", enemy);
        _swapReverts(operator, address(eth), 0.1e18, IBucketCapabilities.CapabilityOperatorNameLost.selector);
    }

    /// 0xd0: an order from a superseded strategy generation is not canonical.
    function test_d0_Rejects_StaleStrategyGeneration() public {
        _openRebalance();
        (ISwapVM.Order memory stale,) = _order();
        vm.prank(owner);
        controller.rotateStrategies(bucketId, uint40(block.timestamp + 60 days));
        bytes memory td = _takerData(operator, address(eth));
        vm.expectPartialRevert(BucketCapabilityGuard.BucketStrategyNotCanonical.selector);
        vm.prank(operator);
        router.swap(stale, 0.1e18, td);
    }

    /// 0xd1: a fill that would push ETH past its target (overshoot) is rejected by the quote.
    function test_d1_Rejects_TargetOvershoot() public {
        _openRebalance();
        _swapReverts(operator, address(eth), 0.8e18, BucketQuote.BucketTargetOvershoot.selector); // $1,600 > $1,400 deficit
    }

    /// 0xd0: an intent lives for the auction duration (300 s); a late fill is rejected.
    function test_d0_Rejects_ExpiredIntent() public {
        _openRebalance();
        vm.warp(block.timestamp + 301);
        _swapReverts(operator, address(eth), 0.1e18, BucketCapabilityGuard.BucketIntentExpired.selector);
    }

    /// Stale reference prices (maxPriceAge = 1 h) block opening an intent, so nothing can be priced off them.
    function test_Policy_Rejects_StalePriceAtIntentOpen() public {
        vm.warp(block.timestamp + 2 hours);
        vm.expectPartialRevert(BucketMath.BucketMathPriceStale.selector);
        vm.prank(operator);
        controller.openRebalanceIntent(bucketId, rebalanceCap);
    }

    /// 0xd2: a fill above the capability's per-execution value is rejected.
    function test_d2_Rejects_ExecutionLimit() public {
        vm.prank(owner);
        bytes32 small = capabilities.issue(bucketId, _grant("agent", BucketPermissions.PERM_REBALANCE, address(0), 100e18));
        vm.prank(operator);
        controller.openRebalanceIntent(bucketId, small);
        _swapReverts(operator, address(eth), 0.1e18, BucketSpendLimit.BucketExecutionLimitExceeded.selector); // $200 > $100
    }

    /// 0xd3: the holder's live wallet balance must cover amountOut even though Aqua's virtual balance (1e30) would.
    function test_d3_Rejects_WalletDrainedBelowFill() public {
        vm.prank(owner);
        bytes32 swapCap = capabilities.issue(bucketId, _grant("agent", BucketPermissions.PERM_SWAP, address(0), 5_000e18));
        vm.prank(operator);
        controller.openSwapIntent(bucketId, swapCap, address(eth), address(usdc), 0.1e18);

        // Holder moves almost all ETH out of the wallet through a path Aqua does not track.
        vm.prank(owner);
        eth.transfer(enemy, INIT_ETH - 0.01e18);

        _swapReverts(operator, address(usdc), 200e6, BucketWalletBalanceCheck.BucketInsufficientWalletBalance.selector);
    }

    // ============================================================================ 7  self-custodial exits

    /// The holder can exit without the controller: docking the Aqua strategy makes every fill impossible.
    function test_SelfCustody_DockStopsFills() public {
        _openRebalance();
        (, bytes32 orderHash) = _order();
        address[] memory tokens = new address[](2);
        tokens[0] = address(usdc);
        tokens[1] = address(eth);
        vm.prank(owner);
        aqua.dock(address(router), orderHash, tokens);
        _swapReverts(operator, address(eth), 0.1e18, IAqua.SafeBalancesForTokenNotInActiveStrategy.selector);
        assertEq(usdc.balanceOf(owner), INIT_USDC);
    }

    /// Revoking the ERC-20 allowance to Aqua also stops fills; balances never left the wallet.
    function test_SelfCustody_RevokeAllowanceStopsFills() public {
        _openRebalance();
        vm.prank(owner);
        usdc.approve(address(aqua), 0);
        _swapReverts(operator, address(eth), 0.1e18, bytes4(keccak256("SafeTransferFromFailed()")));
        assertEq(usdc.balanceOf(owner), INIT_USDC);
        assertEq(eth.balanceOf(owner), INIT_ETH);
    }

    // =============================================================================== 6  PERM_PAY payments

    function test_Pay_WalletToPayee_EmitsReceipt() public {
        vm.recordLogs();
        vm.prank(payOperator);
        controller.pay(bucketId, payCap, address(usdc), 100e6);
        assertEq(usdc.balanceOf(payee), 100e6);
        assertEq(usdc.balanceOf(owner), INIT_USDC - 100e6);
        assertEq(usdc.balanceOf(address(controller)), 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bool saw;
        for (uint256 i = 0; i < logs.length; ++i) {
            if (logs[i].emitter == address(controller) && logs[i].topics[0] == IBucketController.ExecutionRecorded.selector) {
                saw = true;
            }
        }
        assertTrue(saw, "ExecutionRecorded");
    }

    function test_Pay_Rejects_WrongOperator() public {
        vm.expectPartialRevert(IBucketCapabilities.CapabilityOperatorMismatch.selector);
        vm.prank(enemy);
        controller.pay(bucketId, payCap, address(usdc), 1e6);
    }

    function test_Pay_Rejects_RebalanceCapabilityCannotPay() public {
        vm.expectPartialRevert(IBucketCapabilities.CapabilityPermissionDenied.selector);
        vm.prank(operator);
        controller.pay(bucketId, rebalanceCap, address(usdc), 1e6);
    }

    function test_Pay_Rejects_AfterRevoke() public {
        vm.prank(owner);
        capabilities.revoke(payCap);
        vm.expectPartialRevert(IBucketCapabilities.CapabilityRevokedError.selector);
        vm.prank(payOperator);
        controller.pay(bucketId, payCap, address(usdc), 1e6);
    }

    function test_Pay_Rejects_HolderRevokedAllowance() public {
        vm.prank(owner);
        usdc.approve(address(controller), 0);
        vm.expectRevert();
        vm.prank(payOperator);
        controller.pay(bucketId, payCap, address(usdc), 1e6);
        assertEq(usdc.balanceOf(owner), INIT_USDC);
    }

    // ==================================================================== 5  Bucket state + guardian restrictions

    function test_Guardian_PauseBlocksFillsAndPayments_CannotResume() public {
        vm.prank(owner);
        address g = authority.authorizeGuardian(bucketId, "guard");
        assertEq(g, guardian);
        assertTrue(authority.isGuardian(bucketId, guardian));

        _openRebalance();
        vm.prank(guardian);
        controller.pause(bucketId);
        assertEq(uint8(controller.getBucket(bucketId).status), uint8(BucketStatus.PAUSED));
        assertEq(controller.getBucket(bucketId).activeIntent, bytes32(0), "pause closes the intent");

        _swapReverts(operator, address(eth), 0.1e18, BucketCapabilityGuard.BucketInactive.selector);
        vm.expectPartialRevert(IBucketController.BucketNotActive.selector);
        vm.prank(payOperator);
        controller.pay(bucketId, payCap, address(usdc), 1e6);

        // A guardian can stop, never start, spend, or reconfigure.
        vm.expectRevert();
        vm.prank(guardian);
        controller.setStatus(bucketId, BucketStatus.ACTIVE);
        vm.expectRevert();
        vm.prank(guardian);
        capabilities.issue(bucketId, _grant("agent", BucketPermissions.PERM_REBALANCE, address(0), 1e18));
        vm.expectRevert();
        vm.prank(guardian);
        controller.updatePolicy(bucketId, _policy(), _assets());

        vm.prank(owner);
        controller.setStatus(bucketId, BucketStatus.ACTIVE);
        assertEq(uint8(controller.getBucket(bucketId).status), uint8(BucketStatus.ACTIVE));
    }

    function test_Guardian_RevokedGuardianCannotPause() public {
        vm.startPrank(owner);
        authority.authorizeGuardian(bucketId, "guard");
        authority.revokeGuardian(bucketId, guardian);
        vm.stopPrank();
        vm.expectPartialRevert(IBucketController.NotOwnerOrGuardian.selector);
        vm.prank(guardian);
        controller.pause(bucketId);
    }

    function test_Guardian_NameTransferRemovesGuardian() public {
        vm.prank(owner);
        authority.authorizeGuardian(bucketId, "guard");
        subReg.setOwner("guard", enemy);
        assertFalse(authority.isGuardian(bucketId, guardian), "live ENSv2 re-check");
        assertFalse(authority.isGuardian(bucketId, enemy), "new name owner is not granted automatically");
    }

    // ============================================================================ 12  privilege escalation

    function test_Escalation_NonOwnerCannotIssueOrReconfigure() public {
        vm.expectPartialRevert(IBucketCapabilities.NotBucketOwner.selector);
        vm.prank(operator);
        capabilities.issue(bucketId, _grant("agent", BucketPermissions.PERM_PAY, operator, 1e18));

        vm.expectRevert();
        vm.prank(enemy);
        controller.updatePolicy(bucketId, _policy(), _assets());

        vm.expectRevert();
        vm.prank(enemy);
        controller.rotateStrategies(bucketId, uint40(block.timestamp + 1 days));

        vm.expectRevert();
        vm.prank(operator);
        capabilities.revoke(payCap);
    }

    function test_Escalation_ChildCannotExceedParentLimits() public {
        vm.prank(owner);
        bytes32 parent = capabilities.issue(
            bucketId,
            _grant("agent", BucketPermissions.PERM_REBALANCE | BucketPermissions.PERM_DELEGATE, address(0), 1_000e18)
        );
        subReg.setSubreg("agent", address(new EnsRegistryStub()));
        vm.expectRevert();
        vm.prank(operator);
        capabilities.delegate(parent, _grant("exec", BucketPermissions.PERM_REBALANCE, address(0), 2_000e18));
    }

    /// The router is the only settlement entrypoint; a taker cannot call the hooks to fake a settlement.
    function test_Escalation_DirectHookCallRejected() public {
        _openRebalance();
        (, bytes32 orderHash) = _order();
        vm.expectPartialRevert(IBucketController.OnlyRouter.selector);
        vm.prank(operator);
        controller.postTransferIn(owner, operator, address(eth), address(usdc), 1, 1, 0, orderHash, abi.encode(bucketId), "");
    }

    /// Owner losing the ENSv2 name loses the ability to issue new capabilities over the wallet.
    function test_Escalation_OwnerNameTransferBlocksNewCapabilities() public {
        bucketReg.setOwner("trading", enemy);
        vm.expectRevert();
        vm.prank(owner);
        capabilities.issue(bucketId, _grant("agent", BucketPermissions.PERM_REBALANCE, address(0), 1e18));
        vm.expectRevert();
        vm.prank(enemy);
        capabilities.issue(bucketId, _grant("agent", BucketPermissions.PERM_REBALANCE, address(0), 1e18));
    }

    function test_Snapshot_ReadsLiveWalletBalances() public view {
        BucketSnapshot memory s = controller.loadBucket(bucketId);
        assertEq(s.holder, owner);
        assertEq(s.assets[0].balance, INIT_USDC);
        assertEq(s.assets[1].balance, INIT_ETH);
    }
}
