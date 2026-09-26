import { Permission, hasPermissions } from '@bucket/protocol-types'
import { isAddressEqual, type Hex } from 'viem'

import { useOwnerWallet } from './app'
import { useAgentStatus, useCapabilities, useKnownBuckets, type CapabilityRow } from './queries'

/** The Bucket the connected wallet owns (else the first known one, read-only) and the agent's live capabilities on it. */
export function useSelectedBucket() {
  const { address } = useOwnerWallet()
  const { buckets, isLoading } = useKnownBuckets()
  const owned = address ? buckets.filter((b) => isAddressEqual(b.holder, address)) : []
  const selected = owned[0] ?? buckets[0] ?? null
  const caps = useCapabilities(selected?.bucketId ?? null)
  const agent = useAgentStatus()
  const agentOperator = agent.data?.evmOperator ?? null
  const agentCaps: CapabilityRow[] = (caps.data ?? []).filter((c) => c.live && agentOperator && isAddressEqual(c.capability.operator, agentOperator))
  return {
    bucketId: (selected?.bucketId ?? null) as Hex | null,
    holder: selected?.holder ?? null,
    isOwner: !!address && owned.length > 0,
    isLoading: isLoading || caps.isLoading,
    capabilities: caps.data ?? [],
    agentOperator,
    agentCaps,
    swapCaps: agentCaps.filter((c) => hasPermissions(c.capability.permissions, Permission.Swap)),
    rebalanceCaps: agentCaps.filter((c) => hasPermissions(c.capability.permissions, Permission.Rebalance)),
    payCaps: agentCaps.filter((c) => hasPermissions(c.capability.permissions, Permission.Pay)),
  }
}
