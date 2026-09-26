import { formatUsd, formatWeight } from '@bucket/protocol-types'
import type { Hex } from 'viem'

import { AllocationStack, AllocationTracks } from '../components/Allocation'
import { AuthorityPanel } from '../components/AuthorityPanel'
import { ExecutionPanel } from '../components/ExecutionPanel'
import { FlowRail } from '../components/FlowRail'
import { LedgerPanel } from '../components/LedgerPanel'
import { PolicyPanel } from '../components/PolicyPanel'
import { Chip, ErrorBox, Panel, Spinner } from '../components/primitives'
import { useApp } from '../lib/context'
import { bucketTitle } from '../lib/format'
import { useBucketView, useCapabilities } from '../lib/queries'

export function BucketPage({ bucketId }: { bucketId: Hex }) {
  const { config } = useApp()
  const { data: view, isLoading, error } = useBucketView(bucketId)
  const entry = config.deployment.buckets.find((b) => b.bucketId === bucketId)
  const capabilities = useCapabilities(bucketId, entry?.capabilities ?? [])

  if (isLoading) {
    return (
      <main className="page">
        <Spinner />
      </main>
    )
  }
  if (error || !view) {
    return (
      <main className="page">
        <a href="#/" className="back">
          ← Buckets
        </a>
        <ErrorBox error={error ?? new Error('Bucket not found')} />
      </main>
    )
  }

  return (
    <main className="page">
      <a href="#/" className="back">
        ← Buckets
      </a>
      <section className="bucket-head">
        <div>
          <div className="eyebrow">{view.ensName}</div>
          <h1>{bucketTitle(view.ensName)} BUCKET</h1>
        </div>
        <div className="bucket-kpis">
          <div>
            <div className="label">Total value</div>
            <div className="kpi mono">{formatUsd(view.allocation.totalValueWad)}</div>
          </div>
          <div>
            <div className="label">Max deviation</div>
            <div className="kpi mono">{formatWeight(view.allocation.maxAbsDeviationWad, 1)}</div>
          </div>
          <div>
            <div className="label">Status</div>
            {view.allocation.outOfPolicy ? (
              <Chip tone="warn">REBALANCE REQUIRED</Chip>
            ) : (
              <Chip tone="ok">WITHIN POLICY</Chip>
            )}
          </div>
        </div>
      </section>

      <FlowRail view={view} capabilities={capabilities.data ?? []} />

      <div className="grid">
        <div className="col-main">
          <Panel eyebrow="Live from the holder's wallet · valued at reference prices" title="Allocation">
            <AllocationStack allocation={view.allocation} />
            <AllocationTracks allocation={view.allocation} thresholdBps={view.snapshot.params.rebalanceThresholdBps} />
          </Panel>
          <ExecutionPanel view={view} />
          <LedgerPanel view={view} />
        </div>
        <div className="col-side">
          <AuthorityPanel view={view} />
          <PolicyPanel view={view} />
        </div>
      </div>
    </main>
  )
}
