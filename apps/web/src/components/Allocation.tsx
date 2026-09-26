import { BPS_TO_WAD, formatBps, formatDeviation, formatUsd, formatWeight, WAD } from '@bucket/protocol-types'
import type { AllocationRow, BucketAllocation } from '@bucket/sdk'

const ASSET_COLORS: Record<string, string> = { USDC: 'var(--usdc)', ETH: 'var(--eth)', SUI: 'var(--sui)' }
const FALLBACK = ['var(--a1)', 'var(--a2)', 'var(--a3)', 'var(--a4)']

export function assetColor(symbol: string, index: number): string {
  return ASSET_COLORS[symbol] ?? FALLBACK[index % FALLBACK.length] ?? 'var(--a1)'
}

/** WAD fraction -> CSS percentage with 0.01% resolution (display only). */
function pct(weightWad: bigint): string {
  const hundredths = (weightWad * 10_000n) / WAD
  return `${Number(hundredths) / 100}%`
}

function bpsPct(bps: number): string {
  return `${bps / 100}%`
}

/** Two stacked bars: where the capital is, and where the policy says it should be. */
export function AllocationStack({ allocation }: { allocation: BucketAllocation }) {
  return (
    <div className="stack">
      <div className="stack-row">
        <span className="stack-label">Current</span>
        <div className="stack-bar">
          {allocation.rows.map((row) => (
            <div
              key={row.token}
              className="stack-seg"
              style={{ width: pct(row.weightWad), background: assetColor(row.symbol, row.index) }}
              title={`${row.symbol} ${formatWeight(row.weightWad)}`}
            >
              {row.weightWad >= 8n * 10n ** 16n ? `${row.symbol} ${formatWeight(row.weightWad, 0)}` : null}
            </div>
          ))}
        </div>
      </div>
      <div className="stack-row">
        <span className="stack-label">Target</span>
        <div className="stack-bar stack-target">
          {allocation.rows.map((row) => (
            <div
              key={row.token}
              className="stack-seg"
              style={{ width: bpsPct(row.targetBps), background: assetColor(row.symbol, row.index) }}
              title={`${row.symbol} ${formatBps(row.targetBps)}`}
            >
              {row.targetBps >= 800 ? `${row.symbol} ${formatBps(row.targetBps)}` : null}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

function Track({ row, thresholdBps }: { row: AllocationRow; thresholdBps: number }) {
  const threshold = BigInt(thresholdBps) * BPS_TO_WAD
  const deviation = row.deviationWad < 0n ? -row.deviationWad : row.deviationWad
  const outside =
    deviation > threshold ||
    row.weightWad < BigInt(row.minBps) * BPS_TO_WAD ||
    row.weightWad > BigInt(row.maxBps) * BPS_TO_WAD
  const low = Math.max(0, row.targetBps - thresholdBps)
  const high = Math.min(10_000, row.targetBps + thresholdBps)
  return (
    <div className="track-row">
      <div className="track-asset">
        <span className="dot" style={{ background: assetColor(row.symbol, row.index) }} />
        <strong>{row.symbol}</strong>
      </div>
      <div className="track" aria-label={`${row.symbol} weight`}>
        <div className="track-band" style={{ left: bpsPct(row.minBps), width: bpsPct(row.maxBps - row.minBps) }} />
        <div className="track-zone" style={{ left: bpsPct(low), width: bpsPct(high - low) }} />
        <div className={`track-fill ${outside ? 'is-out' : 'is-in'}`} style={{ width: pct(row.weightWad) }} />
        <div className="track-target" style={{ left: bpsPct(row.targetBps) }} />
      </div>
      <div className="track-num mono">{formatWeight(row.weightWad, 1)}</div>
      <div className="track-num mono muted">{formatBps(row.targetBps)}</div>
      <div className={`track-num mono ${outside ? 'warn' : 'ok'}`}>{formatDeviation(row.deviationWad, 1)}</div>
      <div className="track-num mono muted">{formatUsd(row.valueWad)}</div>
    </div>
  )
}

/** Per-asset policy tracks: hard band (min–max), rebalance zone (target ± threshold), target tick, current weight. */
export function AllocationTracks({ allocation, thresholdBps }: { allocation: BucketAllocation; thresholdBps: number }) {
  return (
    <div className="tracks">
      <div className="track-row track-head">
        <div>Asset</div>
        <div>0% ─ weight ─ 100%</div>
        <div>Current</div>
        <div>Target</div>
        <div>Deviation</div>
        <div>Value</div>
      </div>
      {allocation.rows.map((row) => (
        <Track key={row.token} row={row} thresholdBps={thresholdBps} />
      ))}
      <div className="legend">
        <span>
          <i className="lg lg-band" /> hard band
        </span>
        <span>
          <i className="lg lg-zone" /> target ± threshold
        </span>
        <span>
          <i className="lg lg-target" /> target
        </span>
      </div>
    </div>
  )
}
