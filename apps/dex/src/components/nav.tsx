import { Activity, ArrowLeftRight, Bot, Layers, Menu, PieChart, Send, X } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Link, useLocation } from 'react-router-dom'

import { ConnectWallet, WrongChainNotice } from '@/components/connect'
import { cn } from '@/lib/utils'

type NavLink = { href: string; label: string; icon: ReactNode }

const LINKS: NavLink[] = [
  { href: '/trade', label: 'Trade', icon: <ArrowLeftRight className="h-[18px] w-[18px]" /> },
  { href: '/pay', label: 'Pay', icon: <Send className="h-[18px] w-[18px]" /> },
  { href: '/agents', label: 'Agents', icon: <Bot className="h-[18px] w-[18px]" /> },
  { href: '/buckets', label: 'Buckets', icon: <Layers className="h-[18px] w-[18px]" /> },
  { href: '/portfolio', label: 'Portfolio', icon: <PieChart className="h-[18px] w-[18px]" /> },
  { href: '/activity', label: 'Activity', icon: <Activity className="h-[18px] w-[18px]" /> },
]

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

/** Horizontal pill links for the desktop floating bar. */
function DesktopLinks() {
  const isActive = useActive()
  return (
    <nav className="hidden items-center gap-1 lg:flex">
      {LINKS.map((l) => {
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
    </nav>
  )
}

/** Stacked links for the mobile dropdown pill. */
function MobileLinks({ onNavigate }: { onNavigate: () => void }) {
  const isActive = useActive()
  return (
    <nav className="space-y-1">
      {LINKS.map((l) => {
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
          </Link>
        )
      })}
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
