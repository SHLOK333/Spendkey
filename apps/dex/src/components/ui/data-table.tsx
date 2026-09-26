import { ChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** Deterministic gradient for a token glyph so each symbol keeps a stable colour. */
const GLYPHS: Record<string, [string, string]> = {
  USDC: ['#2775ca', '#4b9bff'],
  ETH: ['#627eea', '#a6b4ff'],
  WETH: ['#627eea', '#8aa0ff'],
  SUI: ['#4da2ff', '#6fd0ff'],
  USDT: ['#26a17b', '#4fd1a5'],
  WBTC: ['#f7931a', '#ffb454'],
  DAI: ['#f5ac37', '#ffd06b'],
}

function glyphColors(symbol: string): [string, string] {
  if (GLYPHS[symbol]) return GLYPHS[symbol]
  let h = 0
  for (const ch of symbol) h = (h * 31 + ch.charCodeAt(0)) % 360
  return [`hsl(${h} 70% 45%)`, `hsl(${(h + 40) % 360} 70% 60%)`]
}

export function TokenGlyph({ symbol, size = 32, className }: { symbol: string; size?: number; className?: string }) {
  const [a, b] = glyphColors(symbol)
  return (
    <span
      className={cn('grid shrink-0 place-items-center rounded-full font-bold text-white', className)}
      style={{ width: size, height: size, fontSize: size * 0.36, background: `linear-gradient(135deg, ${a}, ${b})` }}
    >
      {symbol.slice(0, symbol.length > 3 ? 2 : 1).toUpperCase()}
    </span>
  )
}

/** Overlapping pair of glyphs (Fluid-style "USDC/WETH"). */
export function TokenPairGlyph({ a, b, size = 30 }: { a: string; b: string; size?: number }) {
  return (
    <span className="relative shrink-0" style={{ width: size * 1.6, height: size }}>
      <span className="absolute left-0 top-0 rounded-full ring-2 ring-panel">
        <TokenGlyph symbol={a} size={size} />
      </span>
      <span className="absolute top-0 rounded-full ring-2 ring-panel" style={{ left: size * 0.6 }}>
        <TokenGlyph symbol={b} size={size} />
      </span>
    </span>
  )
}

export function PageHero({
  eyebrow,
  title,
  subtitle,
  art,
  stats,
}: {
  eyebrow?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  art?: ReactNode
  stats?: Array<{ label: ReactNode; value: ReactNode }>
}) {
  return (
    <div className="relative overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div className="min-w-0">
          {eyebrow ? (
            <div className="mb-2 text-xs font-semibold uppercase tracking-[0.18em] text-accent">{eyebrow}</div>
          ) : null}
          <h1 className="text-3xl font-bold leading-[1.05] tracking-tight md:text-[2.75rem]">{title}</h1>
          {subtitle ? <p className="mt-3 max-w-2xl text-sm leading-relaxed text-muted md:text-base">{subtitle}</p> : null}
        </div>
        {stats && stats.length > 0 ? (
          <div className="flex items-center gap-8">
            {stats.map((s, i) => (
              <div key={i} className="text-right">
                <div className="text-xs text-muted underline decoration-line decoration-1 underline-offset-4">{s.label}</div>
                <div className="mt-1 text-xl font-semibold tabular md:text-2xl">{s.value}</div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {art ? <div className="pointer-events-none absolute -right-6 -top-8 hidden opacity-40 md:block">{art}</div> : null}
    </div>
  )
}

/** A secondary section heading with a left title/subtitle and right-aligned stats (Fluid "Smart Vaults" block). */
export function SectionHeader({
  title,
  subtitle,
  stats,
}: {
  title: ReactNode
  subtitle?: ReactNode
  stats?: Array<{ label: ReactNode; value: ReactNode }>
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {stats && stats.length > 0 ? (
        <div className="flex items-center gap-7">
          {stats.map((s, i) => (
            <div key={i} className="flex items-baseline gap-2">
              <span className="text-sm text-muted underline decoration-line decoration-1 underline-offset-4">{s.label}</span>
              <span className="text-lg font-semibold tabular">{s.value}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

export function FilterBar({
  label,
  value,
  onChange,
  options,
  right,
}: {
  label?: ReactNode
  value: string
  onChange: (v: string) => void
  options: Array<{ value: string; label: ReactNode }>
  right?: ReactNode
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex items-center gap-3">
        {label ? <span className="text-sm font-semibold">{label}</span> : null}
        <div className="flex items-center gap-1">
          {options.map((o) => (
            <button
              key={o.value}
              onClick={() => onChange(o.value)}
              className={cn(
                'rounded-full px-3.5 py-1.5 text-sm font-medium transition-colors cursor-pointer',
                value === o.value ? 'bg-accent/15 text-accent' : 'text-muted hover:bg-panel-2 hover:text-fg',
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {right ? <div className="flex items-center gap-2">{right}</div> : null}
    </div>
  )
}

export function TableShell({ header, children }: { header?: ReactNode; children: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-line bg-panel">
      {header ? (
        <div className="hidden grid-cols-[1.4fr_1fr_1fr_1fr_auto] gap-4 border-b border-line px-5 py-3 text-xs font-medium uppercase tracking-wider text-faint md:grid">
          {header}
        </div>
      ) : null}
      <div className="divide-y divide-line">{children}</div>
    </div>
  )
}

/**
 * One Fluid-style row: a leading identity block, a set of stat cells, and an optional trailing action / chevron.
 * `stacked` renders each cell's label above its value on every breakpoint (the Fluid "Dual Stream Liquidity" look,
 * where the table has no separate header row); the default keeps labels mobile-only under a shared header row.
 */
export function TableRow({
  leading,
  cells,
  onClick,
  trailing,
  chevron = true,
  stacked = false,
}: {
  leading: ReactNode
  cells: Array<{ label: ReactNode; value: ReactNode }>
  onClick?: () => void
  trailing?: ReactNode
  chevron?: boolean
  stacked?: boolean
}) {
  const Comp = onClick ? 'button' : 'div'
  return (
    <Comp
      onClick={onClick}
      className={cn(
        'grid w-full grid-cols-1 items-center gap-3 px-5 py-4 text-left md:grid-cols-[1.5fr_1fr_1fr_1fr_auto] md:gap-4',
        onClick && 'cursor-pointer transition-colors hover:bg-panel-2',
      )}
    >
      <div className="min-w-0">{leading}</div>
      {cells.map((c, i) => (
        <div key={i} className="min-w-0">
          <div className={cn('text-xs text-muted', stacked ? 'mb-0.5' : 'md:hidden')}>{c.label}</div>
          <div className="truncate text-sm tabular text-fg">{c.value}</div>
        </div>
      ))}
      {trailing ?? (chevron ? <ChevronRight className="hidden h-4 w-4 shrink-0 text-faint md:block" /> : null)}
    </Comp>
  )
}
