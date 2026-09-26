import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'

import { Button } from '@/components/ui/button'
import { DoodleAgent, DoodleShield, DoodleSparkle, DoodleWallet, DoodleWave } from '@/components/ui/doodles'

export default function Landing() {
  return (
    <div className="relative py-12 md:py-20">
      {/* Decorative doodles */}
      <DoodleSparkle className="absolute right-10 top-6 hidden text-accent md:block" width={40} height={40} />
      <DoodleSparkle className="absolute left-4 top-40 hidden opacity-60 md:block" width={28} height={28} />
      <DoodleWave className="pointer-events-none absolute left-1/2 top-[280px] -z-10 hidden -translate-x-1/2 md:block" width={520} height={100} />

      {/* Intro video — what BUCKET is */}
      <div className="mx-auto mb-12 max-w-3xl">
        <div className="overflow-hidden rounded-3xl border border-line bg-panel shadow-[0_20px_60px_-24px_rgba(0,0,0,0.7)]">
          <video
            className="aspect-video w-full object-cover"
            src="/intro.mp4"
            autoPlay
            muted
            loop
            playsInline
            controls
            preload="metadata"
          />
        </div>
      </div>

      <div className="mx-auto max-w-3xl text-center">
        <span className="inline-flex items-center gap-2 rounded-full border border-line bg-panel-2 px-3 py-1 text-xs font-medium text-muted">
          <span className="h-1.5 w-1.5 rounded-full bg-accent" /> Self-custodial · 1inch Aqua + SwapVM · ENSv2
        </span>
        <h1 className="mt-6 text-4xl font-bold leading-[1.05] tracking-tight md:text-6xl">
          Trade, pay and automate.
          <br />
          <span className="text-muted">Without giving up custody.</span>
        </h1>
        <p className="mx-auto mt-6 max-w-xl text-lg text-muted">
          BUCKET lets you delegate financial execution without handing over your assets.
        </p>
        <div className="mt-10 flex items-center justify-center gap-3">
          <Button asChild variant="primary" size="lg">
            <Link to="/trade">
              Trade on a ready Bucket <ArrowRight className="h-4 w-4" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="lg">
            <Link to="/onboard">Create your own</Link>
          </Button>
        </div>
        <p className="mt-3 text-xs text-faint">Jump into a ready-made Bucket instantly — or register your own .eth name, Bucket and agent from scratch. No registration wait on the ready one.</p>
      </div>

      <div className="mx-auto mt-20 grid max-w-4xl gap-4 text-left md:grid-cols-3">
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
