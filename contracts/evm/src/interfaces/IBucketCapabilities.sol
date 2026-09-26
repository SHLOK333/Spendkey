// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { Capability, CapabilityGrant, EffectiveLimits } from "../types/BucketTypes.sol";

/// @title IBucketCapabilities
/// @notice Registry of Financial Capabilities: WHAT an ENSv2 identity may do with a Bucket's wallet liquidity.
/// @dev A capability is valid at time `t` only if, for itself and every ancestor:
///        status == ACTIVE, epoch == Bucket epoch, policyVersion == Bucket policy version,
///        validAfter <= t <= validUntil, its operator still owns its ENSv2 name in the registry its issuer's name
///        points to, and (root) its issuer is still the live Bucket owner and the Bucket holder.
///      Validity is never cached: every execution path calls `requireAuthorized`, which evaluates it live.
interface IBucketCapabilities {
    event CapabilityIssued(
        bytes32 indexed bucketId,
        bytes32 indexed capabilityId,
        bytes32 indexed parentId,
        address operator,
        string operatorLabel,
        uint32 permissions,
        uint64 nonce,
        bytes32 capabilityHash
    );
    event CapabilityRevoked(bytes32 indexed bucketId, bytes32 indexed capabilityId, address indexed by);
    event CapabilityExhausted(bytes32 indexed bucketId, bytes32 indexed capabilityId, uint64 executions);
    event CapabilityEpochAdvanced(bytes32 indexed bucketId, uint32 epoch, address indexed by);
    event CapabilityUsed(bytes32 indexed bucketId, bytes32 indexed capabilityId, uint256 value, uint64 executions);

    // Issuance
    error OnlyController(address caller);
    error NotBucketOwner(address caller, address owner);
    error NotAuthorizedToRevoke(bytes32 capabilityId, address caller);
    error BucketNotActive(bytes32 bucketId);
    error BucketHolderNotOwner(bytes32 bucketId, address holder, address owner);
    error CapabilityPermissionsInvalid(uint32 permissions);
    error CapabilityPermissionsNotDelegable(uint32 requested, uint32 ceiling);
    error CapabilityAssetsInvalid(uint8 assetMask, uint8 allowedMask);
    error CapabilityVenuesInvalid(uint8 venueMask, uint8 allowedMask);
    error CapabilityWindowInvalid(uint40 validAfter, uint40 validUntil);
    error CapabilityLimitsInvalid();
    error CapabilityLimitExceedsParent(string field);
    error CapabilityPayeeInvalid(address payee);
    error CapabilityDepthExceeded(uint8 depth);
    error OperatorNameNotRegistered(string operatorLabel);
    error OperatorIsIssuer(address operator);
    error IssuerHasNoSubregistry(bytes32 capabilityId);

    // Validation (surface through the SwapVM program and every controller entry point)
    error CapabilityUnknown(bytes32 capabilityId);
    error CapabilityWrongBucket(bytes32 capabilityId, bytes32 bucketId);
    error CapabilityRevokedError(bytes32 capabilityId);
    error CapabilityExhaustedError(bytes32 capabilityId);
    error CapabilityEpochRevoked(bytes32 capabilityId, uint32 epoch, uint32 currentEpoch);
    error CapabilityPolicySuperseded(bytes32 capabilityId, uint32 policyVersion, uint32 currentVersion);
    error CapabilityNotYetValid(bytes32 capabilityId, uint40 validAfter);
    error CapabilityExpired(bytes32 capabilityId, uint40 validUntil);
    error CapabilityIdentityChanged(bytes32 capabilityId);
    error CapabilityOperatorNameLost(bytes32 capabilityId, address operator);
    error CapabilityIssuerChanged(bytes32 capabilityId, address issuer, address owner);
    error CapabilityOperatorMismatch(bytes32 capabilityId, address operator, address caller);
    error CapabilityPermissionDenied(bytes32 capabilityId, uint32 required, uint32 granted);
    error CapabilityAssetNotAllowed(bytes32 capabilityId, uint8 required, uint8 granted);
    error CapabilityVenueNotAllowed(bytes32 capabilityId, uint8 required, uint8 granted);
    error CapabilityVelocityExceeded(bytes32 capabilityId, uint256 value, uint256 remaining);

    function AUTHORITY() external view returns (address);
    function CONTROLLER() external view returns (address);

    /// @notice Issues a root capability of `bucketId` to the owner of `<grant.operatorLabel>.<bucket name>`.
    ///         Bucket owner only; bounded by the live policy.
    function issue(bytes32 bucketId, CapabilityGrant calldata grant) external returns (bytes32 capabilityId);

    /// @notice Issues a child of `parentId` to the owner of `<grant.operatorLabel>.<parent operator name>`.
    ///         Parent operator only, requires `PERM_DELEGATE`; the child must be strictly within the parent.
    function delegate(bytes32 parentId, CapabilityGrant calldata grant) external returns (bytes32 capabilityId);

    /// @notice Revokes a capability (and, implicitly, every descendant). Bucket owner, guardian or its issuer.
    function revoke(bytes32 capabilityId) external;

    /// @notice Kill switch: invalidates every capability of the Bucket at once. Bucket owner or guardian.
    function revokeAll(bytes32 bucketId) external returns (uint32 epoch);

    /// @notice Charges an execution of `value` (USD, WAD) to the capability and all its ancestors. Controller only.
    function consume(bytes32 capabilityId, uint256 value) external;

    /// @notice Reverts with a typed error unless `account` may exercise `permissions` over the assets in
    ///         `assetMask` on the venues in `venueMask` under `capabilityId` right now.
    function requireAuthorized(
        bytes32 capabilityId,
        address account,
        uint32 permissions,
        uint8 assetMask,
        uint8 venueMask
    ) external view;

    /// @notice Tightest capability-chain limits of the next execution; `totalValue` prices the turnover limit.
    function chainLimits(bytes32 capabilityId, uint256 totalValue) external view returns (EffectiveLimits memory);

    function getCapability(bytes32 capabilityId) external view returns (Capability memory);
    function capabilityHash(bytes32 capabilityId) external view returns (bytes32);
    function epochOf(bytes32 bucketId) external view returns (uint32);
    function nonceOf(bytes32 bucketId) external view returns (uint64);
    function nextCapabilityId(bytes32 bucketId) external view returns (bytes32);
    function capabilitiesOf(bytes32 bucketId) external view returns (bytes32[] memory);
}
