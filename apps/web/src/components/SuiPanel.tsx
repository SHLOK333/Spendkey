import { BUCKET_STATUS_LABEL, formatBps, type BucketStatus } from '@bucket/protocol-types'
import type { SuiBucket } from '@bucket/protocol-types'

import { useApp } from '../lib/context'
import { suiObjectUrl } from '../lib/format'
import { useSuiBucket } from '../lib/queries'
import { Chip, ErrorBox, HexLink, KeyValue, Panel, Spinner } from './primitives'

/**
 * A Sui-native Bucket: independent capability issuance and native payments, no price feed, no relation to any
 * EVM Bucket beyond an optional attribution-only `bind_evm` link. See `docs/ARCHITECTURE.md`.
 */
function SuiBucketCard({ entry }: { entry: SuiBucket }) {
  const { config } = useApp()
  const { data: sui, isLoading, error } = useSuiBucket(entry.objectId)

  return (
    <Panel
      eyebrow="Sui-native · independent capability + payment stack"
      title={entry.name}
      actions={sui ? <Chip tone={sui.status === 1 ? 'ok' : 'warn'}>{BUCKET_STATUS_LABEL[sui.status as BucketStatus]}</Chip> : null}
    >
      {isLoading ? <Spinner /> : null}
      {error ? <ErrorBox error={error} /> : null}
      {sui ? (
        <>
          <KeyValue
            rows={[
              ['Object', <HexLink key="o" value={sui.objectId} href={suiObjectUrl(config.deployment, sui.objectId)} />],
              ['Owner', <span key="w" className="mono">{sui.owner}</span>],
              ['Object version', sui.version.toString()],
              ['Policy version', sui.policy.version],
              ['Max per tx (raw units)', sui.policy.maxPerTx.toString()],
              ['Max daily spend (raw units)', sui.policy.maxDailySpend.toString()],
              ['Max daily turnover', formatBps(sui.policy.maxDailyTurnoverBps)],
              ['Capability epoch', sui.capabilityEpoch],
              ['Capabilities issued', sui.capabilityNonce.toString()],
              ['Guardians', sui.guardians.length > 0 ? sui.guardians.join(', ') : 'none'],
              [
                'EVM twin',
                sui.evm ? <span key="e" className="mono">{sui.evm.bucketId}</span> : 'not bound (attribution only when set)',
              ],
            ]}
          />
          <p className="footnote">
            Assets: {sui.policy.assets.map((a) => a.coinType).join(', ') || 'none configured'}. Raw units, no price
            oracle — velocity limits are meaningful per-asset, not pooled across coin types with different values.
          </p>
        </>
      ) : null}
    </Panel>
  )
}

/** Every Sui-native Bucket the deployment manifest recorded. */
export function SuiPanel() {
  const { config } = useApp()
  const buckets = config.deployment.suiBuckets
  if (buckets.length === 0) {
    return (
      <Panel eyebrow="Sui-native · independent capability + payment stack" title="Sui Buckets">
        <p className="muted">No Sui-native Buckets yet.</p>
      </Panel>
    )
  }
  return (
    <>
      {buckets.map((entry) => (
        <SuiBucketCard key={entry.objectId} entry={entry} />
      ))}
    </>
  )
}
