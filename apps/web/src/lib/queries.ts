import type { Capability, DeploymentBucket, DeploymentCapability } from '@bucket/protocol-types'
import type { BucketView } from '@bucket/sdk'
import { useQuery } from '@tanstack/react-query'
import type { Address, Hex } from 'viem'

import { useApp } from './context'

const REFRESH_MS = 12_000

export function useBucketView(bucketId: Hex | undefined) {
  const { clients } = useApp()
  return useQuery({
    queryKey: ['bucket', bucketId],
    queryFn: () => clients.bucket.getBucket(bucketId as Hex),
    enabled: Boolean(bucketId),
    refetchInterval: REFRESH_MS,
  })
}

export function useBucketViews(buckets: readonly DeploymentBucket[]) {
  const { clients } = useApp()
  return useQuery({
    queryKey: ['buckets', buckets.map((b) => b.bucketId)],
    queryFn: async (): Promise<Array<{ entry: DeploymentBucket; view: BucketView | null; error: string | null }>> =>
      Promise.all(
        buckets.map(async (entry) => {
          try {
            return { entry, view: await clients.bucket.getBucket(entry.bucketId), error: null }
          } catch (error) {
            return { entry, view: null, error: error instanceof Error ? error.message : String(error) }
          }
        }),
      ),
    refetchInterval: REFRESH_MS,
  })
}

export interface CapabilityView {
  readonly entry: DeploymentCapability
  /** Live on-chain state (status, live operator, usage), `null` if the capability id is unknown. */
  readonly capability: Capability | null
}

/** Every capability the deployment manifest recorded for a Bucket, with live on-chain state. Capabilities are
 *  first-class Move/Solidity objects, not a role a Bucket "has" — the manifest is only a convenience index of
 *  what a demo/script issued; the source of truth is always the on-chain read. */
export function useCapabilities(bucketId: Hex | undefined, entries: readonly DeploymentCapability[]) {
  const { clients } = useApp()
  return useQuery({
    queryKey: ['capabilities', bucketId, entries.map((e) => e.capabilityId)],
    enabled: Boolean(bucketId),
    refetchInterval: REFRESH_MS,
    queryFn: async (): Promise<CapabilityView[]> =>
      Promise.all(
        entries.map(async (entry) => {
          if (!entry.capabilityId) return { entry, capability: null }
          try {
            return { entry, capability: await clients.bucket.evm.getCapability(entry.capabilityId) }
          } catch {
            return { entry, capability: null }
          }
        }),
      ),
  })
}

export function useCapability(capabilityId: Hex | undefined) {
  const { clients } = useApp()
  return useQuery({
    queryKey: ['capability', capabilityId],
    enabled: Boolean(capabilityId),
    refetchInterval: REFRESH_MS,
    queryFn: () => clients.bucket.evm.getCapability(capabilityId as Hex),
  })
}

/** True when `account` is the live operator of `capabilityId` (ENSv2 name re-resolved on every read). */
export function useIsCapabilityOperator(capabilityId: Hex | undefined, account: Address | null) {
  const capability = useCapability(capabilityId)
  return capability.data && account ? capability.data.operator.toLowerCase() === account.toLowerCase() : false
}

/** Reads a Sui-native Bucket by object id; read-only, no wallet required. */
export function useSuiBucket(objectId: string | undefined) {
  const { clients } = useApp()
  return useQuery({
    queryKey: ['sui-bucket', objectId],
    enabled: Boolean(objectId && clients.suiReader),
    refetchInterval: REFRESH_MS,
    queryFn: () => clients.suiReader!.getBucket(objectId as string),
  })
}

export function useExecutions(bucketId: Hex | undefined) {
  const { clients } = useApp()
  return useQuery({
    queryKey: ['executions', bucketId],
    enabled: Boolean(bucketId),
    refetchInterval: REFRESH_MS,
    queryFn: () => clients.bucket.evm.executions(bucketId as Hex),
  })
}
