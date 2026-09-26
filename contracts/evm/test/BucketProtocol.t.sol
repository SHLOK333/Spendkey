// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";

import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";
import { IRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";
import { IPermissionedRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";

import { Context } from "@1inch/swap-vm/contracts/libs/VM.sol";
import { BucketWalletBalanceCheck } from "../src/vm/BucketWalletBalanceCheck.sol";

/// @dev Harness for BucketWalletBalanceCheck.  Accepts plain scalars (no internal types
///      cross the external boundary), constructs Context internally, and provides an
///      empty calldata slice for the unused `args` parameter.
contract BucketWalletBalanceCheckHarness {
    function execWith(address maker, address tokenOut, uint256 amountOut) external view {
        Context memory ctx;
        ctx.query.maker    = maker;
        ctx.query.tokenOut = tokenOut;
        ctx.swap.amountOut = amountOut;
        // BucketWalletBalanceCheck.exec ignores args entirely; pass an empty
        // calldata slice to satisfy the `bytes calldata` parameter type.
        BucketWalletBalanceCheck.exec(ctx, msg.data[msg.data.length:]);
    }
}

import { BucketAuthority } from "../src/BucketAuthority.sol";
import { BucketCapabilities } from "../src/BucketCapabilities.sol";
import { BucketController } from "../src/BucketController.sol";
import { IBucketAuthority } from "../src/interfaces/IBucketAuthority.sol";
import { IBucketCapabilities } from "../src/interfaces/IBucketCapabilities.sol";
import { IBucketController } from "../src/interfaces/IBucketController.sol";
import { IBucketPriceFeed } from "../src/interfaces/IBucketPriceFeed.sol";
import { BucketPermissions } from "../src/libraries/BucketPermissions.sol";
import { BucketTestToken } from "../src/tokens/BucketTestToken.sol";
import {
    AssetConfig,
    BucketMeta,
    BucketStatus,
    Capability,
    CapabilityGrant,
    CapabilityLimits,
    CapabilityStatus,
    Intent,
    PolicyParams,
    VENUE_AQUA_SWAPVM,
    WAD,
    BPS
} from "../src/types/BucketTypes.sol";

// ─────────────────────────────────────────────────────────────────────────────
// Mock helpers
// ─────────────────────────────────────────────────────────────────────────────

/// @dev Minimal ENSv2 registry stub: implements only the two selectors that
///      BucketAuthority and BucketCapabilities actually call.  Everything else
///      goes to the fallback and returns zero.
contract MockPermissionedRegistry {
    mapping(uint256 => address) private _owners;
    mapping(bytes32 => address) private _subs;

    function setOwner(uint256 labelId, address owner) external {
        _owners[labelId] = owner;
    }

    function setSubreg(string calldata label, address reg) external {
        _subs[keccak256(bytes(label))] = reg;
    }

    // IPermissionedRegistry.getOwner
    function getOwner(uint256 anyId) external view returns (address) {
        return _owners[anyId];
    }

    // IRegistry.getSubregistry
    function getSubregistry(string calldata label) external view returns (IRegistry) {
        return IRegistry(_subs[keccak256(bytes(label))]);
    }

    // IRegistry.getResolver — unused, returns zero
    function getResolver(string calldata) external pure returns (address) {
        return address(0);
    }

    // IRegistry.getParent — unused, returns zeros
    function getParent() external pure returns (IRegistry, string memory) {
        return (IRegistry(address(0)), "");
    }

    // Absorbs all other selectors (ERC-1155, EAC, etc.) without reverting
    fallback() external {}
}

/// @dev Minimal Aqua stub.  Token transfers in the settlement tests are done
///      directly (simulating pull/push), so the stub just satisfies the IAqua
///      interface without performing any real transfers.
contract MockAqua {
    function rawBalances(address, address, bytes32, address) external pure returns (uint248, uint8) {
        return (0, 0);
    }

    function safeBalances(address, address, bytes32, address, address) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    function ship(address, bytes calldata, address[] calldata, uint256[] calldata) external returns (bytes32) {
        return bytes32(0);
    }

    function dock(address, bytes32, address[] calldata) external {}

    function pull(address, bytes32, address, uint256, address) external {}

    function push(address, address, bytes32, address, uint256) external {}

    fallback() external {}
}

/// @dev Minimal router stub.  BucketController only checks msg.sender == ROUTER.
contract MockRouter {
    fallback() external payable {}
}

/// @dev Configurable reference-price feed.
contract MockPriceFeed {
    mapping(address => uint256) public priceWads;

    function setPrice(address token, uint256 priceWad) external {
        priceWads[token] = priceWad;
    }

    function priceOf(address token) external view returns (uint256, uint64) {
        return (priceWads[token], uint64(block.timestamp));
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Test suite
// ─────────────────────────────────────────────────────────────────────────────

contract BucketProtocolTest is Test {
    // ── accounts ──────────────────────────────────────────────────────────────
    // Derived from uint256 seeds via vm.addr(); no private key is printed or stored.
    address internal owner;         // ENSv2 owner of "trading" label, Bucket holder
    address internal operator;      // ENSv2 owner of "agent" label  (REBALANCE/DELEGATE)
    address internal childOperator; // ENSv2 owner of "exec" label   (child REBALANCE)
    address internal payOperator;   // ENSv2 owner of "payagent" label (PAY)
    address internal payee;         // fixed payee for PAY capability
    address internal enemy;         // unauthorized actor

    // ── infrastructure ────────────────────────────────────────────────────────
    BucketTestToken internal tUSDC;
    BucketTestToken internal tETH;

    MockPermissionedRegistry internal bucketReg;
    MockPermissionedRegistry internal operatorSubreg;
    MockPermissionedRegistry internal agentSubreg;   // subregistry of "agent" for child-cap resolution
    MockAqua internal mockAqua;
    MockRouter internal mockRouter;
    MockPriceFeed internal priceFeed;

    BucketAuthority internal authority;
    BucketCapabilities internal capabilities;
    BucketController internal controller;

    // ── protocol objects created in _setupBucket ──────────────────────────────
    bytes32 internal bucketId;
    bytes32 internal capabilityId;  // root REBALANCE | DELEGATE capability
    bytes32 internal payCapId;      // root PAY capability with fixed payee
    bytes32 internal childCapId;    // child of capabilityId (depth 1)

    // ── instruction harnesses ─────────────────────────────────────────────────
    BucketWalletBalanceCheckHarness internal d3Harness;

    // ── constants ─────────────────────────────────────────────────────────────
    uint256 internal constant USDC_PRICE = 1e18;      // $1.00 (WAD)
    uint256 internal constant ETH_PRICE  = 2000e18;   // $2,000.00 (WAD)

    // Initial balances: tUSDC 72.7 % ($8,000), tETH 27.3 % ($3,000)
    // tUSDC exceeds its maxBps hard band of 70 % → Bucket starts OUT OF POLICY.
    uint256 internal constant INIT_USDC = 8_000e6;   // 8,000 USDC (6 decimals)
    uint256 internal constant INIT_ETH  = 1.5e18;    // 1.5 ETH   (18 decimals)
    // Total initial value: $11,000

    function setUp() public {
        // ── accounts ──────────────────────────────────────────────────────────
        owner         = vm.addr(1);
        operator      = vm.addr(2);
        payOperator   = vm.addr(3);
        enemy         = vm.addr(4);
        payee         = vm.addr(5);
        childOperator = vm.addr(6);

        // ── tokens ────────────────────────────────────────────────────────────
        tUSDC = new BucketTestToken("Test USD Coin", "tUSDC", 6,  address(this));
        tETH  = new BucketTestToken("Test Ether",    "tETH", 18, address(this));

        // ── ENSv2 mock registry ───────────────────────────────────────────────
        bucketReg      = new MockPermissionedRegistry();
        operatorSubreg = new MockPermissionedRegistry();
        agentSubreg    = new MockPermissionedRegistry();

        // "trading" → owner;  subregistry of "trading" → operatorSubreg
        bucketReg.setOwner(uint256(keccak256(bytes("trading"))), owner);
        bucketReg.setSubreg("trading", address(operatorSubreg));

        // "agent" → operator,  "payagent" → payOperator  (in operatorSubreg)
        // Subregistry of "agent" → agentSubreg (needed to resolve child-cap operator labels)
        operatorSubreg.setOwner(uint256(keccak256(bytes("agent"))),    operator);
        operatorSubreg.setOwner(uint256(keccak256(bytes("payagent"))), payOperator);
        operatorSubreg.setSubreg("agent", address(agentSubreg));

        // "exec" → childOperator  (in agentSubreg, for child-cap delegation)
        agentSubreg.setOwner(uint256(keccak256(bytes("exec"))), childOperator);

        // ── price feed ────────────────────────────────────────────────────────
        priceFeed = new MockPriceFeed();
        priceFeed.setPrice(address(tUSDC), USDC_PRICE);
        priceFeed.setPrice(address(tETH),  ETH_PRICE);

        // ── mock Aqua + router ────────────────────────────────────────────────
        mockAqua   = new MockAqua();
        mockRouter = new MockRouter();
        d3Harness  = new BucketWalletBalanceCheckHarness();

        // ── Deploy authority / capabilities / controller ──────────────────────
        // These three reference each other immutably; precompute the controller
        // address from the deployer (address(this)) nonce before any of them is deployed.
        uint64 startNonce = vm.getNonce(address(this));
        address predictedController = vm.computeCreateAddress(address(this), startNonce + 2);

        authority    = new BucketAuthority(predictedController);
        capabilities = new BucketCapabilities(address(authority), predictedController);
        controller   = new BucketController(
            IAqua(address(mockAqua)),
            address(mockRouter),
            IBucketAuthority(address(authority)),
            IBucketCapabilities(address(capabilities)),
            IBucketPriceFeed(address(priceFeed))
        );
        assertEq(address(controller), predictedController, "controller address prediction mismatch");

        // ── Fund holder ───────────────────────────────────────────────────────
        tUSDC.mint(owner, INIT_USDC);
        tETH.mint(owner, INIT_ETH);

        // Owner approves controller for capability-gated payments
        vm.prank(owner);
        tUSDC.approve(address(controller), type(uint256).max);

        // ── Create Bucket and issue capabilities ──────────────────────────────
        _setupBucket();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Setup helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _policy() internal view returns (PolicyParams memory) {
        return PolicyParams({
            rebalanceThresholdBps: 1_000,  // 10 %
            maxSlippageBps:        100,    // 1 %
            maxPriceAge:           3_600,  // 1 hour
            auctionDuration:       300,    // 5 min
            venueMask:             VENUE_AQUA_SWAPVM,
            maxDailyTurnoverBps:   5_000,  // 50 %
            delegablePermissions:  BucketPermissions.PERM_REBALANCE
                                 | BucketPermissions.PERM_SWAP
                                 | BucketPermissions.PERM_PAY
                                 | BucketPermissions.PERM_DELEGATE,
            maxExecutionValue:     10_000e18,
            maxHourlyValue:        50_000e18,
            maxDailyValue:         100_000e18
        });
    }

    function _assets() internal view returns (AssetConfig[] memory a) {
        a = new AssetConfig[](2);
        // tUSDC: target 60 %, hard band [50 %, 70 %]
        a[0] = AssetConfig({ token: address(tUSDC), decimals: 6,  targetBps: 6_000, minBps: 5_000, maxBps: 7_000 });
        // tETH:  target 40 %, hard band [30 %, 50 %]
        a[1] = AssetConfig({ token: address(tETH),  decimals: 18, targetBps: 4_000, minBps: 3_000, maxBps: 5_000 });
    }

    function _capGrant(string memory label, uint32 perm, address _payee) internal view
        returns (CapabilityGrant memory g)
    {
        g = CapabilityGrant({
            operatorLabel: label,
            permissions:   perm,
            assetMask:     3,   // bits: both assets (index 0 and 1)
            venueMask:     VENUE_AQUA_SWAPVM,
            validAfter:    0,
            validUntil:    uint40(block.timestamp + 30 days),
            payee:         _payee,
            limits: CapabilityLimits({
                maxExecutionValue:   5_000e18,
                maxHourlyValue:      20_000e18,
                maxDailyValue:       50_000e18,
                maxSlippageBps:      100,
                maxDailyTurnoverBps: 5_000,
                maxExecutions:       1_000
            })
        });
    }

    function _setupBucket() internal {
        IBucketController.CreateBucketParams memory p = IBucketController.CreateBucketParams({
            registry:       IPermissionedRegistry(address(bucketReg)),
            label:          "trading",
            suiObjectId:    bytes32(0),
            strategyExpiry: uint40(block.timestamp + 30 days),
            params:         _policy(),
            assets:         _assets()
        });
        vm.prank(owner);
        bucketId = controller.createBucket(p);

        // Root REBALANCE | DELEGATE capability  →  operator
        vm.prank(owner);
        capabilityId = capabilities.issue(
            bucketId,
            _capGrant("agent", BucketPermissions.PERM_REBALANCE | BucketPermissions.PERM_DELEGATE, address(0))
        );

        // Root PAY capability with fixed payee  →  payOperator
        vm.prank(owner);
        payCapId = capabilities.issue(
            bucketId,
            _capGrant("payagent", BucketPermissions.PERM_PAY, payee)
        );

        // Child REBALANCE capability delegated from root to "exec" operator (depth 1)
        vm.prank(operator);
        childCapId = capabilities.delegate(
            capabilityId,
            _capGrant("exec", BucketPermissions.PERM_REBALANCE, address(0))
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Happy-path tests  (10)
    // ─────────────────────────────────────────────────────────────────────────

    /// T1  Bucket is created, bound to the ENSv2 name, and the owner is the holder.
    function test_01_CreateBucket() public view {
        BucketMeta memory meta = controller.getBucket(bucketId);
        assertEq(meta.holder,              owner,                 "holder == owner");
        assertEq(uint8(meta.status),       uint8(BucketStatus.ACTIVE), "ACTIVE");
        assertGt(uint256(bucketId),        0,                     "bucketId non-zero");
        assertEq(meta.policyVersion,       1,                     "initial policyVersion = 1");
    }

    /// T2  Updating the policy increments policyVersion and changes the policy hash.
    function test_02_UpdatePolicy() public {
        bytes32 hashBefore = controller.getBucket(bucketId).policyHash;

        PolicyParams memory p2 = _policy();
        p2.maxSlippageBps = 200;
        vm.prank(owner);
        controller.updatePolicy(bucketId, p2, _assets());

        BucketMeta memory meta = controller.getBucket(bucketId);
        assertEq(meta.policyVersion, 2,          "policyVersion incremented to 2");
        assertNotEq(meta.policyHash, hashBefore, "policyHash changed");
    }

    /// T3  Root REBALANCE capability has the correct operator and depth.
    function test_03_IssueRootCapability() public view {
        Capability memory c = capabilities.getCapability(capabilityId);
        assertEq(c.operator,      operator,                   "operator == 'agent' owner");
        assertEq(c.depth,         0,                          "root depth == 0");
        assertEq(uint8(c.status), uint8(CapabilityStatus.ACTIVE));
        assertTrue(BucketPermissions.contains(c.permissions, BucketPermissions.PERM_REBALANCE));
    }

    /// T4  Child capability has depth = 1, points to parent, and grants the child operator.
    function test_04_DelegateCapability() public view {
        Capability memory child = capabilities.getCapability(childCapId);
        assertEq(child.depth,    1,             "child depth == 1");
        assertEq(child.parentId, capabilityId,  "parent == capabilityId");
        assertEq(child.operator, childOperator, "child operator == 'exec' owner");
        assertEq(uint8(child.status), uint8(CapabilityStatus.ACTIVE));
    }

    /// T5  PAY capability carries the expected fixed payee.
    function test_05_IssuePayCapability() public view {
        Capability memory c = capabilities.getCapability(payCapId);
        assertEq(c.payee, payee, "payee matches");
        assertTrue(BucketPermissions.contains(c.permissions, BucketPermissions.PERM_PAY));
    }

    /// T6  Rotating strategies changes the strategy hash and increments the nonce.
    function test_06_RotateStrategies() public {
        BucketMeta memory before = controller.getBucket(bucketId);

        vm.prank(owner);
        controller.rotateStrategies(bucketId, uint40(block.timestamp + 60 days));

        BucketMeta memory after_ = controller.getBucket(bucketId);
        assertNotEq(after_.strategyHash,  before.strategyHash,       "strategyHash changed");
        assertEq(after_.strategyNonce,    before.strategyNonce + 1,  "strategyNonce incremented");
    }

    /// T7  openRebalanceIntent succeeds for an out-of-policy Bucket and selects the
    ///     correct leg (sell overweight tUSDC, buy underweight tETH).
    function test_07_OpenRebalanceIntent() public {
        vm.prank(operator);
        bytes32 intentId = controller.openRebalanceIntent(bucketId, capabilityId);
        assertGt(uint256(intentId), 0, "intentId non-zero");

        Intent memory intent = controller.getIntent(intentId);
        assertEq(intent.tokenOut, address(tUSDC), "selling tUSDC (overweight)");
        assertEq(intent.tokenIn,  address(tETH),  "buying tETH  (underweight)");
    }

    /// T8  capability-gated payment transfers the exact amount to the fixed payee.
    function test_08_Pay() public {
        uint256 before_ = tUSDC.balanceOf(payee);

        vm.prank(payOperator);
        controller.pay(bucketId, payCapId, address(tUSDC), 100e6);  // $100

        assertEq(tUSDC.balanceOf(payee), before_ + 100e6, "payee gained 100 USDC");
    }

    /// T9  Full settlement: preTransferOut + correct token movements + postTransferIn
    ///     all succeed, and the intent closes because the Bucket is back in policy.
    function test_09_SettlementPassesOnValidFill() public {
        // Rebalance: sell 500 USDC ($500), buy 0.25 ETH ($500 at $2,000/ETH, 0 % slippage)
        uint256 amountOut = 500e6;
        uint256 amountIn  = 0.25e18;

        // Operator needs ETH to push to the holder
        tETH.mint(operator, amountIn);

        // Open intent (Bucket is already out of policy)
        vm.prank(operator);
        bytes32 intentId = controller.openRebalanceIntent(bucketId, capabilityId);
        assertGt(uint256(intentId), 0);

        // Get canonical order hash for the (tUSDC, tETH) pair
        (, bytes32 orderHash) = controller.strategyOrder(bucketId, address(tUSDC), address(tETH));
        bytes memory makerData = abi.encode(bucketId);

        // 1. preTransferOut — snapshots holder balances to transient storage
        vm.prank(address(mockRouter));
        controller.preTransferOut(
            owner, operator, address(tETH), address(tUSDC),
            amountIn, amountOut, orderHash, makerData, ""
        );

        // 2. Simulate Aqua pull/push by moving tokens directly
        vm.prank(owner);
        tUSDC.transfer(operator, amountOut);   // pull: holder → operator

        vm.prank(operator);
        tETH.transfer(owner, amountIn);         // push: operator → holder

        // 3. postTransferIn — verifies exact deltas (C4) and allocation invariant (C5)
        vm.prank(address(mockRouter));
        controller.postTransferIn(
            owner, operator, address(tETH), address(tUSDC),
            amountIn, amountOut, 0, orderHash, makerData, ""
        );

        // Intent should be closed (Bucket back in policy after the fill)
        BucketMeta memory meta = controller.getBucket(bucketId);
        assertEq(meta.activeIntent, bytes32(0), "intent closed after settlement");
    }

    /// T10  Revoking a capability marks it REVOKED; revokeAll bumps the epoch.
    function test_10_RevokeAndEpochBump() public {
        vm.prank(owner);
        capabilities.revoke(capabilityId);
        assertEq(uint8(capabilities.getCapability(capabilityId).status), uint8(CapabilityStatus.REVOKED));

        uint32 epochBefore = capabilities.epochOf(bucketId);
        vm.prank(owner);
        capabilities.revokeAll(bucketId);
        assertEq(capabilities.epochOf(bucketId), epochBefore + 1, "epoch incremented");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Rejection tests  (10)
    // ─────────────────────────────────────────────────────────────────────────

    /// R1  An address that does not own the operator name is rejected by requireAuthorized.
    function test_Reject_01_UnauthorizedOperator() public {
        vm.expectRevert(
            abi.encodeWithSelector(
                IBucketCapabilities.CapabilityOperatorMismatch.selector,
                capabilityId, operator, enemy
            )
        );
        vm.prank(enemy);
        capabilities.requireAuthorized(capabilityId, enemy, BucketPermissions.PERM_REBALANCE, 0, VENUE_AQUA_SWAPVM);
    }

    /// R2  A child capability cannot carry permissions the parent does not grant.
    function test_Reject_02_ChildEscalationForbidden() public {
        // Root has PERM_REBALANCE | PERM_DELEGATE; PERM_SWAP is not in it.
        CapabilityGrant memory g = _capGrant("agent", BucketPermissions.PERM_SWAP, address(0));
        vm.expectRevert(
            abi.encodeWithSelector(
                IBucketCapabilities.CapabilityPermissionsNotDelegable.selector,
                BucketPermissions.PERM_SWAP,
                BucketPermissions.PERM_REBALANCE | BucketPermissions.PERM_DELEGATE
            )
        );
        vm.prank(operator);
        capabilities.delegate(capabilityId, g);
    }

    /// R3  A PAY call whose USD value exceeds the capability's maxExecutionValue reverts.
    function test_Reject_03_SpendLimitExceeded() public {
        // Issue a PAY capability capped at $1
        CapabilityGrant memory g = _capGrant("payagent", BucketPermissions.PERM_PAY, payee);
        g.limits.maxExecutionValue = 1e18;
        vm.prank(owner);
        bytes32 tinyCapId = capabilities.issue(bucketId, g);

        // Attempt to pay 100 USDC = $100 > $1
        vm.expectRevert(
            abi.encodeWithSelector(IBucketController.SpendLimitExceeded.selector, 100e18, 1e18)
        );
        vm.prank(payOperator);
        controller.pay(bucketId, tinyCapId, address(tUSDC), 100e6);
    }

    /// R4  A capability past its validUntil timestamp is rejected.
    function test_Reject_04_ExpiredCapability() public {
        CapabilityGrant memory g = _capGrant("agent", BucketPermissions.PERM_REBALANCE, address(0));
        g.validUntil = uint40(block.timestamp + 1);
        vm.prank(owner);
        bytes32 shortCapId = capabilities.issue(bucketId, g);

        vm.warp(block.timestamp + 2);

        vm.expectRevert(
            abi.encodeWithSelector(IBucketCapabilities.CapabilityExpired.selector, shortCapId, g.validUntil)
        );
        vm.prank(operator);
        capabilities.requireAuthorized(shortCapId, operator, BucketPermissions.PERM_REBALANCE, 0, VENUE_AQUA_SWAPVM);
    }

    /// R5  A revoked capability is rejected on every subsequent use.
    function test_Reject_05_RevokedCapability() public {
        vm.prank(owner);
        capabilities.revoke(capabilityId);

        vm.expectRevert(
            abi.encodeWithSelector(IBucketCapabilities.CapabilityRevokedError.selector, capabilityId)
        );
        vm.prank(operator);
        capabilities.requireAuthorized(capabilityId, operator, BucketPermissions.PERM_REBALANCE, 0, VENUE_AQUA_SWAPVM);
    }

    /// R6  A capability issued under policyVersion N is rejected after a policy update to N+1.
    function test_Reject_06_PolicyVersionMismatch() public {
        vm.prank(owner);
        controller.updatePolicy(bucketId, _policy(), _assets());  // → policyVersion 2

        vm.expectRevert(
            abi.encodeWithSelector(IBucketCapabilities.CapabilityPolicySuperseded.selector, capabilityId, 1, 2)
        );
        vm.prank(operator);
        capabilities.requireAuthorized(capabilityId, operator, BucketPermissions.PERM_REBALANCE, 0, VENUE_AQUA_SWAPVM);
    }

    /// R7  revokeAll bumps the epoch; every capability with the old epoch is rejected.
    function test_Reject_07_EpochKillSwitch() public {
        uint32 epochBefore = capabilities.epochOf(bucketId);
        vm.prank(owner);
        capabilities.revokeAll(bucketId);

        Capability memory c = capabilities.getCapability(capabilityId);
        vm.expectRevert(
            abi.encodeWithSelector(
                IBucketCapabilities.CapabilityEpochRevoked.selector,
                capabilityId, c.epoch, epochBefore + 1
            )
        );
        vm.prank(operator);
        capabilities.requireAuthorized(capabilityId, operator, BucketPermissions.PERM_REBALANCE, 0, VENUE_AQUA_SWAPVM);
    }

    /// R8  postTransferIn reverts when the declared amountOut does not match the actual balance delta.
    function test_Reject_08_BalanceDeltaMismatch() public {
        vm.prank(operator);
        controller.openRebalanceIntent(bucketId, capabilityId);

        (, bytes32 orderHash) = controller.strategyOrder(bucketId, address(tUSDC), address(tETH));
        bytes memory makerData = abi.encode(bucketId);

        vm.prank(address(mockRouter));
        controller.preTransferOut(
            owner, operator, address(tETH), address(tUSDC),
            0.25e18, 500e6, orderHash, makerData, ""
        );

        // Transfer 499 USDC instead of the 500 we will declare
        vm.prank(owner);
        tUSDC.transfer(operator, 499e6);

        // Give the holder the ETH directly (correct amount so ETH delta is fine)
        tETH.mint(owner, 0.25e18);

        // Declare amountOut = 500e6 but actual USDC delta = 499e6 → BalanceDeltaMismatch
        vm.expectRevert();
        vm.prank(address(mockRouter));
        controller.postTransferIn(
            owner, operator, address(tETH), address(tUSDC),
            0.25e18, 500e6, 0, orderHash, makerData, ""
        );
    }

    /// R9  postTransferIn reverts when a SWAP settlement puts tUSDC above its hard-band maximum.
    ///     Initial state: tUSDC = 72.7 % (already above maxBps=70 %).  A SWAP that buys more USDC
    ///     worsens it further → PostStateOutOfBand.
    function test_Reject_09_PostStateOutOfBand() public {
        // Issue a SWAP capability
        vm.prank(owner);
        bytes32 swapCapId = capabilities.issue(
            bucketId,
            _capGrant("agent", BucketPermissions.PERM_SWAP | BucketPermissions.PERM_DELEGATE, address(0))
        );

        // SWAP: sell 0.25 ETH → receive 500 USDC
        uint256 amountOut = 0.25e18;  // ETH given up
        uint256 amountIn  = 500e6;    // USDC received

        vm.prank(operator);
        controller.openSwapIntent(bucketId, swapCapId, address(tETH), address(tUSDC), amountOut);

        (, bytes32 orderHash) = controller.strategyOrder(bucketId, address(tETH), address(tUSDC));
        bytes memory makerData = abi.encode(bucketId);

        vm.prank(address(mockRouter));
        controller.preTransferOut(
            owner, operator, address(tUSDC), address(tETH),
            amountIn, amountOut, orderHash, makerData, ""
        );

        // Simulate pull (tETH from holder) and push (tUSDC to holder)
        vm.prank(owner);
        tETH.transfer(operator, amountOut);

        tUSDC.mint(owner, amountIn);  // operator "pushes" USDC; mint to owner directly

        // tUSDC: 8000e6 → 8500e6 = $8500 / $11000 ≈ 77 % > maxBps 70 % → PostStateOutOfBand
        vm.expectRevert();
        vm.prank(address(mockRouter));
        controller.postTransferIn(
            owner, operator, address(tUSDC), address(tETH),
            amountIn, amountOut, 0, orderHash, makerData, ""
        );
    }

    /// R10  Only the designated router address may call the settlement hooks.
    function test_Reject_10_NotRouter() public {
        vm.expectRevert(
            abi.encodeWithSelector(IBucketController.OnlyRouter.selector, enemy)
        );
        vm.prank(enemy);
        controller.preTransferOut(
            owner, enemy, address(tETH), address(tUSDC),
            0, 0, bytes32(0), abi.encode(bucketId), ""
        );
    }

    // ══════════════════════════════════════════════════════════════════════════
    // 0xd3 BucketWalletBalanceCheck – direct instruction tests
    // ══════════════════════════════════════════════════════════════════════════
    //
    // The BUCKET canonical program runs inside the SwapVM quote phase (Aqua's
    // internal execution); the test suite drives the settlement hooks directly
    // for most tests.  For 0xd3 we exercise the instruction library directly:
    // create a minimal Context with the relevant fields populated, pass it to
    // BucketWalletBalanceCheck.exec, and verify the expected outcomes.
    //
    // The `args` payload must be exactly 52 bytes (controller address + bucketId)
    // to satisfy BucketInstructionArgs.parse; we pass them as abi.encodePacked.

    /// d3-P1  Holder has enough balance → instruction passes without reverting.
    function test_d3_WalletBalanceCheck_Passes() public view {
        // owner starts with INIT_USDC = 8 000e6; ask for 1 000e6 → sufficient.
        d3Harness.execWith(owner, address(tUSDC), 1_000e6);
    }

    /// d3-R1  Holder balance is one unit below amountOut → BucketInsufficientWalletBalance.
    function test_d3_WalletBalanceCheck_Reverts_InsufficientBalance() public {
        uint256 holderBalance = tUSDC.balanceOf(owner);
        uint256 tooMuch       = holderBalance + 1;

        vm.expectRevert(
            abi.encodeWithSelector(
                BucketWalletBalanceCheck.BucketInsufficientWalletBalance.selector,
                address(tUSDC),
                owner,
                holderBalance,
                tooMuch
            )
        );
        d3Harness.execWith(owner, address(tUSDC), tooMuch);
    }
}
