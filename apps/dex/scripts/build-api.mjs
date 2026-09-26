// Bundles the Hono app + all its imports (workspace packages included) into a single plain-JS Vercel
// function at the REPO-ROOT `api/[[...route]].js`. Plain JS means Vercel's function builder does not
// type-check our Bundler-resolution TypeScript (extensionless imports it would otherwise reject under node16).
// Runs from the apps/dex working dir (via `pnpm --filter @bucket/dex build`), so it writes two levels up.
import { build } from 'esbuild'

await build({
  entryPoints: ['server/vercel-entry.ts'],
  outfile: '../../api/[[...route]].js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // Some transitive deps are CommonJS and call `require`; provide it in the ESM output.
  banner: { js: "import { createRequire as ___createRequire } from 'module'; const require = ___createRequire(import.meta.url);" },
  logLevel: 'info',
})

console.log('[BUCKET] Vercel API function bundled → api/[[...route]].js (repo root)')
