import { CapabilityStatus, Permission, formatUsd, hasPermissions, type Capability } from '@bucket/protocol-types'
import type { ReactNode } from 'react'
import { isAddressEqual } from 'viem'

import { Badge, Card, Identity, Row, StatusDot } from '@/components/ui/primitives'
import type { CapabilityRow } from '@/lib/client/queries'
import { relativeExpiry, shortAddr } from '@/lib/utils'

export function capabilityTitle(permissions: number): string {
  if (hasPermissions(permissions, Permission.Pay)) return 'Payments Agent'
  if (hasPermissions(permissions, Permission.Swap)) return 'Trading Agent'
  if (hasPermissions(permissions, Permission.Rebalance)) return 'Rebalance Agent'
  return 'Operator'
}

export function capabilityState(row: Pick<CapabilityRow, 'capability' | 'live'>): { label: string; active: boolean } {
  const c = row.capability
  if (c.status === CapabilityStatus.Revoked) return { label: 'Revoked', active: false }
  if (c.status === CapabilityStatus.Exhausted) return { label: 'Used up', active: false }
  if (c.validUntil * 1000 < Date.now()) return { label: 'Expired', active: false }
  if (!row.live) return { label: c.validAfter * 1000 > Date.now() ? 'Not active yet' : 'Superseded', active: false }
  return { label: 'Active', active: true }
}

function allowedLabel(c: Capability, symbols: string[]): string {
  const assets = symbols.filter((_, i) => (c.assetMask & (1 << i)) !== 0)
  if (hasPermissions(c.permissions, Permission.Pay)) return `Pay ${assets.join(', ')}`
  const kinds = [hasPermissions(c.permissions, Permission.Swap) && 'Swap', hasPermissions(c.permissions, Permission.Rebalance) && 'Rebalance'].filter(Boolean)
  return `${kinds.join(' + ')} · ${assets.join(' ↔ ')}`
}

export function CapabilityCard({
  row,
  bucketName,
  symbols,
  actions,
}: {
  row: CapabilityRow
  bucketName: string
  symbols: string[]
  actions?: ReactNode
}) {
  const c = row.capability
  const state = capabilityState(row)
  const remaining = row.limits ? [row.limits.remainingDailyValue, row.limits.remainingHourlyValue, row.limits.remainingTurnoverValue].reduce((a, b) => (a < b ? a : b)) : null
  return (
    <Card className="flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <div className="text-base font-semibold">{capabilityTitle(c.permissions)}</div>
          <div className="mt-0.5 font-mono text-[11px] text-faint">{shortAddr(row.id, 10, 6)}</div>
        </div>
        <Badge tone={state.active ? 'green' : 'red'}>
          <StatusDot active={state.active} /> {state.label}
        </Badge>
      </div>
      <div className="mt-4">
        <div className="text-xs text-muted">Operator</div>
        <Identity name={`${c.operatorLabel}.${bucketName}`} address={c.operator} />
      </div>
      <div className="mt-3 border-t border-line pt-2">
        <Row label="Allowed">{allowedLabel(c, symbols)}</Row>
        <Row label="Max / execution">{formatUsd(c.limits.maxExecutionValue)}</Row>
        <Row label="Max / day">{formatUsd(c.limits.maxDailyValue)}</Row>
        {remaining !== null ? <Row label="Remaining now">{formatUsd(remaining)}</Row> : null}
        {hasPermissions(c.permissions, Permission.Pay) ? (
          <Row label="Fixed payee">
            <span className="font-mono text-xs">{shortAddr(c.payee)}</span>
          </Row>
        ) : null}
        <Row label="Expires">{state.label === 'Expired' ? 'expired' : relativeExpiry(c.validUntil)}</Row>
      </div>
      {actions ? <div className="mt-4 flex gap-2">{actions}</div> : null}
    </Card>
  )
}

export function isOperator(row: CapabilityRow, address: string | null): boolean {
  return !!address && isAddressEqual(row.capability.operator, address as `0x${string}`)
}

