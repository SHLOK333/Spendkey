import { BucketClient, BucketEvm, BucketSui, EnsV2, ENSV2_SEPOLIA, SuiBucketClient, type SuiExecutor } from '@bucket/sdk'
import type { Deployment } from '@bucket/protocol-types'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import type { Transaction } from '@mysten/sui/transactions'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  http,
  publicActions,
  type Account,
  type Chain,
  type PublicClient,
  type Transport,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { sepolia } from 'viem/chains'

import { env, evmRpcUrl, suiGrpcUrl } from './env'

export const chain: Chain = sepolia

export function publicClient(): PublicClient {
  return createPublicClient({ chain, transport: http(evmRpcUrl()) }) as PublicClient
}

export function walletClient(privateKey: `0x${string}`): WalletClient<Transport, Chain, Account> {
  return createWalletClient({ chain, transport: http(evmRpcUrl()), account: privateKeyToAccount(privateKey) })
}

/** Anvil test actions, only on the explicitly configured local Sepolia fork. */
export function forkTestClient() {
  if (env.EVM_NETWORK !== 'sepolia-fork') return null
  return createTestClient({ chain, mode: 'anvil', transport: http(evmRpcUrl()) }).extend(publicActions)
}

export function suiClient(): SuiGrpcClient {
  return new SuiGrpcClient({ network: env.SUI_NETWORK, baseUrl: suiGrpcUrl() })
}

export function suiKeypair(secret: string): Ed25519Keypair {
  const { scheme, secretKey } = decodeSuiPrivateKey(secret)
  if (scheme !== 'ED25519') throw new Error(`unsupported Sui key scheme ${scheme}; use an ed25519 key`)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

/** Keypair-backed executor: signs, executes, waits and exposes created objects by Bucket type. */
export function suiExecutor(client: SuiGrpcClient, keypair: Ed25519Keypair): SuiExecutor {
  return async (tx: Transaction) => {
    tx.setSenderIfNotSet(keypair.toSuiAddress())
    const result = await client.signAndExecuteTransaction({
      transaction: tx,
      signer: keypair,
      include: { effects: true, objectTypes: true },
    })
    const executed = result.$kind === 'Transaction' ? result.Transaction : result.FailedTransaction
    if (result.$kind !== 'Transaction' || !executed.status.success) {
      throw new Error(`Sui transaction ${executed.digest} failed: ${JSON.stringify(executed.status)}`)
    }
    await client.waitForTransaction({ digest: executed.digest })
    const changed = executed.effects.changedObjects
    const types = executed.objectTypes
    return {
      digest: executed.digest,
      created: (suffix) =>
        changed
          .filter((c) => c.idOperation === 'Created' && types[c.objectId]?.endsWith(suffix))
          .map((c) => normalizeSuiAddress(c.objectId)),
    }
  }
}

export function bucketClient(deployment: Deployment): BucketClient {
  const client = publicClient()
  const evm = new BucketEvm(client, deployment.evm.contracts, BigInt(deployment.evm.startBlock))
  const ens = new EnsV2(client, { rootRegistry: deployment.evm.ens.rootRegistry, ethRegistry: deployment.evm.ens.ethRegistry })
  return new BucketClient(evm, ens, deployment.evm.chainId)
}

/** The Sui-native stack is independent of the EVM one (see `sui-client.ts`); only construct this when needed. */
export function suiBucketClient(deployment: Deployment, executor: SuiExecutor): SuiBucketClient | null {
  if (!deployment.sui) return null
  const sui = new BucketSui(suiClient(), deployment.sui.packageId)
  return new SuiBucketClient(sui, executor)
}

export { ENSV2_SEPOLIA }
