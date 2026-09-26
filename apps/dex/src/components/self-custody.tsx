import { Lock, ShieldCheck } from 'lucide-react'
import type { ReactNode } from 'react'

import { Card, Row } from '@/components/ui/primitives'
import { cn } from '@/lib/utils'

/** The protocol's core promise, stated plainly next to every action. */
export function SelfCustodyPanel({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <Card className={cn('p-5', className)}>
      <div className="flex items-center gap-2 text-sm font-semibold">
        <Lock className="h-4 w-4 text-accent" /> Self-custodial execution
      </div>
      <p className="mt-2 text-sm text-muted">
        Your assets remain in your wallet. BUCKET only controls what an authorized operator is allowed to execute — and
        every limit is enforced on-chain.
      </p>
      {children ? <div className="mt-4 border-t border-line pt-3">{children}</div> : null}
    </Card>
  )
}

export function DelegatedAuthority({
  operatorName,
  operatorAddress,
  perExecution,
  perDay,
  expires,
}: {
  operatorName: string | null
  operatorAddress: string
  perExecution: string
  perDay: string
  expires: string
}) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wider text-faint">
        <ShieldCheck className="h-3.5 w-3.5" /> Delegated authority
      </div>
      <Row label="Operator">
        <span className="font-medium">{operatorName ?? ''}</span>{' '}
        <span className="font-mono text-xs text-muted">{operatorAddress.slice(0, 6)}…{operatorAddress.slice(-4)}</span>
      </Row>
      <Row label="Execution limit">{perExecution}</Row>
      <Row label="Daily limit">{perDay}</Row>
      <Row label="Expires">{expires}</Row>
      <div className="mt-2 rounded-lg bg-accent/5 px-3 py-2 text-xs text-accent">Funds remain in your wallet.</div>
    </div>
  )
}
