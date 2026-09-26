import { WAD } from './constants'

/**
 * Deterministic fixed-point formatting for display. Pure bigint arithmetic, rounding half away from zero at the
 * last displayed digit. Never used for protocol state.
 */
export function formatFixed(value: bigint, decimals: number, fractionDigits: number): string {
  if (fractionDigits > decimals) fractionDigits = decimals
  const negative = value < 0n
  const abs = negative ? -value : value
  const drop = BigInt(decimals - fractionDigits)
  const divisor = 10n ** drop
  const rounded = drop === 0n ? abs : (abs + divisor / 2n) / divisor
  const unit = 10n ** BigInt(fractionDigits)
  const whole = rounded / unit
  const fraction = rounded % unit
  const wholeText = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const text = fractionDigits > 0 ? `${wholeText}.${fraction.toString().padStart(fractionDigits, '0')}` : wholeText
  return negative && rounded !== 0n ? `-${text}` : text
}

/** USD value in WAD -> "$1,234.56". */
export function formatUsd(valueWad: bigint, fractionDigits = 2): string {
  const text = formatFixed(valueWad, 18, fractionDigits)
  return text.startsWith('-') ? `-$${text.slice(1)}` : `$${text}`
}

/** WAD fraction -> "12.34%". */
export function formatWeight(weightWad: bigint, fractionDigits = 2): string {
  return `${formatFixed(weightWad * 100n, 18, fractionDigits)}%`
}

/** Signed WAD deviation -> "+12.34 pp" / "-3.00 pp" (percentage points). */
export function formatDeviation(deviationWad: bigint, fractionDigits = 2): string {
  const text = formatFixed(deviationWad * 100n, 18, fractionDigits)
  return `${deviationWad > 0n ? '+' : ''}${text} pp`
}

/** Basis points -> "50%" / "0.5%". */
export function formatBps(bps: number): string {
  return `${formatFixed(BigInt(bps), 2, bps % 100 === 0 ? 0 : 2)}%`
}

/** Raw token amount -> human units. */
export function formatAmount(amount: bigint, decimals: number, fractionDigits = 4): string {
  return formatFixed(amount, decimals, Math.min(fractionDigits, decimals))
}

/** Parses a decimal string into a fixed-point bigint (exact; rejects excess precision). */
export function parseFixed(text: string, decimals: number): bigint {
  const match = /^(-)?(\d+)(?:\.(\d+))?$/.exec(text.trim())
  if (!match) throw new SyntaxError(`invalid decimal "${text}"`)
  const [, sign, whole = '0', fraction = ''] = match
  if (fraction.length > decimals) throw new RangeError(`"${text}" exceeds ${decimals} decimals`)
  const value = BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0') || '0')
  return sign ? -value : value
}

/** USD decimal string -> WAD. */
export function usd(text: string): bigint {
  return parseFixed(text, 18)
}

export const ONE_USD = WAD
