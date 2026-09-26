import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { Dialog } from '@/components/ui/dialog'
import { Input, Label, Spinner } from '@/components/ui/primitives'
import type { AgentStatus } from '@/lib/client/queries'

/** BYOK: the key goes to the server once, is verified with OpenAI, and is stored in an encrypted httpOnly cookie. */
export function AiSettings({ open, onOpenChange, status }: { open: boolean; onOpenChange: (o: boolean) => void; status: AgentStatus['ai'] | undefined }) {
  const qc = useQueryClient()
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState(status?.model ?? 'gpt-4o-mini')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/agent/key', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey, model }) })
      const body = (await res.json()) as { error?: string }
      if (!res.ok) throw new Error(body.error ?? 'could not save key')
      setApiKey('')
      await qc.invalidateQueries({ queryKey: ['agent-status'] })
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    await fetch('/api/agent/key', { method: 'DELETE' })
    await qc.invalidateQueries({ queryKey: ['agent-status'] })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="AI provider" description="The model only proposes actions. BUCKET authorizes; the chain enforces.">
      <div className="space-y-4">
        <div>
          <Label>Provider</Label>
          <Input value="OpenAI" disabled />
        </div>
        <div>
          <Label hint={status?.configured ? (status.source === 'byok' ? 'your key is saved' : 'using the server key') : 'not configured'}>API key</Label>
          <Input type="password" autoComplete="off" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" />
        </div>
        <div>
          <Label>Model</Label>
          <Input value={model} onChange={(e) => setModel(e.target.value)} />
        </div>
        <p className="text-xs text-muted">
          Sent to this app&apos;s server once, verified with OpenAI, then kept only in an encrypted httpOnly cookie — never readable by page scripts, never logged. The
          model receives balances, allocation and your agent&apos;s limits; never keys or signing capability.
        </p>
        {error ? <p className="text-sm text-danger">{error}</p> : null}
        <div className="flex gap-3">
          {status?.source === 'byok' ? (
            <Button variant="danger" onClick={() => void remove()}>
              Remove key
            </Button>
          ) : null}
          <Button variant="primary" className="flex-1" disabled={busy || apiKey.length < 20} onClick={() => void save()}>
            {busy ? <Spinner /> : null} Save
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
