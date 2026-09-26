
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { parseDeployment, type Deployment } from '@bucket/protocol-types'

/** The deployment manifest written by the deploy/configure/demo scripts — the single source of addresses. */
export function loadDeployment(): Deployment {
  return parseDeployment(JSON.parse(readFileSync(path.join(process.cwd(), '..', '..', 'deployments', 'sepolia.json'), 'utf8')))
}
