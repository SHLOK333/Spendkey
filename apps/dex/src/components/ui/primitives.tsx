import { ChevronDown, ExternalLink, Loader2 } from 'lucide-react'
import { useState, type HTMLAttributes, type InputHTMLAttributes, type ReactNode } from 'react'

import { cn, shortAddr } from '@/lib/utils'

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('rounded-2xl border border-line bg-panel', className)} {...props} />
}

export function CardHeader({ title, subtitle, action, className }: { title: ReactNode; subtitle?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-start justify-between gap-4 px-5 pt-5', className)}>
      <div>
        <div className="text-sm font-semibold text-fg">{title}</div>
        {subtitle ? <div className="mt-0.5 text-xs text-muted">{subtitle}</div> : null}
      </div>
      {action}
    </div>
  )
}

export function Badge({ tone = 'neutral', className, children }: { tone?: 'neutral' | 'green' | 'red' | 'amber' | 'blue'; className?: string; children: ReactNode }) {
  const tones = {
    neutral: 'bg-panel-3 text-muted border-line',
    green: 'bg-accent/10 text-accent border-accent/25',
    red: 'bg-danger/10 text-danger border-danger/25',
    amber: 'bg-warn/10 text-warn border-warn/25',
    blue: 'bg-brand/10 text-brand border-brand/25',
  }
  return <span className={cn('inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium', tones[tone], className)}>{children}</span>
}

export function StatusDot({ active }: { active: boolean }) {
  return <span className={cn('inline-block h-2 w-2 rounded-full', active ? 'bg-accent shadow-[0_0_8px] shadow-accent/60' : 'bg-danger')} />
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cn('h-10 w-full rounded-xl border border-line bg-panel-2 px-3 text-sm text-fg placeholder:text-faint outline-none focus:border-brand/60', className)}
      {...props}
    />
  )
}

export function Label({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between text-xs">
      <span className="font-medium text-muted">{children}</span>
      {hint ? <span className="text-faint">{hint}</span> : null}
    </div>
  )
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} />
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-lg bg-panel-3', className)} />
}

export function Mono({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn('font-mono text-xs', className)}>{children}</span>
}

/** Human identity first, the address that actually holds authority right under it. */
export function Identity({ name, address, className }: { name?: string | null; address: string | null | undefined; className?: string }) {
  return (
    <div className={cn('min-w-0', className)}>
      <div className="truncate text-sm font-medium text-fg">{name ?? shortAddr(address)}</div>
      {name ? <Mono className="text-muted">{shortAddr(address)}</Mono> : null}
    </div>
  )
}

export function TxLink({ href, label = 'View transaction' }: { href: string; label?: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
      {label} <ExternalLink className="h-3 w-3" />
    </a>
  )
}

export function Row({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn('flex items-center justify-between gap-3 py-1.5 text-sm', className)}>
      <span className="text-muted">{label}</span>
      <span className="text-right text-fg tabular">{children}</span>
    </div>
  )
}

export function Segmented<T extends string>({ value, onChange, options, className, fill }: { value: T; onChange: (v: T) => void; options: Array<{ value: T; label: ReactNode; disabled?: boolean }>; className?: string; fill?: boolean }) {
  return (
    <div className={cn('rounded-xl border border-line bg-panel-2 p-1', fill ? 'flex w-full' : 'inline-flex', className)}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-lg px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-40 cursor-pointer',
            fill && 'flex-1',
            value === o.value ? 'bg-panel-3 text-fg shadow-[0_1px_2px_rgba(0,0,0,0.4)]' : 'text-muted hover:text-fg',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

/** Technical details, always available but never the primary message. */
export function Details({ children, label = 'Technical details' }: { children: ReactNode; label?: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-3">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1 text-xs text-faint hover:text-muted cursor-pointer">
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} /> {label}
      </button>
      {open ? <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-bg p-3 font-mono text-[11px] text-muted">{children}</pre> : null}
    </div>
  )
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <Card className="flex flex-col items-center px-6 py-12 text-center">
      {icon ? <div className="mb-3 text-muted">{icon}</div> : null}
      <div className="text-sm font-semibold">{title}</div>
      {children ? <div className="mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-5">{action}</div> : null}
    </Card>
  )
}
