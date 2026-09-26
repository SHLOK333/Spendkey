import type { Address } from 'viem'

/**
 * Official ENSv2 Sepolia deployment (ensdomains/contracts-v2, `contracts/docs/addresses/sepolia.md`,
 * the 2026-09-15 "clean testnet" redeploy that app.ens.dev / sepolia.app.ens.domains now index, chainId 11155111).
 *
 * NOTE: this redeploy wiped the earlier `sepolia-deployment-2026-06-29` set BUCKET originally targeted
 * (ethRegistry `0x67b728…`). Names registered against the old set are not visible on the live ENS app.
 */
export const ENSV2_SEPOLIA = {
  chainId: 11155111,
  rootRegistry: '0x9703dbd26dab89504490994138cf2c575251a9ce',
  ethRegistry: '0x657ea849311d3d5823348dded7c2aaafb3ede09e',
  ethRegistrar: '0xabe76f6c8dfced81aa5a2bb8034202a7136b94ca',
  userRegistryImpl: '0xa80338aaa8d23831cea25e858d1774534abb0263',
  verifiableFactory: '0x9e726eb570beb6bceb495ab8cda7df517d4e841c',
  universalResolver: '0xeEeEEEeE14D718C2B47D9923Deab1335E144EeEe',
  permissionedResolverImpl: '0x14f09fd05d4585759e54844dc9b00147131cf243',
  /** Payment token accepted by the Sepolia `.eth` registrar; public `mint`. */
  mockUsdc: '0x16f95d91dba7da3aca778ec053df0ff6c6a8aa8e',
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
