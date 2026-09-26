import type { Address } from 'viem'

/**
 * Official ENSv2 Sepolia deployment (ensdomains/contracts-v2, `contracts/deployments/sepolia`,
 * tag `sepolia-deployment-2026-06-29`, chainId 11155111).
 */
export const ENSV2_SEPOLIA = {
  chainId: 11155111,
  rootRegistry: '0x11b5bfbe9078d826b1edbdd1cfc12f5828d9f50c',
  ethRegistry: '0x67b728a792e789a8978b30cf1b3b641f19354b43',
  ethRegistrar: '0xa4449a0dd2b83007553d9b1d28b583a46a805a30',
  userRegistryImpl: '0x840fa461059862ea466a711e8c98c8de732061c0',
  verifiableFactory: '0x118bc31a50d559f7015a8da26d54b3b030cdb70f',
  universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  permissionedResolverImpl: '0x7e4b2d59938930168024201752ee5503df402303',
  /** Payment token accepted by the Sepolia `.eth` registrar; public `mint`. */
  mockUsdc: '0xd3322b29a7bdee707d1684676f149bf41aa3422f',
} as const satisfies Record<string, Address | number>

/** `RegistryRolesLib` (ENSv2 PermissionedRegistry EAC roles). */
export const RegistryRoles = {
  REGISTRAR: 1n << 0n,
  REGISTER_RESERVED: 1n << 4n,
  SET_PARENT: 1n << 8n,
  UNREGISTER: 1n << 12n,
  RENEW: 1n << 16n,
  SET_SUBREGISTRY: 1n << 20n,
  SET_RESOLVER: 1n << 24n,
  CAN_TRANSFER_ADMIN: (1n << 28n) << 128n,
  SET_URI: 1n << 36n,
  UPGRADE: 1n << 124n,
} as const

export function adminOf(role: bigint): bigint {
  return role << 128n
}

/** Root roles granted to the owner of a self-managed `UserRegistry` (registrar of its own subnames). */
export const USER_REGISTRY_OWNER_ROLES =
  RegistryRoles.REGISTRAR |
  adminOf(RegistryRoles.REGISTRAR) |
  RegistryRoles.RENEW |
  adminOf(RegistryRoles.RENEW) |
  RegistryRoles.UNREGISTER |
  adminOf(RegistryRoles.UNREGISTER) |
  RegistryRoles.SET_SUBREGISTRY |
  adminOf(RegistryRoles.SET_SUBREGISTRY) |
  RegistryRoles.SET_RESOLVER |
  adminOf(RegistryRoles.SET_RESOLVER) |
  RegistryRoles.SET_PARENT |
  adminOf(RegistryRoles.SET_PARENT) |
  RegistryRoles.UPGRADE |
  adminOf(RegistryRoles.UPGRADE)

/** Token roles granted to the owner of a subname: manage its subregistry/resolver and transfer it. */
export const SUBNAME_OWNER_ROLES =
  RegistryRoles.SET_SUBREGISTRY |
  adminOf(RegistryRoles.SET_SUBREGISTRY) |
  RegistryRoles.SET_RESOLVER |
  adminOf(RegistryRoles.SET_RESOLVER) |
  RegistryRoles.CAN_TRANSFER_ADMIN
