import { BucketClient, BucketEvm, EnsV2, ENSV2_SEPOLIA } from '@bucket/sdk'
import type { Deployment } from '@bucket/protocol-types'
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

import { env, evmRpcUrl } from './env'

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

export function bucketClient(deployment: Deployment): BucketClient {
  const client = publicClient()
  const evm = new BucketEvm(client, deployment.evm.contracts, BigInt(deployment.evm.startBlock))
  const ens = new EnsV2(client, { rootRegistry: deployment.evm.ens.rootRegistry, ethRegistry: deployment.evm.ens.ethRegistry })
  return new BucketClient(evm, ens, deployment.evm.chainId)
}

export { ENSV2_SEPOLIA }
