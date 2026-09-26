import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { parseDeployment, type Deployment } from '@bucket/protocol-types'

import { env, ROOT } from './env'

export function manifestPath(): string {
  return join(ROOT, 'deployments', `${env.EVM_NETWORK}.json`)
}

/** Web app copy of the manifest (served statically). */
function webManifestPath(): string {
  return join(ROOT, 'apps', 'web', 'public', 'deployment.json')
}

export function readManifest(): Deployment {
  const path = manifestPath()
  if (!existsSync(path)) throw new Error(`no deployment manifest at ${path}; run \`pnpm deploy:evm\` first`)
  return parseDeployment(JSON.parse(readFileSync(path, 'utf8')))
}

export function tryReadManifest(): Deployment | null {
  return existsSync(manifestPath()) ? readManifest() : null
}

export function writeManifest(deployment: Deployment): void {
  const validated = parseDeployment(deployment)
  const json = `${JSON.stringify(validated, null, 2)}\n`
  for (const path of [manifestPath(), webManifestPath()]) {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, json)
  }
  console.log(`manifest written: ${manifestPath()} (+ apps/web/public/deployment.json)`)
}
