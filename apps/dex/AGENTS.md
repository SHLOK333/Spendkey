# BUCKET DEX — architecture for agents

This app is a **plain React SPA built with Vite** (React Router, not Next.js). There is no App Router,
no `app/api/*` route handlers, no server components, and no `next` dependency. Do not reintroduce them.

## Topology

- **Client** (`src/`) — a pure browser SPA. Entry `index.html` → `src/main.tsx` → `BrowserRouter` →
  `src/providers.tsx` → `src/App.tsx` (route table). Pages live under `src/app/**/page.tsx`; shared UI
  under `src/components/`. The client holds **no secrets** — it only ever calls `/api/*`.
- **Server** (`server/index.ts`) — a standalone Hono API (`@hono/node-server`). Every secret (RPC key,
  agent operator keys, OpenAI key) lives here. Server-only libraries are under `src/lib/server/`.

## Secret boundary — do not break it

- RPC access goes through `POST /api/rpc` (allowlisted). The client's viem/wagmi transport is
  `http('/api/rpc')` — never a direct provider URL, never an embedded key.
- The OpenAI key is resolved server-side in `src/lib/server/ai-key.ts` (BYOK sealed cookie, else server
  env). It must never reach the client bundle.
- Only `VITE_*` env vars are exposed to the browser (see `vite.config.ts` `define`). Anything else stays
  server-side. Never move a server lib import into a `src/` client module.

## Dev & build

- `pnpm dev` — `concurrently` runs Vite on **:3100** (strictPort) and the Hono API on **:3101**; Vite
  proxies `/api` → `:3101`, so the browser talks to one origin.
- `pnpm build` — `vite build` → `dist/`. `pnpm start` — `NODE_ENV=production PORT=3100 tsx server/index.ts`
  serves `dist/` statically **and** the API on one port.
- `pnpm typecheck` — `tsc --noEmit`. The monorepo `tsconfig.base.json` sets `verbatimModuleSyntax`,
  `exactOptionalPropertyTypes`, `isolatedModules`, `noUncheckedIndexedAccess`, `moduleResolution: Bundler`.
  Use `import type` for type-only imports.

## Routing conventions

- Links use `react-router-dom` `<Link to=...>` (not `next/link` / `href`).
- Route params use `useSearchParams()` / `useLocation()` from `react-router-dom`.
- Lazy client-only widgets use React `lazy()` + `<Suspense>` (not `next/dynamic`).

## Security invariants (unchanged from the protocol)

- The permission system is enforced by on-chain EVM contracts. The frontend never enforces
  role membership, resource scope, grants/revocations, expiration, capability validity, financial limits,
  Bucket ownership, or guardian restrictions.
- Never hardcode, log, or commit private keys. The LLM never controls unrestricted wallet signing.
