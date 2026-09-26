// Vercel serverless entry: serves the Hono app (all `/api/*` routes) as a Node function. The SPA itself is
// served statically by Vercel from `dist/`; this handles the API. See `vercel.json` for the routing.
import { handle } from 'hono/vercel'

import { app } from '../server/index'

export const config = { runtime: 'nodejs' }

export default handle(app)
