// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

import { EnhancedAccessControl } from "@ensdomains/contracts-v2/access-control/EnhancedAccessControl.sol";
import { IPermissionedRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IPermissionedRegistry.sol";
import { IRegistry } from "@ensdomains/contracts-v2/registry/interfaces/IRegistry.sol";

import { IBucketAuthority } from "./interfaces/IBucketAuthority.sol";

/// @title BucketAuthority
/// @notice ENSv2 Enhanced Access Control instance answering WHO: Bucket ownership, guardianship and operator identity.
/// @dev Resource model: every Bucket is one EAC resource, `uint256(bucketId)`. Direct and root grants are disabled,
///      so authority can only originate from ENSv2 names:
///
///      Owner     The live owner of the Bucket's ENSv2 name. `_getRoles` implies every role and admin role for it.
///      Guardian  The live owner of `<label>.<bucket name>`, granted `ROLE_GUARDIAN` by the owner through
///                `authorizeGuardian`. Effective only while it still owns that subname and the Bucket name is still
///                owned by the account that made the grant; both are re-checked inside `_getRoles`, so every EAC query
///                observes live ENSv2 state.
///      Operator  Resolved on demand (`ownerIn` / `subregistryOf`) by `BucketCapabilities`; operators hold no EAC
///                roles here. Their authority is a Financial Capability, never a standing role.
contract BucketAuthority is EnhancedAccessControl, IBucketAuthority {
    /// @inheritdoc IBucketAuthority
    uint256 public constant ROLE_GUARDIAN = 1 << 0;

    address public immutable CONTROLLER;

    /// @dev Guardian role plus its admin role, implied for the ENSv2 owner.
    uint256 private constant _OWNER_ROLES = ROLE_GUARDIAN | (ROLE_GUARDIAN << 128);

    mapping(uint256 resource => NameBinding) private _names;
    mapping(uint256 resource => mapping(address account => GuardianBinding)) private _guardians;

    modifier onlyController() {
        require(msg.sender == CONTROLLER, OnlyController(msg.sender));
        _;
    }

    /// @param controller The `BucketController` allowed to bind Buckets (address precomputed at deployment)
    constructor(address controller) {
        CONTROLLER = controller;
    }

    /// @inheritdoc EnhancedAccessControl
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IBucketAuthority).interfaceId || super.supportsInterface(interfaceId);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Binding
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IBucketAuthority
    function bindBucket(bytes32 bucketId, IPermissionedRegistry registry, string calldata label)
        external
        onlyController
    {
        uint256 resource = uint256(bucketId);
        require(address(_names[resource].registry) == address(0), BucketAlreadyBound(bucketId));
        uint256 labelId = _labelId(label);
        require(registry.getOwner(labelId) != address(0), BucketNameNotRegistered(address(registry), labelId));

        _names[resource] = NameBinding({ registry: registry, labelId: labelId, label: label });
        emit BucketNameBound(bucketId, address(registry), labelId, label);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Guardians
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IBucketAuthority
    function authorizeGuardian(bytes32 bucketId, string calldata label) external returns (address guardian) {
        uint256 resource = uint256(bucketId);
        NameBinding storage name = _requireBound(bucketId);
        address owner = name.registry.getOwner(name.labelId);
        require(owner != address(0) && msg.sender == owner, NotBucketOwner(msg.sender, owner));

        IRegistry subregistry = name.registry.getSubregistry(name.label);
        require(address(subregistry) != address(0), BucketNameHasNoSubregistry(bucketId));

        uint256 labelId = _labelId(label);
        guardian = _ownerIn(address(subregistry), labelId);
        require(guardian != address(0), GuardianNameNotRegistered(bucketId, label));
        require(guardian != owner, GuardianIsOwner(bucketId, guardian));

        GuardianBinding storage binding = _guardians[resource][guardian];
        if (binding.grantedUnder != owner || binding.labelId != labelId) {
            uint256 stale = super._getRoles(resource, guardian);
            if (stale != 0) _revokeRoles(resource, stale, guardian, false);
            _guardians[resource][guardian] = GuardianBinding({ labelId: labelId, grantedUnder: owner });
        }
        _grantRoles(resource, ROLE_GUARDIAN, guardian, true);
        emit GuardianAuthorized(bucketId, guardian, labelId, label);
    }

    /// @inheritdoc IBucketAuthority
    function revokeGuardian(bytes32 bucketId, address guardian) external {
        uint256 resource = uint256(bucketId);
        _requireBound(bucketId);
        _checkCanRevokeRoles(resource, ROLE_GUARDIAN, msg.sender);
        _revokeRoles(resource, ROLE_GUARDIAN, guardian, true);
        delete _guardians[resource][guardian];
        emit GuardianRevoked(bucketId, guardian);
    }

    /// @notice Standard EAC revocation, kept so EAC-aware tooling can revoke Bucket roles.
    function revokeRoles(uint256 resource, uint256 roleBitmap, address account)
        public
        override
        canRevokeRoles(resource, roleBitmap)
        returns (bool revoked)
    {
        require(resource != ROOT_RESOURCE, EACRootResourceNotAllowed());
        revoked = _revokeRoles(resource, roleBitmap, account, true);
        if (super._getRoles(resource, account) == 0) delete _guardians[resource][account];
    }

    /// @notice Disabled: guardians must be granted through `authorizeGuardian` so every grant is ENSv2-anchored.
    function grantRoles(uint256, uint256, address) public pure override returns (bool) {
        revert DirectRoleGrantDisabled();
    }

    /// @notice Disabled: Buckets have no global administrators.
    function grantRootRoles(uint256, address) public pure override returns (bool) {
        revert DirectRoleGrantDisabled();
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    /// @inheritdoc IBucketAuthority
    function ownerOf(bytes32 bucketId) public view returns (address) {
        NameBinding storage name = _names[uint256(bucketId)];
        if (address(name.registry) == address(0)) return address(0);
        return name.registry.getOwner(name.labelId);
    }

    /// @inheritdoc IBucketAuthority
    function nameOf(bytes32 bucketId) external view returns (NameBinding memory) {
        return _names[uint256(bucketId)];
    }

    /// @inheritdoc IBucketAuthority
    function bucketSubregistry(bytes32 bucketId) public view returns (address) {
        NameBinding storage name = _names[uint256(bucketId)];
        if (address(name.registry) == address(0)) return address(0);
        return address(name.registry.getSubregistry(name.label));
    }

    /// @inheritdoc IBucketAuthority
    function subregistryOf(address registry, string calldata label) external view returns (address) {
        if (registry.code.length == 0) return address(0);
        try IRegistry(registry).getSubregistry(label) returns (IRegistry subregistry) {
            return address(subregistry);
        } catch {
            return address(0);
        }
    }

    /// @inheritdoc IBucketAuthority
    function ownerIn(address registry, uint256 labelId) external view returns (address) {
        return _ownerIn(registry, labelId);
    }

    /// @inheritdoc IBucketAuthority
    function isGuardian(bytes32 bucketId, address account) external view returns (bool) {
        return hasRoles(uint256(bucketId), ROLE_GUARDIAN, account);
    }

    /// @inheritdoc IBucketAuthority
    function guardianOf(bytes32 bucketId, address account) external view returns (GuardianBinding memory) {
        return _guardians[uint256(bucketId)][account];
    }

    // ---------------------------------------------------------------------------------------------------------
    // EAC integration
    // ---------------------------------------------------------------------------------------------------------

    /// @dev Effective roles are derived from live ENSv2 state; stored roles alone never authorize anything.
    function _getRoles(uint256 resource, address account) internal view override returns (uint256) {
        NameBinding storage name = _names[resource];
        if (address(name.registry) == address(0)) return 0;

        address owner = name.registry.getOwner(name.labelId);
        if (owner == address(0)) return 0; // expired or unregistered name freezes the Bucket
        if (account == owner) return _OWNER_ROLES;

        uint256 stored = super._getRoles(resource, account) & ROLE_GUARDIAN;
        if (stored == 0) return 0;

        GuardianBinding storage binding = _guardians[resource][account];
        if (binding.grantedUnder != owner) return 0;

        IRegistry subregistry = name.registry.getSubregistry(name.label);
        if (address(subregistry) == address(0)) return 0;
        if (_ownerIn(address(subregistry), binding.labelId) != account) return 0;

        return stored;
    }

    // ---------------------------------------------------------------------------------------------------------
    // Internal
    // ---------------------------------------------------------------------------------------------------------

    function _requireBound(bytes32 bucketId) private view returns (NameBinding storage name) {
        name = _names[uint256(bucketId)];
        require(address(name.registry) != address(0), BucketNotBound(bucketId));
    }

    /// @dev Owner of `labelId` in an arbitrary ENSv2 registry; non-permissioned registries yield `address(0)`.
    function _ownerIn(address registry, uint256 labelId) private view returns (address) {
        if (registry.code.length == 0) return address(0);
        try IPermissionedRegistry(registry).getOwner(labelId) returns (address owner) {
            return owner;
        } catch {
            return address(0);
        }
    }

    function _labelId(string calldata label) private pure returns (uint256) {
        return uint256(keccak256(bytes(label)));
    }
}
