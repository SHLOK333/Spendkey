/**
 * Transfers the `agent.trading.shlok.eth` ENS subname NFT to the new operator address.
 * Run this when OPERATOR_PRIVATE_KEY was regenerated and the ENS subname still points to the old address.
 */
import { privateKeyToAccount } from 'viem/accounts'
import { labelId } from '@bucket/protocol-types'
import { publicClient, walletClient } from './lib/clients'
import { env, required } from './lib/env'
import { info } from './lib/log'
import { readManifest } from './lib/manifest'
import { userRegistryAbi } from '@bucket/sdk'

async function main() {
  const deployment = readManifest()
  const bucketRegistry = deployment.evm.ens.bucketRegistry
  if (!bucketRegistry) throw new Error('bucketRegistry not in manifest — run configure:ens first')

  const ownerKey = required('OWNER_PRIVATE_KEY')
  const operatorKey = required('OPERATOR_PRIVATE_KEY')
  const owner = walletClient(ownerKey)
  const newOperatorAddress = privateKeyToAccount(operatorKey).address
  const client = publicClient()

  const tokenId = labelId('agent')
  const currentHolder = await client.readContract({ address: bucketRegistry, abi: userRegistryAbi, functionName: 'getOwner', args: [tokenId] })
  info('current agent.trading.shlok.eth holder', currentHolder)
  info('new operator', newOperatorAddress)

  if (currentHolder.toLowerCase() === newOperatorAddress.toLowerCase()) {
    info('no update needed', 'already points to new operator')
    return
  }

  const expiry = await client.readContract({ address: bucketRegistry, abi: userRegistryAbi, functionName: 'getExpiry', args: [tokenId] })

  // Re-register: ENSv2 root account can overwrite an existing subname registration
  const hash = await owner.writeContract({
    address: bucketRegistry,
    abi: userRegistryAbi,
    functionName: 'register',
    args: ['agent', newOperatorAddress, '0x0000000000000000000000000000000000000000', '0x0000000000000000000000000000000000000000', 0n, expiry],
  })
  await client.waitForTransactionReceipt({ hash })
  info('re-registered', `agent.trading.shlok.eth -> ${newOperatorAddress} (${hash})`)

  // Verify
  const updatedHolder = await client.readContract({ address: bucketRegistry, abi: userRegistryAbi, functionName: 'getOwner', args: [tokenId] })
  info('verified holder', updatedHolder)
}

main().catch(e => { console.error(e.message ?? e); process.exit(1) })
