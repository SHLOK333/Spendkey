import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
import { formatUnits } from 'viem'

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs))
}

export function shortAddr(address: string | null | undefined, head = 6, tail = 4): string {
  if (!address) return '—'
  return address.length <= head + tail + 1 ? address : `${address.slice(0, head)}…${address.slice(-tail)}`
}

/** USD from an 18-decimal WAD value. */
export function usdWad(wad: bigint, digits = 2): string {
  const n = Number(formatUnits(wad, 18))
  return n.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function tokenAmount(amount: bigint, decimals: number, maxFraction = 6): string {
  const n = Number(formatUnits(amount, decimals))
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFraction })
}

export function decimalString(value: string, maxFraction = 6): string {
  const n = Number(value)
  return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: maxFraction }) : value
}

export function relativeExpiry(unixSeconds: number | bigint): string {
  const s = Number(unixSeconds) - Math.floor(Date.now() / 1000)
  if (s <= 0) return 'expired'
  if (s < 3_600) return `${Math.ceil(s / 60)} min`
  if (s < 86_400) return `${Math.round(s / 3_600)} h`
  return `${Math.round(s / 86_400)} days`
}

export function timeAgo(unixSeconds: number | null): string {
  if (!unixSeconds) return ''
  const s = Math.floor(Date.now() / 1000) - unixSeconds
  if (s < 60) return 'just now'
  if (s < 3_600) return `${Math.floor(s / 60)}m ago`
  if (s < 86_400) return `${Math.floor(s / 3_600)}h ago`
  return `${Math.floor(s / 86_400)}d ago`
}

export function dateLabel(unixSeconds: number | bigint): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}
