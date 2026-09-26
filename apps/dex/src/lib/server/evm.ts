
import { BucketClient, BucketEvm, EnsV2, type EvmWallet } from '@bucket/sdk'
import { createPublicClient, createWalletClient, type Hex, type PublicClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { loadDeployment } from './deployment'
import { serverEnv } from './env'
import { sepoliaTransport } from './rpc'

let cached: { publicClient: PublicClient; bucket: BucketClient } | null = null

export function evmServer() {
  if (cached) return cached
  const deployment = loadDeployment()
  const publicClient = createPublicClient({ chain: sepolia, transport: sepoliaTransport() }) as PublicClient
  const evm = new BucketEvm(publicClient, deployment.evm.contracts, BigInt(deployment.evm.startBlock))
  const ens = new EnsV2(publicClient, { rootRegistry: deployment.evm.ens.rootRegistry, ethRegistry: deployment.evm.ens.ethRegistry })
  cached = { publicClient, bucket: new BucketClient(evm, ens, deployment.evm.chainId) }
  return cached
}

/** The EVM agent's own operator wallet. Its authority is whatever capability names it — nothing more. */
export function evmAgentWallet(): EvmWallet | null {
  const key = serverEnv.evmAgentKey()
  if (!key) return null
  return createWalletClient({
    account: privateKeyToAccount(key as Hex),
    chain: sepolia,
    transport: sepoliaTransport(),
  }) as EvmWallet
}
