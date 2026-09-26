import { Permission, hasPermissions, PERMISSION_LABEL } from '@bucket/protocol-types'
import type { BucketView } from '@bucket/sdk'

import { useApp } from '../lib/context'
import { evmAddressUrl } from '../lib/format'
import { useCapabilities } from '../lib/queries'
import { Check, Chip, HexLink, Panel } from './primitives'

const MATRIX: ReadonlyArray<{ label: string; permission: number | null; note?: string }> = [
  { label: PERMISSION_LABEL.Rebalance, permission: Permission.Rebalance },
  { label: PERMISSION_LABEL.Swap, permission: Permission.Swap },
  { label: PERMISSION_LABEL.Pay, permission: Permission.Pay },
  { label: PERMISSION_LABEL.Delegate, permission: Permission.Delegate },
  { label: PERMISSION_LABEL.UpdatePolicy, permission: Permission.UpdatePolicy },
  { label: PERMISSION_LABEL.ChangeOwner, permission: null, note: 'only via the ENSv2 name' },
  { label: PERMISSION_LABEL.Withdraw, permission: null, note: 'never delegable' },
]

const STATUS_TONE = { 1: 'ok', 2: 'bad', 3: 'warn' } as const

export function AuthorityPanel({ view }: { view: BucketView }) {
  const { config } = useApp()
  const entry = config.deployment.buckets.find((b) => b.bucketId === view.bucketId)
  const capabilities = useCapabilities(view.bucketId, entry?.capabilities ?? [])
  const ownerName = config.deployment.ens?.ownerName ?? view.ensName.split('.').slice(1).join('.')

  return (
    <Panel eyebrow="ENSv2 · Financial Capabilities" title="Authority">
      <div className="authority-ids">
        <div>
          <div className="label">Owner</div>
          <div className="ens">{ownerName}</div>
          <HexLink value={view.owner} href={evmAddressUrl(config.deployment, view.owner)} />
        </div>
        <div>
          <div className="label">Bucket name</div>
          <div className="ens">{view.ensName}</div>
          <span className="muted small">owner = live ENSv2 owner of this name; also the wallet holding every asset</span>
        </div>
      </div>

      {!capabilities.data || capabilities.data.length === 0 ? (
        <p className="muted">No capabilities issued for this Bucket yet.</p>
      ) : (
        capabilities.data.map(({ entry: capEntry, capability }) => (
          <div key={capEntry.nonce} className="operator">
            <div className="operator-head">
              <div>
                <div className="label">Operator ({capEntry.label})</div>
                <div className="ens">{capEntry.operatorLabel}</div>
                {capability ? (
                  <HexLink value={capability.operator} href={evmAddressUrl(config.deployment, capability.operator)} />
                ) : (
                  <Chip tone="bad">capability not found on-chain</Chip>
                )}
              </div>
              {capability ? (
                <Chip tone={STATUS_TONE[capability.status as 1 | 2 | 3] ?? 'neutral'}>
                  {capability.status === 1 ? 'ACTIVE' : capability.status === 2 ? 'REVOKED' : 'EXHAUSTED'}
                </Chip>
              ) : null}
            </div>
            {capability ? (
              <>
                <table className="matrix">
                  <tbody>
                    {MATRIX.map((row) => (
                      <tr key={row.label}>
                        <td>{row.label}</td>
                        <td>
                          <Check value={row.permission !== null && hasPermissions(capability.permissions, row.permission)} />
                        </td>
                        <td className="muted small">{row.note ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="footnote">
                  Valid until block timestamp {capability.validUntil} · executions so far {capability.executions.toString()}
                  {capability.limits.maxExecutions > 0 ? ` / ${capability.limits.maxExecutions}` : ''}
                </p>
              </>
            ) : null}
          </div>
        ))
      )}
      <p className="footnote">
        A capability's authority is re-derived live on every call: the ENSv2 name still owned, the current epoch,
        the current policy version and the validity window. Revoking it, advancing the epoch, or a policy change
        each independently void it — nothing here is a standing role.
      </p>
    </Panel>
  )
}
