import { BucketClient, BucketEvm, BucketSui, EnsV2, SuiBucketClient, type SuiExecutor } from '@bucket/sdk'
import type { DAppKit } from '@mysten/dapp-kit-react'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import type { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { createPublicClient, http, type PublicClient } from 'viem'
import { sepolia } from 'viem/chains'

import type { AppConfig } from './config'

export interface Clients {
  readonly publicClient: PublicClient
  readonly suiClient: SuiGrpcClient | null
  /** The EVM Bucket stack: ENSv2 identity, `BucketCapabilities`, `BucketController` + Aqua/SwapVM execution. */
  readonly bucket: BucketClient
  /** Read-only access to Sui-native Buckets; does not need a connected wallet. */
  readonly suiReader: BucketSui | null
  /** The Sui-native stack's write path, independent of the EVM one — `null` until a Sui wallet is connected (it
   *  builds the transaction executor from the connected wallet; see `walletSuiExecutor`). */
  suiBucket: SuiBucketClient | null
}

export function createClients(config: AppConfig): Clients {
  const { deployment } = config
  const publicClient = createPublicClient({ chain: sepolia, transport: http(config.evmRpcUrl) }) as PublicClient
  const suiClient =
    deployment.sui && config.suiGrpcUrl
      ? new SuiGrpcClient({ network: deployment.sui.network, baseUrl: config.suiGrpcUrl })
      : null
  const evm = new BucketEvm(publicClient, deployment.evm.contracts, BigInt(deployment.evm.startBlock))
  const ens = new EnsV2(publicClient, {
    rootRegistry: deployment.evm.ens.rootRegistry,
    ethRegistry: deployment.evm.ens.ethRegistry,
  })
  const suiReader = deployment.sui && suiClient ? new BucketSui(suiClient, deployment.sui.packageId) : null
  return { publicClient, suiClient, bucket: new BucketClient(evm, ens, deployment.evm.chainId), suiReader, suiBucket: null }
}

/** Adapts the connected Sui wallet (dApp Kit) to the SDK executor interface. */
export function walletSuiExecutor(dAppKit: DAppKit<any>, client: SuiGrpcClient): SuiExecutor {
  return async (tx: Transaction) => {
    const signed = await dAppKit.signAndExecuteTransaction({ transaction: tx })
    const executed = signed.$kind === 'Transaction' ? signed.Transaction : signed.FailedTransaction
    if (signed.$kind !== 'Transaction' || !executed.status.success) {
      throw new Error(`Sui transaction ${executed.digest} failed`)
    }
    const settled = await client.waitForTransaction({
      digest: executed.digest,
      include: { effects: true, objectTypes: true },
    })
    const tx$ = settled.$kind === 'Transaction' ? settled.Transaction : settled.FailedTransaction
    return {
      digest: executed.digest,
      created: (suffix) =>
        tx$.effects.changedObjects
          .filter((c) => c.idOperation === 'Created' && tx$.objectTypes[c.objectId]?.endsWith(suffix))
          .map((c) => normalizeSuiAddress(c.objectId)),
    }
  }
}

export function createSuiBucketClient(deployment: AppConfig['deployment'], suiClient: SuiGrpcClient | null, executor: SuiExecutor): SuiBucketClient | null {
  if (!deployment.sui || !suiClient) return null
  return new SuiBucketClient(new BucketSui(suiClient, deployment.sui.packageId), executor)
}
