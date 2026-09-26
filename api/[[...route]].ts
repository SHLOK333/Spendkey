// Root monorepo bridge for Vercel. The implementation remains owned by apps/dex.
export { default } from '../apps/dex/api/[[...route]]'
export const config = { runtime: 'nodejs' }
