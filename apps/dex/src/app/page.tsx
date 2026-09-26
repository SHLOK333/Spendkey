import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { DoodleAgent, DoodleShield, DoodleWallet } from '@/components/ui/doodles'

export default function Landing() {
  return (
    <div className="py-12 md:py-16">
      {/* Hero with full-bleed background video */}
      <section className="relative overflow-hidden rounded-3xl border border-line">
        {/* Background video */}
        <video
          className="absolute inset-0 h-full w-full object-cover"
          src="/intro.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          aria-hidden
        />
        {/* Light readability scrim — only darkens top & bottom edges so the video stays vivid */}
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-black/35 via-transparent to-black/45" />

        {/* Content on top of the video */}
        <div className="relative z-10 mx-auto flex min-h-[68vh] max-w-3xl flex-col items-center justify-center px-6 py-20 text-center">
          <span className="inline-flex items-center gap-2 rounded-full border border-white/15 bg-black/30 px-3 py-1 text-xs font-medium text-white/80 backdrop-blur-sm">
            <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Self-custodial · 1inch Aqua + SwapVM · ENSv2
          </span>
          <h1 className="mt-6 text-4xl font-bold leading-[1.05] tracking-tight text-white drop-shadow-[0_2px_20px_rgba(0,0,0,0.6)] md:text-6xl">
            Trade, pay and automate.
            <br />
            <span className="text-white/70">Without giving up custody.</span>
          </h1>
          <p className="mx-auto mt-6 max-w-xl text-lg text-white/80 drop-shadow-[0_1px_12px_rgba(0,0,0,0.6)]">
            BUCKET lets you delegate financial execution without handing over your assets.
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
            <Button asChild variant="primary" size="lg">
              <Link to="/trade">
                Trade on a ready Bucket <ArrowRight className="h-4 w-4" />
              </Link>
            </Button>
            <Button asChild variant="outline" size="lg">
              <Link to="/onboard">Create your own</Link>
            </Button>
          </div>
          <p className="mt-3 text-xs text-white/60">Jump into a ready-made Bucket instantly — or register your own .eth name, Bucket and agent from scratch. No registration wait on the ready one.</p>
        </div>
      </section>

      <div className="mx-auto mt-16 grid max-w-4xl gap-4 text-left md:grid-cols-3">
        {[
          { art: <DoodleWallet width={76} height={76} />, title: 'Your wallet owns the money.', body: 'Assets never move into BUCKET. Revoke your wallet approval and nothing can execute.' },
          { art: <DoodleAgent width={76} height={76} />, title: 'Your Bucket defines what an operator can do.', body: 'Which assets, how much per trade, how much per day, until when — and who.' },
          { art: <DoodleShield width={76} height={76} />, title: 'BUCKET enforces the limits.', body: 'On-chain, on every execution. An agent cannot talk its way past a limit.' },
        ].map((f) => (
          <div key={f.title} className="group rounded-2xl border border-line bg-panel p-5 transition-colors hover:border-line-2">
            <div className="text-muted transition-colors group-hover:text-fg">{f.art}</div>
            <div className="mt-4 text-sm font-semibold">{f.title}</div>
            <div className="mt-1.5 text-sm text-muted">{f.body}</div>
          </div>
        ))}
      </div>
    </div>
  )
}
