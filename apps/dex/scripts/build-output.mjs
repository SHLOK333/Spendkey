// Assembles the Vercel Build Output API v3 tree at repo-root `.vercel/output/`, so Vercel serves a finished
// SPA + serverless function without re-bundling anything (bypasses the @vercel/node esbuild pass that targeted
// pre-ES2020 and failed on BigInt). Runs from the repo root (see root vercel.json buildCommand).
import { build } from 'esbuild'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'

const OUT = '.vercel/output'
const FUNC = `${OUT}/functions/api.func`

rmSync(OUT, { recursive: true, force: true })
mkdirSync(`${OUT}/static`, { recursive: true })
mkdirSync(FUNC, { recursive: true })

// 1) Static SPA — the Vite build output.
cpSync('apps/dex/dist', `${OUT}/static`, { recursive: true })

// 2) The serverless function, fully bundled at a modern target (BigInt is native ≥ node22 / ES2020).
await build({
  entryPoints: ['apps/dex/server/vercel-output-entry.ts'],
  outfile: `${FUNC}/index.mjs`,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // Some transitive deps are CommonJS and call `require`; provide it in the ESM output.
  banner: { js: "import { createRequire as ___createRequire } from 'module'; const require = ___createRequire(import.meta.url);" },
  logLevel: 'info',
})

// 3) Function config — Node launcher, raw (req, res) handler.
writeFileSync(
  `${FUNC}/.vc-config.json`,
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false }, null, 2),
)

// 4) Routing: static files first, then /api/* and the A2A well-known path to the function, then SPA fallback.
writeFileSync(
  `${OUT}/config.json`,
  JSON.stringify(
    {
      version: 3,
      routes: [
        { handle: 'filesystem' },
        { src: '/api/(.*)', dest: '/api' },
        { src: '^/\\.well-known/agent-card\\.json$', dest: '/api' },
        { src: '/(.*)', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
)

console.log('[BUCKET] .vercel/output ready (Build Output API v3)')
