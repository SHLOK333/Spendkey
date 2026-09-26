import { Activity, ArrowLeftRight, Bot, Check, ChevronDown, Layers, Menu, PieChart, Send, Sparkles, X } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { ConnectWallet, WrongChainNotice } from '@/components/connect'
import { useApp, type Network } from '@/lib/client/app'
import { cn } from '@/lib/utils'

type NavLink = { href: string; label: string; icon: ReactNode; desc?: string }

/** Flat pills, always visible. */
const PRIMARY: NavLink[] = [
  { href: '/trade', label: 'Trade', icon: <ArrowLeftRight className="h-[18px] w-[18px]" /> },
  { href: '/pay', label: 'Pay', icon: <Send className="h-[18px] w-[18px]" /> },
  { href: '/agents', label: 'Agents', icon: <Bot className="h-[18px] w-[18px]" /> },
  { href: '/buckets', label: 'Buckets', icon: <Layers className="h-[18px] w-[18px]" /> },
]

/** Grouped under a single "Insights" dropdown. */
const INSIGHTS_LABEL = 'Insights'
const INSIGHTS: NavLink[] = [
  { href: '/portfolio', label: 'Portfolio', icon: <PieChart className="h-[18px] w-[18px]" />, desc: 'Balances & allocation' },
  { href: '/activity', label: 'Activity', icon: <Activity className="h-[18px] w-[18px]" />, desc: 'On-chain event feed' },
  { href: '/rale', label: 'RALE', icon: <Sparkles className="h-[18px] w-[18px]" />, desc: 'Risk-adaptive liquidity engine' },
]

type NetworkOption = { value: Network; label: string; hint: string; color: string }

/** Network dropdown — pick the active chain; new chains can be added to this list. */
export function NetworkSwitch({ className }: { className?: string }) {
  const { network, setNetwork, deployment } = useApp()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const options: NetworkOption[] = [
    { value: 'sepolia', label: 'Ethereum', hint: 'Sepolia', color: '#627eea' },
    { value: 'sui', label: 'Sui', hint: 'Testnet', color: '#4da2ff' },
  ]
  const active = options.find((o) => o.value === network) ?? options[0]!

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} className={cn('relative', className)}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-2 rounded-full border border-white/10 bg-panel-2 py-2 pl-3 pr-2.5 text-sm font-medium text-fg transition-colors hover:bg-panel-3 cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: active.color }} />
          {active.label}
        </span>
        <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="listbox"
          className="absolute right-0 z-50 mt-2 w-52 overflow-hidden rounded-2xl border border-white/10 bg-panel p-1.5 shadow-[0_16px_48px_-16px_rgba(0,0,0,0.7)]"
        >
          {options.map((o) => {
            const disabled = o.value === 'sui' && !deployment.sui
            const selected = o.value === network
            return (
              <button
                key={o.value}
                role="option"
                aria-selected={selected}
                disabled={disabled}
                onClick={() => {
                  setNetwork(o.value)
                  setOpen(false)
                }}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-xl px-2.5 py-2 text-left text-sm transition-colors',
                  disabled ? 'cursor-not-allowed opacity-40' : 'cursor-pointer hover:bg-white/5',
                  selected && 'bg-white/5',
                )}
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: o.color }} />
                <span className="min-w-0 flex-1">
                  <span className="font-medium text-fg">{o.label}</span>
                  <span className="ml-1.5 text-xs text-faint">{disabled ? 'unavailable' : o.hint}</span>
                </span>
                {selected ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
              </button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

function Logo() {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5">
      <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-[14px] font-black text-accent-fg shadow-[0_0_24px_rgba(198,242,78,0.35)]">
        B
      </span>
      <span className="text-[15px] font-bold tracking-tight text-fg">BUCKET</span>
    </Link>
  )
}

function useActive() {
  const path = useLocation().pathname
  return (href: string) => path === href || path.startsWith(`${href}/`)
}

/** The "Insights" dropdown for the desktop bar — groups Portfolio, Activity and RALE. */
function InsightsDropdown() {
  const isActive = useActive()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const groupActive = INSIGHTS.some((l) => isActive(l.href))

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={cn(
          'flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition-colors cursor-pointer',
          groupActive ? 'bg-white/10 text-fg' : 'text-muted hover:bg-white/10 hover:text-fg',
        )}
      >
        <span className={cn(groupActive ? 'text-accent' : 'text-muted')}>
          <Sparkles className="h-[18px] w-[18px]" />
        </span>
        {INSIGHTS_LABEL}
        <ChevronDown className={cn('h-4 w-4 text-muted transition-transform', open && 'rotate-180')} />
      </button>

      {open ? (
        <div
          role="menu"
          className="absolute left-0 z-50 mt-2 w-64 overflow-hidden rounded-2xl border border-white/10 bg-panel p-1.5 shadow-[0_16px_48px_-16px_rgba(0,0,0,0.7)]"
        >
          {INSIGHTS.map((l) => {
            const active = isActive(l.href)
            return (
              <Link
                key={l.href}
                to={l.href}
                role="menuitem"
                onClick={() => setOpen(false)}
                className={cn(
                  'flex items-center gap-3 rounded-xl px-2.5 py-2 text-left transition-colors',
                  active ? 'bg-white/5' : 'hover:bg-white/5',
                )}
              >
                <span className={cn('shrink-0', active ? 'text-accent' : 'text-muted')}>{l.icon}</span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-sm font-medium text-fg">
                    {l.label}
                    {l.href === '/rale' ? (
                      <span className="rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">new</span>
                    ) : null}
                  </span>
                  {l.desc ? <span className="block truncate text-xs text-faint">{l.desc}</span> : null}
                </span>
                {active ? <Check className="h-4 w-4 shrink-0 text-accent" /> : null}
              </Link>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}

/** Horizontal pill links for the desktop floating bar. */
function DesktopLinks() {
  const isActive = useActive()
  return (
    <nav className="hidden items-center gap-1 lg:flex">
      {PRIMARY.map((l) => {
        const active = isActive(l.href)
        return (
          <Link
            key={l.href}
            to={l.href}
            className={cn(
              'flex items-center gap-2 rounded-full px-3.5 py-2 text-sm font-medium transition-colors',
              active ? 'bg-white/10 text-fg' : 'text-muted hover:bg-white/10 hover:text-fg',
            )}
          >
            <span className={cn(active ? 'text-accent' : 'text-muted')}>{l.icon}</span>
            {l.label}
          </Link>
        )
      })}
      <InsightsDropdown />
    </nav>
  )
}

/** Stacked links for the mobile dropdown pill. */
function MobileLinks({ onNavigate }: { onNavigate: () => void }) {
  const isActive = useActive()
  const item = (l: NavLink) => {
    const active = isActive(l.href)
    return (
      <Link
        key={l.href}
        to={l.href}
        onClick={onNavigate}
        className={cn(
          'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
          active ? 'bg-white/10 text-fg' : 'text-muted hover:bg-white/10 hover:text-fg',
        )}
      >
        <span className={cn(active ? 'text-accent' : 'text-muted')}>{l.icon}</span>
        {l.label}
        {l.href === '/rale' ? (
          <span className="ml-auto rounded-full bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">new</span>
        ) : null}
      </Link>
    )
  }
  return (
    <nav className="space-y-1">
      {PRIMARY.map(item)}
      <div className="px-3 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wider text-faint">{INSIGHTS_LABEL}</div>
      {INSIGHTS.map(item)}
    </nav>
  )
}

/**
 * Modern floating navbar — a rounded pill detached from the top edge (Framer "Modern Navbar" style):
 * logo left, horizontal links, network + wallet right, backdrop-blurred translucent surface. Top only.
 */
export function Nav() {
  const [open, setOpen] = useState(false)
  return (
    <header className="sticky top-4 z-40 px-4">
      <div className="mx-auto max-w-6xl">
        <div className="flex h-16 items-center justify-between gap-4 rounded-[28px] border border-white/10 bg-panel/70 pl-5 pr-3 shadow-[0_10px_40px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl">
          <div className="flex items-center gap-6">
            <Logo />
            <DesktopLinks />
          </div>

          <div className="flex items-center gap-2.5">
            <NetworkSwitch className="hidden w-[150px] sm:block" />
            <div className="hidden sm:block">
              <ConnectWallet />
            </div>
            <button
              className="rounded-full p-2 text-muted hover:bg-white/10 hover:text-fg cursor-pointer lg:hidden"
              onClick={() => setOpen((o) => !o)}
              aria-label="Menu"
            >
              {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
            </button>
          </div>
        </div>

        {/* Mobile dropdown pill */}
        {open ? (
          <div className="mt-2 rounded-3xl border border-white/10 bg-panel/95 p-4 backdrop-blur-xl lg:hidden">
            <MobileLinks onNavigate={() => setOpen(false)} />
            <div className="mt-4 space-y-3 border-t border-line pt-4">
              <NetworkSwitch />
              <div className="[&>button]:w-full [&>button]:justify-center">
                <ConnectWallet />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div className="mx-auto mt-2 max-w-6xl">
        <WrongChainNotice />
      </div>
    </header>
  )
}
