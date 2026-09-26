import { labelId } from '@bucket/protocol-types'
import { isAddressEqual, zeroAddress, type Address, type PublicClient } from 'viem'

import { userRegistryAbi } from '../abi/ens'
import { ENSV2_SEPOLIA } from './constants'

export interface EnsV2Addresses {
  readonly rootRegistry: Address
  readonly ethRegistry: Address
}

/** A name located in the ENSv2 registry hierarchy. */
export interface ResolvedName {
  readonly name: string
  /** Registry that holds the final label. */
  readonly registry: Address
  readonly label: string
  readonly labelId: bigint
  /** Live owner (`getOwner`), zero when unregistered or expired. */
  readonly owner: Address
  readonly expiry: bigint
  /** Registry of the name's children, zero when none. */
  readonly subregistry: Address
}

const MAX_DEPTH = 16

/**
 * Read access to the ENSv2 registry tree. Names are resolved by descending registries from the root
 * (`getSubregistry` per label), never by assuming ENSv1 namehash storage.
 */
export class EnsV2 {
  constructor(
    readonly client: PublicClient,
    readonly addresses: EnsV2Addresses = {
      rootRegistry: ENSV2_SEPOLIA.rootRegistry,
      ethRegistry: ENSV2_SEPOLIA.ethRegistry,
    },
  ) {}

  async resolve(name: string): Promise<ResolvedName | null> {
    const labels = name.split('.').filter(Boolean)
    if (labels.length === 0 || labels.length > MAX_DEPTH) return null

    let registry: Address = this.addresses.rootRegistry
    for (let i = labels.length - 1; i > 0; i--) {
      const next = await this.subregistryOf(registry, labels[i] as string)
      if (isAddressEqual(next, zeroAddress)) return null
      registry = next
    }
    const label = labels[0] as string
    return this.locate(registry, label, name)
  }

  async locate(registry: Address, label: string, name?: string): Promise<ResolvedName> {
    const id = labelId(label)
    const [owner, expiry, subregistry] = await Promise.all([
      this.client.readContract({ address: registry, abi: userRegistryAbi, functionName: 'getOwner', args: [id] }),
      this.client.readContract({ address: registry, abi: userRegistryAbi, functionName: 'getExpiry', args: [id] }),
      this.subregistryOf(registry, label),
    ])
    return {
      name: name ?? (await this.fullName(registry, label)),
      registry,
      label,
      labelId: id,
      owner,
      expiry,
      subregistry,
    }
  }

  async subregistryOf(registry: Address, label: string): Promise<Address> {
    return this.client.readContract({
      address: registry,
      abi: userRegistryAbi,
      functionName: 'getSubregistry',
      args: [label],
    })
  }

  /** Canonical full name of `label` in `registry`, reconstructed from the registries' `getParent` links. */
  async fullName(registry: Address, label: string): Promise<string> {
    const labels = [label]
    let current = registry
    for (let depth = 0; depth < MAX_DEPTH; depth++) {
      if (isAddressEqual(current, this.addresses.rootRegistry)) break
      const [parent, parentLabel] = await this.client.readContract({
        address: current,
        abi: userRegistryAbi,
        functionName: 'getParent',
      })
      if (isAddressEqual(parent, zeroAddress) || parentLabel === '') break
      labels.push(parentLabel)
      current = parent
    }
    return labels.join('.')
  }

  async ownerOf(registry: Address, label: string): Promise<Address> {
    return this.client.readContract({
      address: registry,
      abi: userRegistryAbi,
      functionName: 'getOwner',
      args: [labelId(label)],
    })
  }
}
