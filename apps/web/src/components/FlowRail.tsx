import type { BucketView } from '@bucket/sdk'

import type { CapabilityView } from '../lib/queries'

type NodeState = 'ok' | 'warn' | 'idle'

interface RailNode {
  readonly key: string
  readonly layer: string
  readonly title: string
  readonly detail: string
  readonly state: NodeState
}

/** Identity → Capability → Bucket → Execution, each node derived from live chain state. */
export function FlowRail({ view, capabilities }: { view: BucketView; capabilities: readonly CapabilityView[] }) {
  const liveCapability = capabilities.some((c) => c.capability?.status === 1)
  const nodes: RailNode[] = [
    {
      key: 'identity',
      layer: 'ENSv2',
      title: 'Identity',
      detail: liveCapability ? `${view.ensName} · capability live` : view.ensName,
      state: liveCapability ? 'ok' : 'idle',
    },
    {
      key: 'policy',
      layer: 'EVM',
      title: 'Policy',
      detail: `v${view.snapshot.policyVersion}`,
      state: 'ok',
    },
    {
      key: 'bucket',
      layer: 'EVM',
      title: 'Bucket',
      detail: view.allocation.outOfPolicy ? 'rebalance required' : 'within policy',
      state: view.allocation.outOfPolicy ? 'warn' : 'ok',
    },
    {
      key: 'execution',
      layer: 'Aqua + SwapVM',
      title: 'Execution',
      detail: view.activeIntent ? 'intent shipped to Aqua' : view.plan?.required ? 'ready to ship' : 'no intent needed',
      state: view.activeIntent ? 'ok' : view.plan?.required ? 'warn' : 'idle',
    },
  ]
  return (
    <ol className="rail">
      {nodes.map((node, index) => (
        <li key={node.key} className={`rail-node rail-${node.state}`}>
          <div className="rail-index mono">{String(index + 1).padStart(2, '0')}</div>
          <div className="rail-layer">{node.layer}</div>
          <div className="rail-title">{node.title}</div>
          <div className="rail-detail">{node.detail}</div>
        </li>
      ))}
    </ol>
  )
}
