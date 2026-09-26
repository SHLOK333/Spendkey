/**
 * Publishes the `bucket` Move package to Sui and records the package ID in the manifest.
 * Requires SUI_PRIVATE_KEY (a funded `suiprivkey…` ed25519 key) and the Sui CLI (SUI_BIN or `sui` on PATH) for
 * compiling the package to bytecode.
 */
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

import { Transaction } from '@mysten/sui/transactions'
import { z } from 'zod'

import { suiClient, suiExecutor, suiKeypair } from '../lib/clients'
import { env, required, ROOT } from '../lib/env'
import { info, step } from '../lib/log'
import { readManifest, writeManifest } from '../lib/manifest'

const BuildOutput = z.object({
  modules: z.array(z.string()),
  dependencies: z.array(z.string()),
})

function suiBin(): string {
  return env.SUI_BIN ?? 'sui'
}

async function main(): Promise<void> {
  const deployment = readManifest()
  const keypair = suiKeypair(required('SUI_PRIVATE_KEY'))
  const client = suiClient()

  // Localnet's chain ID changes on every regenesis, so it cannot be a named Move build environment; it runs the
  // framework bundled with the same CLI release, which is the one resolved for `testnet`.
  const buildEnv = env.SUI_NETWORK === 'localnet' ? 'testnet' : env.SUI_NETWORK
  step(`Compiling contracts/sui for ${env.SUI_NETWORK} (build env ${buildEnv})`)
  const build = spawnSync(
    suiBin(),
    ['move', 'build', '--dump-bytecode-as-base64', '--build-env', buildEnv, '--path', join(ROOT, 'contracts', 'sui')],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32', input: '' },
  )
  if (build.status !== 0) throw new Error(`sui move build failed:\n${build.stderr}`)
  const jsonLine = build.stdout.split('\n').find((line) => line.trim().startsWith('{'))
  if (!jsonLine) throw new Error(`unexpected sui build output:\n${build.stdout}`)
  const { modules, dependencies } = BuildOutput.parse(JSON.parse(jsonLine))

  step('Publishing package')
  const tx = new Transaction()
  const upgradeCap = tx.publish({ modules, dependencies })
  tx.transferObjects([upgradeCap], keypair.toSuiAddress())

  const execute = suiExecutor(client, keypair)
  const result = await execute(tx)
  const { Transaction: executed } = await client.getTransaction({
    digest: result.digest,
    include: { effects: true },
  })
  if (!executed) throw new Error('publish transaction not found')
  const published = executed.effects.changedObjects.find((change) => change.outputState === 'PackageWrite')
  if (!published) throw new Error('no package in publish effects')

  deployment.sui = {
    network: env.SUI_NETWORK,
    packageId: published.objectId,
    explorer: env.SUI_NETWORK === 'localnet' ? null : `https://suiscan.xyz/${env.SUI_NETWORK}`,
  }
  writeManifest(deployment)
  info('package', published.objectId)
  info('digest', result.digest)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
