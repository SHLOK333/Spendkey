import { formatBps, formatUsd, permissionNames, PERMISSION_LABEL } from '@bucket/protocol-types'
import type { BucketView } from '@bucket/sdk'

import { HexLink, KeyValue, Panel } from './primitives'

export function PolicyPanel({ view }: { view: BucketView }) {
  const p = view.snapshot.params
  const delegable = permissionNames(p.delegablePermissions)
    .map((name) => PERMISSION_LABEL[name])
    .join(' · ')
  return (
    <Panel eyebrow="Canonical on the EVM execution layer" title={`Policy v${view.snapshot.policyVersion}`}>
      <KeyValue
        rows={[
          ['Rebalance threshold', formatBps(p.rebalanceThresholdBps)],
          ['Maximum execution', formatUsd(p.maxExecutionValue, 0)],
          ['Maximum hourly', formatUsd(p.maxHourlyValue, 0)],
          ['Maximum daily', formatUsd(p.maxDailyValue, 0)],
          ['Maximum daily turnover', formatBps(p.maxDailyTurnoverBps)],
          ['Maximum slippage', formatBps(p.maxSlippageBps)],
          ['Price freshness', `${p.maxPriceAge}s`],
          ['Auction window', `${p.auctionDuration}s`],
          ['Venue', p.venueMask & 1 ? '1inch Aqua + SwapVM' : 'none'],
          ['Delegable', delegable || 'none'],
          ['Commitment', <HexLink key="h" value={view.snapshot.policyHash} href={null} head={10} tail={8} />],
        ]}
      />
      <p className="footnote">
        Every capability issued under this Bucket is bounded by these limits at issuance, and re-checked against
        the current policy version on every use — a policy change immediately supersedes every existing capability.
      </p>
    </Panel>
  )
}
