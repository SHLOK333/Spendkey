/**
 * Deploys the BUCKET EVM execution layer with Foundry and writes the deployment manifest.
 *
 *   EVM_NETWORK=sepolia        broadcasts to Sepolia (SEPOLIA_RPC_URL, DEPLOYER_PRIVATE_KEY)
 *   EVM_NETWORK=sepolia-fork   broadcasts to a local anvil fork of Sepolia (LOCAL_FORK_RPC_URL)
 *
 * ENSv2 is not deployed: the official Sepolia ENSv2 deployment is used as-is.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { ENSV2_SEPOLIA } from '@bucket/sdk'
import type { Deployment } from '@bucket/protocol-types'
import { getAddress, type Address } from 'viem'
import { z } from 'zod'

import { publicClient } from '../lib/clients'
import { env, evmRpcUrl, required, ROOT } from '../lib/env'
import { info, step } from '../lib/log'
import { tryReadManifest, writeManifest } from '../lib/manifest'

const EVM_DIR = join(ROOT, 'contracts', 'evm')

const ForgeOutput = z.object({
  chainId: z.number(),
  aqua: z.string(),
  router: z.string(),
  priceFeed: z.string(),
  authority: z.string(),
  capabilities: z.string(),
  controller: z.string(),
  tUSDC: z.string(),
  tETH: z.string(),
  tSUI: z.string(),
  tPEPE: z.string(),
})

async function main(): Promise<void> {
  const client = publicClient()
  const chainId = await client.getChainId()
  if (chainId !== ENSV2_SEPOLIA.chainId) {
    throw new Error(`RPC is chain ${chainId}; BUCKET targets Sepolia (${ENSV2_SEPOLIA.chainId}) where ENSv2 is deployed`)
  }
  const startBlock = Number(await client.getBlockNumber())

  step(`Deploying EVM layer to ${env.EVM_NETWORK}`)
  const result = spawnSync(
    'forge',
    [
      'script',
      'script/Deploy.s.sol:Deploy',
      '--rpc-url',
      evmRpcUrl(),
      '--private-key',
      required('DEPLOYER_PRIVATE_KEY'),
      '--broadcast',
      '--slow',
    ],
    { cwd: EVM_DIR, stdio: 'inherit', env: process.env, shell: process.platform === 'win32' },
  )
  if (result.status !== 0) throw new Error(`forge script failed with status ${result.status}`)

  const out = ForgeOutput.parse(JSON.parse(readFileSync(join(EVM_DIR, 'deployments', `evm-${chainId}.json`), 'utf8')))
  const addr = (value: string): Address => getAddress(value)
  const previous = tryReadManifest()

  const deployment: Deployment = {
    evm: {
      network: env.EVM_NETWORK,
      chainId,
      explorer: env.EVM_NETWORK === 'sepolia' ? 'https://sepolia.etherscan.io' : null,
      deployedAt: new Date().toISOString(),
      startBlock,
      contracts: {
        aqua: addr(out.aqua),
        router: addr(out.router),
        authority: addr(out.authority),
        capabilities: addr(out.capabilities),
        controller: addr(out.controller),
        priceFeed: addr(out.priceFeed),
      },
      ens: {
        rootRegistry: addr(ENSV2_SEPOLIA.rootRegistry),
        ethRegistry: addr(ENSV2_SEPOLIA.ethRegistry),
        ethRegistrar: addr(ENSV2_SEPOLIA.ethRegistrar),
        userRegistryImpl: addr(ENSV2_SEPOLIA.userRegistryImpl),
        verifiableFactory: addr(ENSV2_SEPOLIA.verifiableFactory),
        ownerRegistry: previous?.evm.ens.ownerRegistry ?? null,
        bucketRegistry: previous?.evm.ens.bucketRegistry ?? null,
      },
      tokens: [
        { symbol: 'USDC', address: addr(out.tUSDC), decimals: 6, suiType: '' },
        { symbol: 'ETH', address: addr(out.tETH), decimals: 18, suiType: '' },
        { symbol: 'SUI', address: addr(out.tSUI), decimals: 9, suiType: '0x2::sui::SUI' },
        // Deliberately never part of a Bucket policy (unapproved-asset rejection scenarios).
        { symbol: 'PEPE', address: addr(out.tPEPE), decimals: 18, suiType: '' },
      ],
    },
    sui: previous?.sui ?? null,
    ens: previous?.ens ?? null,
    buckets: previous?.buckets ?? [],
    suiBuckets: previous?.suiBuckets ?? [],
  }
  writeManifest(deployment)

  for (const [name, value] of Object.entries(deployment.evm.contracts)) info(name, value)
  for (const token of deployment.evm.tokens) info(`t${token.symbol}`, token.address)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
