import { parseDeployment, type Deployment } from '@bucket/protocol-types'

export interface AppConfig {
  readonly deployment: Deployment
  readonly evmRpcUrl: string
  readonly suiGrpcUrl: string | null
}

const LOCAL_FORK_RPC = 'http://127.0.0.1:8545'

function defaultSuiGrpc(network: 'testnet' | 'devnet' | 'localnet'): string {
  if (network === 'localnet') return 'http://127.0.0.1:9000'
  return `https://fullnode.${network}.sui.io:443`
}

/** Loads the deployment manifest written by the deploy scripts (apps/web/public/deployment.json). */
export async function loadConfig(): Promise<AppConfig> {
  const response = await fetch('/deployment.json', { cache: 'no-store' })
  if (!response.ok) {
    throw new Error('deployment.json not found. Run `pnpm deploy:evm` (and the configure scripts) first.')
  }
  const deployment = parseDeployment(await response.json())
  const configuredRpc = import.meta.env.VITE_EVM_RPC_URL as string | undefined
  const evmRpcUrl = configuredRpc ?? (deployment.evm.network === 'sepolia-fork' ? LOCAL_FORK_RPC : null)
  if (!evmRpcUrl) {
    throw new Error('VITE_EVM_RPC_URL is not set. Add a Sepolia RPC endpoint to apps/web/.env (see .env.example).')
  }
  const configuredSui = import.meta.env.VITE_SUI_GRPC_URL as string | undefined
  const suiGrpcUrl = deployment.sui ? (configuredSui ?? defaultSuiGrpc(deployment.sui.network)) : null
  return { deployment, evmRpcUrl, suiGrpcUrl }
}
