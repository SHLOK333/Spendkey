import { ArrowUp, Bot, Sparkles, Zap } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'

import { ActionFlow } from '@/components/execution'
import { Badge, Spinner } from '@/components/ui/primitives'
import type { AgentAction } from '@/lib/agent/schema'
import { clearSession } from '@/lib/client/agent'
import { cn } from '@/lib/utils'

interface Message {
  readonly role: 'user' | 'assistant'
  readonly content: string
  readonly action?: AgentAction | null
  readonly note?: string
}

export interface QuickAction {
  readonly label: string
  readonly action: AgentAction
  readonly hint?: string
}

export type Selection = { network: 'sepolia'; bucketId: string } | { network: 'sui'; bucketObjectId: string }

/** Cycling headline (Codigo "AIChatPrompt" style): fades between prompts on an interval. */
function CyclingTitle({ phrases }: { phrases: string[] }) {
  const [i, setI] = useState(0)
  const [show, setShow] = useState(true)
  useEffect(() => {
    const t = setInterval(() => {
      setShow(false)
      const swap = setTimeout(() => {
        setI((n) => (n + 1) % phrases.length)
        setShow(true)
      }, 260)
      return () => clearTimeout(swap)
    }, 3200)
    return () => clearInterval(t)
  }, [phrases.length])
  return (
    <h2
      className={cn(
        'text-center text-[28px] font-medium tracking-tight text-fg transition-all duration-300 md:text-[34px]',
        show ? 'translate-y-0 opacity-100' : 'translate-y-1 opacity-0',
      )}
    >
      {phrases[i]}
    </h2>
  )
}

/**
 * Codigo-style prompt box: a rounded dark surface with an auto-growing textarea and a send button
 * that scales/fades in once there is text. Enter sends, Shift+Enter inserts a newline.
 */
function PromptBox({
  value,
  onChange,
  onSubmit,
  busy,
  placeholder,
  autoFocus,
}: {
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  busy: boolean
  placeholder: string
  autoFocus?: boolean
}) {
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [value])
  const canSend = value.trim().length > 0 && !busy
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit()
      }}
      className="group flex items-end gap-2 rounded-[26px] border border-white/10 bg-panel-3 p-2 pl-4 shadow-[0_20px_50px_-24px_rgba(0,0,0,0.7)] transition-colors focus-within:border-white/20"
    >
      <textarea
        ref={ref}
        value={value}
        autoFocus={autoFocus}
        rows={1}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault()
            if (canSend) onSubmit()
          }
        }}
        placeholder={placeholder}
        className="max-h-40 min-h-[28px] flex-1 resize-none bg-transparent py-2 text-sm leading-relaxed outline-none placeholder:text-faint"
      />
      <button
        type="submit"
        disabled={!canSend}
        aria-label="Send"
        className={cn(
          'grid h-9 w-9 shrink-0 place-items-center rounded-full bg-accent text-accent-fg transition-all duration-200',
          canSend ? 'scale-100 opacity-100' : 'pointer-events-none scale-75 opacity-0',
        )}
      >
        <ArrowUp className="h-4 w-4" strokeWidth={2.5} />
      </button>
    </form>
  )
}

/** Suggestion chips (Codigo quick prompts) mapped onto real BUCKET quick actions. */
function Chips({ actions, onPick }: { actions: QuickAction[]; onPick: (q: QuickAction) => void }) {
  if (actions.length === 0) return null
  return (
    <div className="flex flex-wrap justify-center gap-2">
      {actions.map((q) => (
        <button
          key={q.label}
          onClick={() => onPick(q)}
          title={q.hint}
          className="rounded-full border border-white/10 bg-white/5 px-3.5 py-1.5 text-xs font-medium text-muted transition-colors hover:border-accent/40 hover:bg-accent/5 hover:text-fg cursor-pointer"
        >
          {q.label}
        </button>
      ))}
    </div>
  )
}

export function AgentChat({
  title,
  selection,
  aiConfigured,
  quickActions,
  onConfigure,
}: {
  title: string
  selection: Selection
  aiConfigured: boolean
  quickActions: QuickAction[]
  onConfigure: () => void
}) {
  const target = selection.network === 'sui' ? selection.bucketObjectId : selection.bucketId
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // Default to autonomous (session-key) mode: the owner authorizes once on the first action, then the
  // agent acts with no further prompts — every execution still bounded on-chain by the capability.
  const [mode, setMode] = useState<'copilot' | 'autonomous'>('autonomous')
  const bottom = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setMode('autonomous')
  }, [target])
  useEffect(() => {
    void bottom.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function send(text: string) {
    const next: Message[] = [...messages, { role: 'user', content: text }]
    setMessages(next)
    setInput('')
    setBusy(true)
    try {
      const res = await fetch('/api/agent/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ selection, messages: next.map((m) => ({ role: m.role, content: m.content })) }),
      })
      const body = (await res.json()) as { reply?: string; proposal?: AgentAction | null; note?: string; error?: string }
      if (!res.ok) throw new Error(body.error ?? 'agent unavailable')
      setMessages((m) => [...m, { role: 'assistant', content: body.reply ?? '', action: body.proposal ?? null, ...(body.note ? { note: body.note } : {}) }])
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: e instanceof Error ? e.message : String(e) }])
    } finally {
      setBusy(false)
    }
  }

  function propose(q: QuickAction) {
    setMessages((m) => [...m, { role: 'user', content: q.label }, { role: 'assistant', content: 'Running BUCKET check…', action: q.action }])
  }

  const empty = messages.length === 0

  return (
    <div className="flex h-[680px] flex-col overflow-hidden rounded-2xl border border-line bg-panel">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-line bg-panel-2 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-7 w-7 place-items-center rounded-lg bg-accent/10 text-accent">
            <Bot className="h-4 w-4" />
          </div>
          <span className="text-sm font-semibold">{title}</span>
          {mode === 'autonomous' ? (
            <Badge tone="green"><Zap className="mr-1 h-2.5 w-2.5" /> Autonomous</Badge>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (mode === 'autonomous') { clearSession(target); setMode('copilot') }
              else setMode('autonomous')
            }}
            className={cn(
              'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors cursor-pointer',
              mode === 'autonomous'
                ? 'bg-accent/10 text-accent hover:bg-accent/20'
                : 'bg-panel-3 text-muted hover:text-fg',
            )}
          >
            {mode === 'autonomous' ? 'Disable auto' : <span className="flex items-center gap-1"><Zap className="h-3 w-3" /> Auto mode</span>}
          </button>
        </div>
      </div>

      {empty ? (
        /* Codigo-style centered prompt hero */
        <div className="flex flex-1 flex-col items-center justify-center gap-6 px-5 py-6">
          <div className="grid h-12 w-12 place-items-center rounded-2xl bg-panel-3 text-accent">
            <Sparkles className="h-6 w-6" />
          </div>
          <CyclingTitle phrases={['How can I help you?', 'What are we trading today?', 'Ready when you are.']} />
          <div className="w-full max-w-xl space-y-4">
            {aiConfigured ? (
              <PromptBox
                value={input}
                onChange={setInput}
                onSubmit={() => input.trim() && !busy && void send(input.trim())}
                busy={busy}
                autoFocus
                placeholder="Keep my ETH allocation around 30%…"
              />
            ) : (
              <button
                onClick={onConfigure}
                className="flex w-full items-center justify-center gap-2 rounded-[26px] border border-dashed border-line py-4 text-sm text-muted transition-colors hover:border-brand/40 hover:text-brand cursor-pointer"
              >
                <Sparkles className="h-4 w-4" /> Add your OpenAI key to chat with the agent
              </button>
            )}
            <Chips actions={quickActions} onPick={propose} />
          </div>
          <p className="max-w-sm text-center text-xs text-faint">
            Every action is verified by BUCKET and enforced on-chain before execution. Your assets never leave your wallet.
          </p>
        </div>
      ) : (
        <>
          {/* Messages */}
          <div className="flex-1 space-y-5 overflow-y-auto px-5 py-5">
            {messages.map((m, i) => (
              <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
                {m.role === 'user' ? (
                  <div className="max-w-[80%] rounded-2xl rounded-tr-sm border border-brand/20 bg-brand/10 px-4 py-2.5 text-sm text-fg">
                    {m.content}
                  </div>
                ) : (
                  <div className="max-w-[96%] space-y-3">
                    {m.content ? (
                      <div className="flex items-start gap-2.5">
                        <div className="mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
                          <Bot className="h-3 w-3" />
                        </div>
                        <p className="whitespace-pre-wrap text-sm leading-relaxed text-fg">{m.content}</p>
                      </div>
                    ) : null}
                    {m.note ? <div className="ml-7.5 text-xs text-warn">{m.note}</div> : null}
                    {m.action ? (
                      <div className="ml-7.5">
                        <ActionFlow action={m.action} autonomous={mode === 'autonomous'} />
                      </div>
                    ) : null}
                  </div>
                )}
              </div>
            ))}

            {busy ? (
              <div className="flex items-center gap-2.5 text-xs text-muted">
                <div className="grid h-5 w-5 shrink-0 place-items-center rounded-md bg-accent/10 text-accent">
                  <Bot className="h-3 w-3" />
                </div>
                <span className="flex items-center gap-1.5"><Spinner /> Reasoning over live chain state…</span>
              </div>
            ) : null}
            <div ref={bottom} />
          </div>

          {/* Docked prompt */}
          <div className="space-y-3 border-t border-line bg-panel-2 px-4 py-3">
            <Chips actions={quickActions} onPick={propose} />
            {aiConfigured ? (
              <PromptBox
                value={input}
                onChange={setInput}
                onSubmit={() => input.trim() && !busy && void send(input.trim())}
                busy={busy}
                placeholder="Ask the agent to trade, rebalance or pay…"
              />
            ) : (
              <button
                onClick={onConfigure}
                className="flex w-full items-center justify-center gap-2 rounded-xl border border-dashed border-line py-2.5 text-xs text-muted transition-colors hover:border-brand/40 hover:text-brand cursor-pointer"
              >
                <Sparkles className="h-3.5 w-3.5" /> Add OpenAI key to chat with the agent
              </button>
            )}
          </div>
        </>
      )}

    </div>
  )
}
