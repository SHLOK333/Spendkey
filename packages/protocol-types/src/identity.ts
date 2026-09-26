import { encodeAbiParameters, keccak256, stringToBytes, type Address, type Hex } from 'viem'

import { BUCKET_ID_DOMAIN_TAG } from './constants'

/** ENSv2 label id (`LibLabel.id`): keccak256 of the label bytes, as uint256. */
export function labelId(label: string): bigint {
  return BigInt(keccak256(stringToBytes(label)))
}

/**
 * Deterministic EVM Bucket identifier, identical to `BucketController.computeBucketId`:
 * keccak256(abi.encode(keccak256("BUCKET_ID_V1"), chainId, controller, registry, labelId)).
 * Computable before any transaction, so the Bucket id is known ahead of creation.
 */
export function computeBucketId(chainId: number, controller: Address, registry: Address, label: string): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [keccak256(stringToBytes(BUCKET_ID_DOMAIN_TAG)), BigInt(chainId), controller, registry, labelId(label)],
    ),
  )
}

/** Full ENS name of a Bucket from its label and parent name. */
export function bucketEnsName(label: string, parent: string): string {
  return `${label}.${parent}`
}
