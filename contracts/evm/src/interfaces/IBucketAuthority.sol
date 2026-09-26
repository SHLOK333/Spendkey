// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { IPermissionedRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";

/// @title IBucketAuthority
/// @notice ENSv2-backed identity for Buckets: WHO owns a Bucket, WHO guards it, and WHO an operator name resolves to.
/// @dev A Bucket is bound to an ENSv2 name (`label` in `registry`, e.g. `trading` in the registry of `shlok.eth`).
///      - Owner:    the live owner of that name. Transferring or losing the name moves or freezes ownership.
///      - Guardian: the live owner of `<guardianLabel>.<bucket name>` holding the EAC `ROLE_GUARDIAN` on the Bucket
///                  resource. A guardian can pause the Bucket and revoke capabilities, never issue or resume.
///      - Operator: the live owner of `<operatorLabel>.<issuer name>`; operators receive Financial Capabilities from
///                  `BucketCapabilities`, which re-resolves their names through this contract on every use.
interface IBucketAuthority {
    /// @notice ENSv2 anchor of a Bucket.
    struct NameBinding {
        IPermissionedRegistry registry;
        uint256 labelId;
        string label;
    }

    /// @notice ENSv2 anchor of a guardian grant.
    /// @param labelId Labelhash of the guardian label inside the Bucket name's subregistry
    /// @param grantedUnder Bucket owner at grant time; grants are void once the Bucket name changes hands
    struct GuardianBinding {
        uint256 labelId;
        address grantedUnder;
    }

    event BucketNameBound(bytes32 indexed bucketId, address indexed registry, uint256 indexed labelId, string label);
    event GuardianAuthorized(bytes32 indexed bucketId, address indexed guardian, uint256 indexed labelId, string label);
    event GuardianRevoked(bytes32 indexed bucketId, address indexed guardian);

    error OnlyController(address caller);
    error BucketAlreadyBound(bytes32 bucketId);
    error BucketNotBound(bytes32 bucketId);
    error BucketNameNotRegistered(address registry, uint256 labelId);
    error BucketNameHasNoSubregistry(bytes32 bucketId);
    error GuardianNameNotRegistered(bytes32 bucketId, string label);
    error GuardianIsOwner(bytes32 bucketId, address guardian);
    error NotBucketOwner(address caller, address owner);
    error DirectRoleGrantDisabled();

    function CONTROLLER() external view returns (address);

    /// @notice EAC role (on resource `uint256(bucketId)`) held by a Bucket's guardians.
    function ROLE_GUARDIAN() external view returns (uint256);

    /// @notice Binds a new Bucket to its ENSv2 name. Controller only, once per Bucket.
    function bindBucket(bytes32 bucketId, IPermissionedRegistry registry, string calldata label) external;

    /// @notice Grants the guardian role to the owner of `<label>.<bucket name>`. Bucket owner only.
    function authorizeGuardian(bytes32 bucketId, string calldata label) external returns (address guardian);

    /// @notice Revokes the guardian role of `guardian`. Bucket owner only.
    function revokeGuardian(bytes32 bucketId, address guardian) external;

    /// @notice Live ENSv2 owner of the Bucket name, `address(0)` if unregistered or expired.
    function ownerOf(bytes32 bucketId) external view returns (address);

    /// @notice ENSv2 name binding of a Bucket.
    function nameOf(bytes32 bucketId) external view returns (NameBinding memory);

    /// @notice Live ENSv2 subregistry of the Bucket name (where root operator and guardian labels live).
    function bucketSubregistry(bytes32 bucketId) external view returns (address);

    /// @notice Live subregistry of `label` in `registry`, `address(0)` when none or not an ENSv2 registry.
    function subregistryOf(address registry, string calldata label) external view returns (address);

    /// @notice Live owner of `labelId` in `registry`, `address(0)` when unregistered, expired or not permissioned.
    function ownerIn(address registry, uint256 labelId) external view returns (address);

    /// @notice True when `account` is a live guardian of the Bucket.
    function isGuardian(bytes32 bucketId, address account) external view returns (bool);

    /// @notice Guardian grant anchor of `account`.
    function guardianOf(bytes32 bucketId, address account) external view returns (GuardianBinding memory);
}
