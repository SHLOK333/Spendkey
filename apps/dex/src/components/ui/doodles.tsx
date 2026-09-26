import type { SVGProps } from 'react'

/**
 * Original hand-drawn line-art doodles (authored here, not downloaded).
 * A loose, sketchy stroke style — accent-colored highlights over currentColor lines —
 * meant to sit in empty states, hero panels and section headers.
 */

type DoodleProps = SVGProps<SVGSVGElement> & { accent?: string }

const base = {
  fill: 'none',
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  strokeWidth: 2,
}

/** Wallet with a coin dropping in — "your wallet keeps the money". */
export function DoodleWallet({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <path d="M22 44c0-5 3-8 8-8h54c5 0 8 3 8 8v42c0 5-3 8-8 8H30c-5 0-8-3-8-8z" opacity="0.9" />
      <path d="M22 52h60c4 0 6 2 6 6v10c0 4-2 6-6 6H70c-6 0-10-4-10-9s4-9 10-9h18" opacity="0.55" />
      <circle cx="70" cy="65" r="3" fill={accent} stroke="none" />
      <g stroke={accent}>
        <circle cx="74" cy="26" r="11" />
        <path d="M74 21v10M70 26h8" />
      </g>
      <path d="M30 100c8 4 46 4 54 0" opacity="0.35" strokeDasharray="1 6" />
    </svg>
  )
}

/** A vault / safe — "assets stay locked under your key". */
export function DoodleVault({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <rect x="20" y="26" width="80" height="68" rx="10" opacity="0.9" />
      <rect x="30" y="36" width="46" height="48" rx="6" opacity="0.5" />
      <g stroke={accent}>
        <circle cx="53" cy="60" r="13" />
        <path d="M53 60v-9M53 60l7 5" />
      </g>
      <path d="M84 44v32" opacity="0.5" />
      <path d="M30 94v8M90 94v8" opacity="0.7" />
      <circle cx="53" cy="60" r="2.5" fill={accent} stroke="none" />
    </svg>
  )
}

/** Two coins swapping — the swap/trade motif. */
export function DoodleSwap({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <circle cx="42" cy="46" r="20" opacity="0.9" />
      <path d="M42 38v16M36 43h12" opacity="0.6" />
      <circle cx="78" cy="74" r="20" stroke={accent} />
      <path d="M78 66v16M72 71h12" stroke={accent} opacity="0.8" />
      <path d="M30 78c-4-10 0-22 10-27" stroke={accent} />
      <path d="M38 74l-8 6 10 3" stroke={accent} />
      <path d="M90 42c4 10 0 22-10 27" opacity="0.6" />
      <path d="M82 46l8-6-10-3" opacity="0.6" />
    </svg>
  )
}

/** Friendly robot — the agent motif. */
export function DoodleAgent({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <rect x="30" y="42" width="60" height="46" rx="12" opacity="0.9" />
      <path d="M60 42V28M60 24a4 4 0 100-.1" stroke={accent} />
      <circle cx="60" cy="22" r="4" fill={accent} stroke="none" />
      <circle cx="48" cy="62" r="5" stroke={accent} />
      <circle cx="72" cy="62" r="5" stroke={accent} />
      <path d="M50 76c6 4 14 4 20 0" opacity="0.7" />
      <path d="M30 60h-8M90 60h8" opacity="0.6" />
      <path d="M42 88v8M78 88v8" opacity="0.6" />
    </svg>
  )
}

/** Shield with a check — on-chain enforcement. */
export function DoodleShield({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <path d="M60 22l30 12v22c0 24-18 38-30 44-12-6-30-20-30-44V34z" opacity="0.9" />
      <path d="M46 60l10 10 20-22" stroke={accent} />
      <path d="M60 22v90" opacity="0.15" />
    </svg>
  )
}

/** Empty box with a little sparkle — for empty states. */
export function DoodleEmpty({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <path d="M28 52l32-16 32 16-32 16z" opacity="0.9" />
      <path d="M28 52v28l32 16V68M92 52v28L60 96" opacity="0.6" />
      <g stroke={accent}>
        <path d="M84 30v10M79 35h10" />
        <path d="M40 26v6M37 29h6" opacity="0.8" />
      </g>
    </svg>
  )
}

/** Paper plane trailing a coin — the payment / "send" motif. */
export function DoodleSend({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <path d="M26 40l68-14-22 66-16-24z" opacity="0.9" />
      <path d="M94 26L56 68" opacity="0.6" />
      <path d="M56 68v22l14-16" opacity="0.5" />
      <g stroke={accent}>
        <circle cx="34" cy="80" r="10" />
        <path d="M34 75v10M30 80h8" />
      </g>
      <path d="M20 96c10-2 20-2 30 2" opacity="0.3" strokeDasharray="1 6" />
    </svg>
  )
}

/** A receipt with a pulse line — the activity / ledger motif. */
export function DoodlePulse({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 120 120" width="120" height="120" stroke="currentColor" {...base} {...props}>
      <path d="M34 22h44c4 0 6 2 6 6v66l-8-6-8 6-8-6-8 6-8-6-8 6V28c0-4 2-6 6-6z" opacity="0.9" />
      <g stroke={accent}>
        <path d="M40 52h10l6-12 8 24 6-12h14" />
      </g>
      <path d="M40 70h40M40 80h26" opacity="0.5" />
    </svg>
  )
}

/** A small decorative sparkle cluster to sprinkle into corners. */
export function DoodleSparkle({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 48 48" width="48" height="48" stroke={accent} {...base} {...props}>
      <path d="M24 8c0 8 4 12 12 12-8 0-12 4-12 12 0-8-4-12-12-12 8 0 12-4 12-12z" opacity="0.9" />
      <path d="M38 30v6M35 33h6" opacity="0.7" />
    </svg>
  )
}

/** Faint blueprint-style squiggle band for hero backgrounds. */
export function DoodleWave({ accent = 'var(--color-accent)', ...props }: DoodleProps) {
  return (
    <svg viewBox="0 0 400 80" width="400" height="80" stroke={accent} {...base} strokeWidth={1.5} {...props}>
      <path d="M0 40c30-30 60 30 90 0s60-30 90 0 60 30 90 0 60-30 90 0" opacity="0.4" />
      <path d="M0 58c30-30 60 30 90 0s60-30 90 0 60 30 90 0 60-30 90 0" opacity="0.18" />
    </svg>
  )
}
