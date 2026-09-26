import { formatUsd, formatWeight } from '@bucket/protocol-types'

import { AllocationStack } from '../components/Allocation'
import { Chip, ErrorBox, Spinner } from '../components/primitives'
import { useApp } from '../lib/context'
import { bucketTitle } from '../lib/format'
import { useBucketViews } from '../lib/queries'

export function Dashboard() {
  const { config } = useApp()
  const buckets = config.deployment.buckets
  const { data, isLoading, error } = useBucketViews(buckets)

  return (
    <main className="page">
      <section className="hero">
        <h1>
          Wallets hold assets.
          <br />
          <span>Buckets hold financial intent.</span>
        </h1>
        <div className="thesis">
          <div>
            <b>WHO</b>
            <span>ENSv2 identity, resolved live — never assumed authorization by itself</span>
          </div>
          <div>
            <b>WHAT</b>
            <span>A Financial Capability defines exactly what that identity may do, and never more than its parent</span>
          </div>
          <div>
            <b>HOW</b>
            <span>1inch Aqua + SwapVM on EVM — enforced live on every fill</span>
          </div>
        </div>
      </section>

      <h2 className="section-title">Buckets</h2>
      {buckets.length === 0 ? (
        <p className="muted">No Buckets yet. Run `pnpm demo` to create the Trading, Savings and Payments Buckets.</p>
      ) : null}
      {isLoading ? <Spinner /> : null}
      {error ? <ErrorBox error={error} /> : null}
      <div className="cards">
        {data?.map(({ entry, view, error: loadError }) => (
          <a key={entry.bucketId} className="card" href={`#/bucket/${entry.bucketId}`}>
            <div className="card-head">
              <div>
                <div className="card-title">{bucketTitle(entry.ensName)}</div>
                <div className="ens small">{entry.ensName}</div>
              </div>
              {view ? (
                view.allocation.outOfPolicy ? (
                  <Chip tone="warn">REBALANCE REQUIRED</Chip>
                ) : (
                  <Chip tone="ok">IN POLICY</Chip>
                )
              ) : (
                <Chip tone="neutral">—</Chip>
              )}
            </div>
            {view ? (
              <>
                <div className="card-value mono">{formatUsd(view.allocation.totalValueWad)}</div>
                <AllocationStack allocation={view.allocation} />
                <div className="card-foot muted small">
                  max deviation {formatWeight(view.allocation.maxAbsDeviationWad, 1)} · threshold{' '}
                  {view.snapshot.params.rebalanceThresholdBps / 100}% · policy v{view.snapshot.policyVersion}
                </div>
              </>
            ) : (
              <p className="muted small">{loadError?.includes('EmptyBucket') ? 'Not funded yet.' : loadError}</p>
            )}
          </a>
        ))}
      </div>
    </main>
  )
}
