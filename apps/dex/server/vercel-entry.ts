// esbuild entry for the Vercel serverless function. Bundled to the repo-root `api/[[...route]].js` (plain JS)
// so Vercel's function builder never type-checks our Bundler-resolution/extensionless TypeScript. All `/api/*`
// (and the /.well-known rewrite) route here; the SPA is served statically by Vercel from `apps/dex/dist`.
import { handle } from 'hono/vercel'

import { app } from './index'

export const config = { runtime: 'nodejs' }

export default handle(app)
