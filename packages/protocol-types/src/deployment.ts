import { getAddress, isAddress, isHex, type Address, type Hex } from 'viem'
import { z } from 'zod'

const address = z
  .string()
  .refine((value) => isAddress(value, { strict: false }), 'invalid EVM address')
  .transform((value): Address => getAddress(value))
const bytes32 = z
  .string()
  .refine((value) => isHex(value) && value.length === 66, 'invalid bytes32')
  .transform((value) => value.toLowerCase() as Hex)
const suiId = z.string().regex(/^0x[0-9a-fA-F]{1,64}$/, 'invalid Sui object id')

export const EvmNetworkKind = z.enum(['sepolia', 'sepolia-fork'])
export type EvmNetworkKind = z.infer<typeof EvmNetworkKind>

export const DeploymentTokenSchema = z.object({
  symbol: z.string().min(1),
  address,
  decimals: z.number().int().min(0).max(18),
  suiType: z.string(),
})
export type DeploymentToken = z.infer<typeof DeploymentTokenSchema>

/** A capability issued during deployment/demo setup, on either chain. */
export const DeploymentCapabilitySchema = z.object({
  label: z.string().min(1),
  /** EVM capability nonce (bigint as decimal string) or Sui capability nonce, whichever chain issued it. */
  nonce: z.string(),
  capabilityId: bytes32.optional(),
  operatorLabel: z.string(),
  operatorAddress: z.string(),
  permissions: z.number().int().nonnegative(),
})
export type DeploymentCapability = z.infer<typeof DeploymentCapabilitySchema>

/** A Bucket created on the EVM execution layer. The holder is the ENSv2-named owner's own wallet — there is no
 *  separate vault contract to record. */
export const DeploymentBucketSchema = z.object({
  label: z.string().min(1),
  ensName: z.string().min(1),
  bucketId: bytes32,
  holder: address,
  capabilities: z.array(DeploymentCapabilitySchema).default([]),
})
export type DeploymentBucket = z.infer<typeof DeploymentBucketSchema>

/** A Bucket created natively on Sui (see `bucket::bucket`), optionally bound to an EVM twin for attribution. */
export const SuiBucketSchema = z.object({
  label: z.string().min(1),
  name: z.string().min(1),
  objectId: suiId,
  ownerCapId: suiId,
  owner: z.string(),
  evmBucketId: bytes32.optional(),
  capabilities: z.array(DeploymentCapabilitySchema).default([]),
})
export type SuiBucket = z.infer<typeof SuiBucketSchema>

/**
 * Deployment manifest produced by `scripts/deploy` and consumed by the SDK, demo and web app.
 * `evm.network = 'sepolia-fork'` marks a local anvil fork of Sepolia; the UI surfaces it explicitly.
 */
export const DeploymentSchema = z.object({
  evm: z.object({
    network: EvmNetworkKind,
    chainId: z.number().int().positive(),
    explorer: z.string().url().nullable(),
    deployedAt: z.string(),
    /** First block to scan for Bucket events. */
    startBlock: z.number().int().nonnegative(),
    contracts: z.object({
      aqua: address,
      router: address,
      authority: address,
      capabilities: address,
      controller: address,
      priceFeed: address,
    }),
    ens: z.object({
      rootRegistry: address,
      ethRegistry: address,
      ethRegistrar: address,
      userRegistryImpl: address,
      verifiableFactory: address,
      ownerRegistry: address.nullable(),
      bucketRegistry: address.nullable(),
    }),
    tokens: z.array(DeploymentTokenSchema),
  }),
  sui: z
    .object({
      network: z.enum(['testnet', 'devnet', 'localnet']),
      packageId: suiId,
      explorer: z.string().url().nullable(),
      /** Shared `access::AccessControl` (EAC) object every role check and `pay` reads. */
      accessControlId: suiId.optional(),
      /** Shared SuiNS object used by `resolve_suins_principal` / `owner_grant_roles_by_suins`. */
      suinsObjectId: suiId.optional(),
    })
    .nullable(),
  ens: z
    .object({
      ownerName: z.string(),
      ownerAddress: address,
    })
    .nullable(),
  buckets: z.array(DeploymentBucketSchema),
  suiBuckets: z.array(SuiBucketSchema).default([]),
})
export type Deployment = z.infer<typeof DeploymentSchema>

export function parseDeployment(json: unknown): Deployment {
  return DeploymentSchema.parse(json)
}
