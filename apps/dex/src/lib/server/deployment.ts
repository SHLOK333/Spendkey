import { parseDeployment, type Deployment } from '@bucket/protocol-types'

// Bundled at build time (works both on a Node server and in a serverless function, where the repo's
// files are not on disk). The manifest is written by the deploy/configure/demo scripts.
import deploymentJson from '../../../../../deployments/sepolia.json'

/** The deployment manifest — the single source of contract addresses. */
export function loadDeployment(): Deployment {
  return parseDeployment(deploymentJson)
}
