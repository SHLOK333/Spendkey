import { decodeBucketError } from '@bucket/sdk'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Details, Spinner, TxLink } from '@/components/ui/primitives'
import { explainError, explainMoveAbort } from '@/lib/errors'

export interface TxOutcome {
  readonly label: string
  readonly url: string
}

/** A dangerous action: states exactly what changes, then shows the real transaction status. */
export function ConfirmTx({
  open,
  onOpenChange,
  title,
  children,
  confirmLabel,
  destructive = false,
  run,
  onDone,
}: {
  open: boolean
  onOpenChange: (o: boolean) => void
  title: string
  children: ReactNode
  confirmLabel: string
  destructive?: boolean
  run: () => Promise<TxOutcome[]>
  onDone?: () => void
}) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<TxOutcome[] | null>(null)
  const [error, setError] = useState<{ title: string; message: string; detail: string } | null>(null)

  async function go() {
    setBusy(true)
    setError(null)
    try {
      setDone(await run())
      onDone?.()
    } catch (e) {
      const decoded = decodeBucketError(e)
      const text = e instanceof Error ? e.message : String(e)
      const explained = explainError(decoded?.errorName) ?? explainMoveAbort(text)
      const rejected = /User rejected|denied|rejected the request/i.test(text)
      setError({
        title: rejected ? 'Cancelled in wallet' : (explained?.title ?? 'Transaction failed'),
        message: rejected ? 'Nothing was submitted.' : (explained?.message ?? 'The transaction did not go through.'),
        detail: decoded?.message ?? text,
      })
    } finally {
      setBusy(false)
    }
  }

  function close(o: boolean) {
    if (!o) {
      setDone(null)
      setError(null)
    }
    onOpenChange(o)
  }

  return (
    <Dialog open={open} onOpenChange={close} title={title}>
      {done ? (
        <div className="space-y-3">
          <div className="rounded-xl border border-accent/30 bg-accent/5 p-4 text-sm text-accent">Confirmed on-chain.</div>
          <div className="flex flex-wrap gap-3">
            {done.map((d) => (
              <TxLink key={d.url} href={d.url} label={`${d.label} ↗`} />
            ))}
          </div>
          <Button className="w-full" onClick={() => close(false)}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="text-sm">{children}</div>
          {error ? (
            <div className="rounded-xl border border-danger/30 bg-danger/5 p-4 text-sm">
              <div className="font-semibold text-danger">{error.title}</div>
              <div className="mt-1 text-muted">{error.message}</div>
              <Details>{error.detail}</Details>
            </div>
          ) : null}
          <div className="flex gap-3">
            <Button variant="ghost" className="flex-1" onClick={() => close(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant={destructive ? 'dangerSolid' : 'primary'} className="flex-1" onClick={() => void go()} disabled={busy}>
              {busy ? <Spinner /> : null} {confirmLabel}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
