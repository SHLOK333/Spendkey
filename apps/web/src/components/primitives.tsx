import type { ReactNode } from 'react'

import { shortHex } from '../lib/format'

export function Panel({
  title,
  eyebrow,
  actions,
  children,
  className,
}: {
  title: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={`panel ${className ?? ''}`}>
      <header className="panel-head">
        <div>
          {eyebrow ? <div className="eyebrow">{eyebrow}</div> : null}
          <h2>{title}</h2>
        </div>
        {actions ? <div className="panel-actions">{actions}</div> : null}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export type Tone = 'ok' | 'warn' | 'bad' | 'neutral' | 'info'

export function Chip({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`chip chip-${tone}`}>{children}</span>
}

export function Check({ value, label }: { value: boolean; label?: string }) {
  return (
    <span className={`check ${value ? 'check-yes' : 'check-no'}`} aria-label={label ?? (value ? 'yes' : 'no')}>
      {value ? '✓' : '✕'}
    </span>
  )
}

export function HexLink({ value, href, head, tail }: { value: string; href: string | null; head?: number; tail?: number }) {
  const text = shortHex(value, head, tail)
  return href ? (
    <a className="mono link" href={href} target="_blank" rel="noreferrer" title={value}>
      {text}
    </a>
  ) : (
    <span className="mono" title={value}>
      {text}
    </span>
  )
}

export function KeyValue({ rows }: { rows: ReadonlyArray<readonly [ReactNode, ReactNode]> }) {
  return (
    <dl className="kv">
      {rows.map(([key, value], index) => (
        <div className="kv-row" key={index}>
          <dt>{key}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

export function Spinner() {
  return <span className="spinner" aria-hidden />
}

export function ErrorBox({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error)
  return <div className="error-box">{message}</div>
}
