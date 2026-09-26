import { BucketClient, BucketEvm, EnsV2 } from '@bucket/sdk'
import { createPublicClient, http, type PublicClient } from 'viem'
import { sepolia } from 'viem/chains'

import type { AppConfig } from './config'

export interface Clients {
  readonly publicClient: PublicClient
  /** The EVM Bucket stack: ENSv2 identity, `BucketCapabilities`, `BucketController` + Aqua/SwapVM execution. */
  readonly bucket: BucketClient
}

export function createClients(config: AppConfig): Clients {
  const { deployment } = config
  const publicClient = createPublicClient({ chain: sepolia, transport: http(config.evmRpcUrl) }) as PublicClient
  const evm = new BucketEvm(publicClient, deployment.evm.contracts, BigInt(deployment.evm.startBlock))
  const ens = new EnsV2(publicClient, {
    rootRegistry: deployment.evm.ens.rootRegistry,
    ethRegistry: deployment.evm.ens.ethRegistry,
  })
  return { publicClient, bucket: new BucketClient(evm, ens, deployment.evm.chainId) }
}
