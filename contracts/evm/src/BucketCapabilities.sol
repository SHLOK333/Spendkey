// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IBucketAuthority } from "./interfaces/IBucketAuthority.sol";
import { IBucketCapabilities } from "./interfaces/IBucketCapabilities.sol";
import { IBucketController } from "./interfaces/IBucketController.sol";
import { BucketPermissions } from "./libraries/BucketPermissions.sol";
import { BucketPolicyLib } from "./libraries/BucketPolicyLib.sol";
import { CapabilityLib, UsageLib } from "./libraries/CapabilityLib.sol";
import {
    BPS,
    MAX_DELEGATION_DEPTH,
    MAX_CAPABILITY_DURATION,
    BucketStatus,
    Capability,
    CapabilityGrant,
    CapabilityLimits,
    CapabilityStatus,
    EffectiveLimits,
    PolicyParams,
    Usage
} from "./types/BucketTypes.sol";

/// @title BucketCapabilities
/// @notice Registry of Financial Capabilities: scoped, revocable, time-bound, nonce-bound, policy-bound,
///         amount-limited, asset-limited execution authority over a Bucket's wallet liquidity.
/// @dev
///      Identity   A capability's operator is an ENSv2 name: `<label>.<bucket name>` for a root capability,
///                 `<label>.<parent operator name>` for a child. The operator address is re-resolved from the ENSv2
///                 registry on every use; transferring or unregistering the name voids the capability.
///      Hierarchy  Children are issued by their parent's operator (`PERM_DELEGATE`) and must be monotone: every
///                 permission, asset, venue, limit and time bound is within the parent's. Usage is charged to the
///                 whole chain, so a parent's velocity limits bound all of its descendants together.
///      Revocation Per capability (`revoke`, which also voids all descendants), per Bucket (`revokeAll`, epoch
///                 bump), per policy version (any policy change), per ENSv2 name change, by expiry, and
///                 automatically on exhaustion of `maxExecutions`.
///
///      Invariants
///      K1  A capability never grants an owner-only permission.
///      K2  A child capability is never wider than its parent (checked at issuance; parents are immutable).
///      K3  No capability is usable unless every link of its chain is valid at the time of use.
///      K4  Cumulative usage of every link never exceeds its hourly and daily limits (`consume` reverts).
contract BucketCapabilities is IBucketCapabilities {
    using UsageLib for Usage;

    address public immutable AUTHORITY;
    address public immutable CONTROLLER;

    mapping(bytes32 capabilityId => Capability) private _capabilities;
    mapping(bytes32 bucketId => uint32) public epochOf;
    mapping(bytes32 bucketId => uint64) public nonceOf;
    mapping(bytes32 bucketId => bytes32[]) private _bucketCapabilities;

    modifier onlyController() {
        require(msg.sender == CONTROLLER, OnlyController(msg.sender));
        _;
    }

    constructor(address authority, address controller) {
        AUTHORITY = authority;
        CONTROLLER = controller;
    }

    // =========================================================================================================
    // Issuance
    // =========================================================================================================

    /// @inheritdoc IBucketCapabilities
    function issue(bytes32 bucketId, CapabilityGrant calldata grant) external returns (bytes32) {
        (BucketStatus status, address holder, uint32 policyVersion, PolicyParams memory params, uint256 assetCount) =
            IBucketController(CONTROLLER).policyContext(bucketId);
        require(status == BucketStatus.ACTIVE, BucketNotActive(bucketId));
        address owner = IBucketAuthority(AUTHORITY).ownerOf(bucketId);
        require(owner != address(0) && msg.sender == owner, NotBucketOwner(msg.sender, owner));
        require(holder == owner, BucketHolderNotOwner(bucketId, holder, owner));

        _validateShape(grant);
        require(
            BucketPermissions.contains(params.delegablePermissions, grant.permissions),
            CapabilityPermissionsNotDelegable(grant.permissions, params.delegablePermissions)
        );
        uint8 allAssets = BucketPolicyLib.fullAssetMask(assetCount);
        require(grant.assetMask & ~allAssets == 0, CapabilityAssetsInvalid(grant.assetMask, allAssets));
        require(grant.venueMask & ~params.venueMask == 0, CapabilityVenuesInvalid(grant.venueMask, params.venueMask));

        CapabilityLimits calldata l = grant.limits;
        _requireWithin(l.maxExecutionValue, params.maxExecutionValue, "maxExecutionValue");
        _requireWithin(l.maxHourlyValue, params.maxHourlyValue, "maxHourlyValue");
        _requireWithin(l.maxDailyValue, params.maxDailyValue, "maxDailyValue");
        _requireWithin(l.maxSlippageBps, params.maxSlippageBps, "maxSlippageBps");
        _requireWithin(l.maxDailyTurnoverBps, params.maxDailyTurnoverBps, "maxDailyTurnoverBps");

        address registry = IBucketAuthority(AUTHORITY).bucketSubregistry(bucketId);
        require(registry != address(0), IssuerHasNoSubregistry(bytes32(0)));
        address operator = _resolveOperator(registry, grant.operatorLabel);
        require(operator != owner, OperatorIsIssuer(operator));

        return _store(bucketId, bytes32(0), 0, owner, operator, registry, policyVersion, grant);
    }

    /// @inheritdoc IBucketCapabilities
    function delegate(bytes32 parentId, CapabilityGrant calldata grant) external returns (bytes32) {
        Capability storage parent = _capabilities[parentId];
        _requireValid(parentId, msg.sender, BucketPermissions.PERM_DELEGATE, 0, 0);
        uint8 depth = parent.depth + 1;
        require(depth < MAX_DELEGATION_DEPTH, CapabilityDepthExceeded(depth));

        _validateShape(grant);
        require(
            BucketPermissions.contains(parent.permissions, grant.permissions),
            CapabilityPermissionsNotDelegable(grant.permissions, parent.permissions)
        );
        // A capability at the last level cannot delegate further.
        require(
            depth + 1 < MAX_DELEGATION_DEPTH || grant.permissions & BucketPermissions.PERM_DELEGATE == 0,
            CapabilityDepthExceeded(depth + 1)
        );
        require(grant.assetMask & ~parent.assetMask == 0, CapabilityAssetsInvalid(grant.assetMask, parent.assetMask));
        require(grant.venueMask & ~parent.venueMask == 0, CapabilityVenuesInvalid(grant.venueMask, parent.venueMask));
        require(
            grant.validAfter >= parent.validAfter && grant.validUntil <= parent.validUntil,
            CapabilityWindowInvalid(grant.validAfter, grant.validUntil)
        );
        if (grant.permissions & BucketPermissions.PERM_PAY != 0) {
            require(grant.payee == parent.payee, CapabilityPayeeInvalid(grant.payee));
        }

        CapabilityLimits calldata l = grant.limits;
        CapabilityLimits storage p = parent.limits;
        if (l.maxExecutionValue > p.maxExecutionValue) revert CapabilityLimitExceedsParent("maxExecutionValue");
        if (l.maxHourlyValue > p.maxHourlyValue) revert CapabilityLimitExceedsParent("maxHourlyValue");
        if (l.maxDailyValue > p.maxDailyValue) revert CapabilityLimitExceedsParent("maxDailyValue");
        if (l.maxSlippageBps > p.maxSlippageBps) revert CapabilityLimitExceedsParent("maxSlippageBps");
        if (l.maxDailyTurnoverBps > p.maxDailyTurnoverBps) revert CapabilityLimitExceedsParent("maxDailyTurnoverBps");
        if (p.maxExecutions != 0) {
            uint256 left = p.maxExecutions - parent.executions;
            if (l.maxExecutions == 0 || l.maxExecutions > left) revert CapabilityLimitExceedsParent("maxExecutions");
        }

        address registry = IBucketAuthority(AUTHORITY).subregistryOf(parent.operatorRegistry, parent.operatorLabel);
        require(registry != address(0), IssuerHasNoSubregistry(parentId));
        address operator = _resolveOperator(registry, grant.operatorLabel);
        require(operator != msg.sender, OperatorIsIssuer(operator));

        return
            _store(parent.bucketId, parentId, depth, msg.sender, operator, registry, parent.policyVersion, grant);
    }

    // =========================================================================================================
    // Revocation
    // =========================================================================================================

    /// @inheritdoc IBucketCapabilities
    function revoke(bytes32 capabilityId) external {
        Capability storage c = _capabilities[capabilityId];
        require(c.status != CapabilityStatus.NONE, CapabilityUnknown(capabilityId));
        require(c.status == CapabilityStatus.ACTIVE, CapabilityRevokedError(capabilityId));
        bytes32 bucketId = c.bucketId;
        require(
            msg.sender == c.issuer || msg.sender == IBucketAuthority(AUTHORITY).ownerOf(bucketId)
                || IBucketAuthority(AUTHORITY).isGuardian(bucketId, msg.sender),
            NotAuthorizedToRevoke(capabilityId, msg.sender)
        );
        c.status = CapabilityStatus.REVOKED;
        emit CapabilityRevoked(bucketId, capabilityId, msg.sender);
    }

    /// @inheritdoc IBucketCapabilities
    function revokeAll(bytes32 bucketId) external returns (uint32 epoch) {
        require(
            msg.sender == IBucketAuthority(AUTHORITY).ownerOf(bucketId)
                || IBucketAuthority(AUTHORITY).isGuardian(bucketId, msg.sender),
            NotAuthorizedToRevoke(bytes32(0), msg.sender)
        );
        epoch = ++epochOf[bucketId];
        emit CapabilityEpochAdvanced(bucketId, epoch, msg.sender);
    }

    // =========================================================================================================
    // Consumption
    // =========================================================================================================

    /// @inheritdoc IBucketCapabilities
    function consume(bytes32 capabilityId, uint256 value) external onlyController {
        bytes32 bucketId = _capabilities[capabilityId].bucketId;
        bytes32 id = capabilityId;
        uint64 leafExecutions;
        for (uint256 i = 0; i < MAX_DELEGATION_DEPTH && id != bytes32(0); ++i) {
            Capability storage c = _capabilities[id];
            uint256 hourLeft = UsageLib.remaining(c.limits.maxHourlyValue, c.usage.hourSpent(block.timestamp));
            uint256 dayLeft = UsageLib.remaining(c.limits.maxDailyValue, c.usage.daySpent(block.timestamp));
            uint256 left = Math.min(hourLeft, dayLeft);
            require(value <= left, CapabilityVelocityExceeded(id, value, left));
            c.usage.charge(value, block.timestamp);

            uint64 executions = ++c.executions;
            if (i == 0) leafExecutions = executions;
            if (c.limits.maxExecutions != 0 && executions >= c.limits.maxExecutions) {
                c.status = CapabilityStatus.EXHAUSTED;
                emit CapabilityExhausted(bucketId, id, executions);
            }
            id = c.parentId;
        }
        emit CapabilityUsed(bucketId, capabilityId, value, leafExecutions);
    }

    // =========================================================================================================
    // Validation
    // =========================================================================================================

    /// @inheritdoc IBucketCapabilities
    function requireAuthorized(
        bytes32 capabilityId,
        address account,
        uint32 permissions,
        uint8 assetMask,
        uint8 venueMask
    ) external view {
        _requireValid(capabilityId, account, permissions, assetMask, venueMask);
    }

    /// @inheritdoc IBucketCapabilities
    function chainLimits(bytes32 capabilityId, uint256 totalValue) external view returns (EffectiveLimits memory l) {
        l.maxExecutionValue = type(uint256).max;
        l.remainingHourlyValue = type(uint256).max;
        l.remainingDailyValue = type(uint256).max;
        l.remainingTurnoverValue = type(uint256).max;
        l.maxSlippageBps = type(uint16).max;

        bytes32 id = capabilityId;
        for (uint256 i = 0; i < MAX_DELEGATION_DEPTH && id != bytes32(0); ++i) {
            Capability storage c = _capabilities[id];
            require(c.status != CapabilityStatus.NONE, CapabilityUnknown(id));
            CapabilityLimits memory limits = c.limits;
            Usage memory usage = c.usage;
            uint256 daySpent = usage.daySpent(block.timestamp);

            l.maxExecutionValue = Math.min(l.maxExecutionValue, limits.maxExecutionValue);
            l.remainingHourlyValue = Math.min(
                l.remainingHourlyValue, UsageLib.remaining(limits.maxHourlyValue, usage.hourSpent(block.timestamp))
            );
            l.remainingDailyValue =
                Math.min(l.remainingDailyValue, UsageLib.remaining(limits.maxDailyValue, daySpent));
            l.remainingTurnoverValue = Math.min(
                l.remainingTurnoverValue,
                UsageLib.remaining(Math.mulDiv(totalValue, limits.maxDailyTurnoverBps, BPS), daySpent)
            );
            if (limits.maxSlippageBps < l.maxSlippageBps) l.maxSlippageBps = limits.maxSlippageBps;
            id = c.parentId;
        }
    }

    // =========================================================================================================
    // Views
    // =========================================================================================================

    /// @inheritdoc IBucketCapabilities
    function getCapability(bytes32 capabilityId) external view returns (Capability memory) {
        return _capabilities[capabilityId];
    }

    /// @inheritdoc IBucketCapabilities
    function capabilityHash(bytes32 capabilityId) external view returns (bytes32) {
        Capability memory c = _capabilities[capabilityId];
        require(c.status != CapabilityStatus.NONE, CapabilityUnknown(capabilityId));
        return CapabilityLib.hash(capabilityId, c);
    }

    /// @inheritdoc IBucketCapabilities
    function nextCapabilityId(bytes32 bucketId) external view returns (bytes32) {
        return CapabilityLib.id(bucketId, nonceOf[bucketId] + 1);
    }

    /// @inheritdoc IBucketCapabilities
    function capabilitiesOf(bytes32 bucketId) external view returns (bytes32[] memory) {
        return _bucketCapabilities[bucketId];
    }

    // =========================================================================================================
    // Internal
    // =========================================================================================================

    /// @dev Live validation of the whole chain, leaf to root (K3). Reverts with the first violated condition.
    function _requireValid(bytes32 capabilityId, address account, uint32 permissions, uint8 assetMask, uint8 venueMask)
        private
        view
    {
        Capability storage leaf = _capabilities[capabilityId];
        require(leaf.status != CapabilityStatus.NONE, CapabilityUnknown(capabilityId));
        bytes32 bucketId = leaf.bucketId;

        require(leaf.operator == account, CapabilityOperatorMismatch(capabilityId, leaf.operator, account));
        require(
            BucketPermissions.contains(leaf.permissions, permissions),
            CapabilityPermissionDenied(capabilityId, permissions, leaf.permissions)
        );
        require(assetMask & ~leaf.assetMask == 0, CapabilityAssetNotAllowed(capabilityId, assetMask, leaf.assetMask));
        require(venueMask & ~leaf.venueMask == 0, CapabilityVenueNotAllowed(capabilityId, venueMask, leaf.venueMask));

        (BucketStatus status, address holder, uint32 policyVersion,,) =
            IBucketController(CONTROLLER).policyContext(bucketId);
        require(status == BucketStatus.ACTIVE, BucketNotActive(bucketId));
        IBucketAuthority authority = IBucketAuthority(AUTHORITY);
        address owner = authority.ownerOf(bucketId);
        require(holder == owner, BucketHolderNotOwner(bucketId, holder, owner));
        uint32 epoch = epochOf[bucketId];

        bytes32 id = capabilityId;
        for (uint256 i = 0; i < MAX_DELEGATION_DEPTH; ++i) {
            Capability storage c = _capabilities[id];
            require(c.bucketId == bucketId, CapabilityWrongBucket(id, bucketId));
            require(c.status != CapabilityStatus.REVOKED, CapabilityRevokedError(id));
            require(c.status != CapabilityStatus.EXHAUSTED, CapabilityExhaustedError(id));
            require(c.epoch == epoch, CapabilityEpochRevoked(id, c.epoch, epoch));
            require(c.policyVersion == policyVersion, CapabilityPolicySuperseded(id, c.policyVersion, policyVersion));
            require(block.timestamp >= c.validAfter, CapabilityNotYetValid(id, c.validAfter));
            require(block.timestamp <= c.validUntil, CapabilityExpired(id, c.validUntil));

            bytes32 parentId = c.parentId;
            address expectedRegistry;
            if (parentId == bytes32(0)) {
                expectedRegistry = authority.bucketSubregistry(bucketId);
            } else {
                Capability storage parent = _capabilities[parentId];
                expectedRegistry = authority.subregistryOf(parent.operatorRegistry, parent.operatorLabel);
            }
            require(c.operatorRegistry == expectedRegistry, CapabilityIdentityChanged(id));
            require(
                authority.ownerIn(c.operatorRegistry, uint256(keccak256(bytes(c.operatorLabel)))) == c.operator,
                CapabilityOperatorNameLost(id, c.operator)
            );

            if (parentId == bytes32(0)) {
                require(c.issuer == owner, CapabilityIssuerChanged(id, c.issuer, owner));
                return;
            }
            id = parentId;
        }
        revert CapabilityDepthExceeded(MAX_DELEGATION_DEPTH);
    }

    /// @dev Checks shared by root and child grants.
    function _validateShape(CapabilityGrant calldata grant) private view {
        require(BucketPermissions.isValid(grant.permissions), CapabilityPermissionsInvalid(grant.permissions));
        require(BucketPermissions.isDelegable(grant.permissions), CapabilityPermissionsInvalid(grant.permissions));
        require(grant.assetMask != 0, CapabilityAssetsInvalid(grant.assetMask, 0));
        require(grant.venueMask != 0, CapabilityVenuesInvalid(grant.venueMask, 0));
        require(
            grant.validAfter < grant.validUntil && grant.validUntil > block.timestamp
                && grant.validUntil - grant.validAfter <= MAX_CAPABILITY_DURATION,
            CapabilityWindowInvalid(grant.validAfter, grant.validUntil)
        );
        CapabilityLimits calldata l = grant.limits;
        require(
            l.maxExecutionValue > 0 && l.maxExecutionValue <= l.maxHourlyValue && l.maxHourlyValue <= l.maxDailyValue
                && l.maxDailyTurnoverBps > 0,
            CapabilityLimitsInvalid()
        );
        bool pays = grant.permissions & BucketPermissions.PERM_PAY != 0;
        require(pays ? grant.payee != address(0) : grant.payee == address(0), CapabilityPayeeInvalid(grant.payee));
    }

    function _requireWithin(uint256 value, uint256 ceiling, string memory field) private pure {
        if (value > ceiling) revert CapabilityLimitExceedsParent(field);
    }

    function _resolveOperator(address registry, string calldata label) private view returns (address operator) {
        operator = IBucketAuthority(AUTHORITY).ownerIn(registry, uint256(keccak256(bytes(label))));
        require(operator != address(0), OperatorNameNotRegistered(label));
    }

    function _store(
        bytes32 bucketId,
        bytes32 parentId,
        uint8 depth,
        address issuer,
        address operator,
        address registry,
        uint32 policyVersion,
        CapabilityGrant calldata grant
    ) private returns (bytes32 capabilityId) {
        uint64 nonce = ++nonceOf[bucketId];
        capabilityId = CapabilityLib.id(bucketId, nonce);

        Capability storage c = _capabilities[capabilityId];
        c.bucketId = bucketId;
        c.parentId = parentId;
        c.issuer = issuer;
        c.operator = operator;
        c.operatorRegistry = registry;
        c.depth = depth;
        c.status = CapabilityStatus.ACTIVE;
        c.permissions = grant.permissions;
        c.assetMask = grant.assetMask;
        c.venueMask = grant.venueMask;
        c.validAfter = grant.validAfter;
        c.validUntil = grant.validUntil;
        c.issuedAt = uint40(block.timestamp);
        c.policyVersion = policyVersion;
        c.epoch = epochOf[bucketId];
        c.nonce = nonce;
        c.payee = grant.payee;
        c.limits = grant.limits;
        c.operatorLabel = grant.operatorLabel;
        _bucketCapabilities[bucketId].push(capabilityId);

        emit CapabilityIssued(
            bucketId,
            capabilityId,
            parentId,
            operator,
            grant.operatorLabel,
            grant.permissions,
            nonce,
            CapabilityLib.hash(capabilityId, c)
        );
    }
}
