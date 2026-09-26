// Entry for the Vercel Build Output API function. Bundled by scripts/build-output.mjs into
// .vercel/output/functions/api.func/index.mjs (target node22, so BigInt-heavy viem/bucket-math compiles),
// and served by Vercel AS-IS — Vercel never re-bundles a Build Output function, which is what avoids the
// @vercel/node esbuild pass that was targeting pre-ES2020 and choking on BigInt.
//
// getRequestListener adapts the Hono app to a Node (req, res) handler, which is exactly what Vercel's
// Node launcher (launcherType: "Nodejs", shouldAddHelpers: false) invokes.
import { getRequestListener } from '@hono/node-server'

import { app } from './index'

export default getRequestListener(app.fetch)
