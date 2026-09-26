/** Publishes the configured reference prices (see lib/prices.ts). */
import { readManifest } from '../lib/manifest'
import { publishPrices } from '../lib/prices'

publishPrices(readManifest()).catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
