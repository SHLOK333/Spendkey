// SPDX-License-Identifier: LicenseRef-Degensoft-SwapVM-1.1
pragma solidity 0.8.30;

/// @title BucketPermissions
/// @notice Chain-neutral Financial Capability permission bits (identical on Sui and in `@bucket/protocol-types`).
/// @dev Delegable permissions describe *execution* an operator may perform against the holder's wallet liquidity.
///      Owner-only permissions describe *authority over the Bucket itself*; they exist as named bits so every layer
///      (and the UI) can state explicitly that they are never delegated, and any capability requesting them is
///      rejected at issuance. Ownership itself is the live ownership of the Bucket's ENSv2 name.
library BucketPermissions {
    /// @dev Open and fulfil policy-computed rebalance intents.
    uint32 internal constant PERM_REBALANCE = 1 << 0;
    /// @dev Open and fulfil operator-directed swaps between allowed assets, bounded by the policy's hard bands.
    uint32 internal constant PERM_SWAP = 1 << 1;
    /// @dev Pay allowed assets to the capability's fixed payee.
    uint32 internal constant PERM_PAY = 1 << 2;
    /// @dev Issue strictly narrower child capabilities to ENSv2 subnames of the operator's own name.
    uint32 internal constant PERM_DELEGATE = 1 << 3;

    /// @dev Owner-only: install a new policy version.
    uint32 internal constant PERM_UPDATE_POLICY = 1 << 4;
    /// @dev Owner-only: move ownership (only possible through the ENSv2 registry).
    uint32 internal constant PERM_CHANGE_OWNER = 1 << 5;
    /// @dev Owner-only: move assets to an arbitrary destination.
    uint32 internal constant PERM_WITHDRAW = 1 << 6;

    uint32 internal constant PERMISSION_COUNT = 7;
    uint32 internal constant ALL_PERMISSIONS = (uint32(1) << PERMISSION_COUNT) - 1;
    uint32 internal constant DELEGABLE_PERMISSIONS = PERM_REBALANCE | PERM_SWAP | PERM_PAY | PERM_DELEGATE;
    uint32 internal constant OWNER_ONLY_PERMISSIONS = PERM_UPDATE_POLICY | PERM_CHANGE_OWNER | PERM_WITHDRAW;

    function isValid(uint32 permissions) internal pure returns (bool) {
        return permissions & ~ALL_PERMISSIONS == 0;
    }

    /// @notice True when `permissions` is non-empty, known and free of owner-only bits.
    function isDelegable(uint32 permissions) internal pure returns (bool) {
        return permissions != 0 && permissions & ~DELEGABLE_PERMISSIONS == 0;
    }

    function contains(uint32 mask, uint32 required) internal pure returns (bool) {
        return mask & required == required;
    }
}
