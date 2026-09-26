/**
 * Builds the ENSv2 identity hierarchy used by BUCKET on the official Sepolia ENSv2 deployment:
 *
 *   <owner>.eth                       registered through ETHRegistrar (commit/reveal, MockUSDC payment)
 *     └─ UserRegistry (owner)         owner-controlled subregistry, canonical parent = .eth registry
 *          ├─ trading.<owner>.eth     Bucket names (owned by the owner)
 *          ├─ savings.<owner>.eth
 *          └─ payments.<owner>.eth
 *               trading └─ UserRegistry (bucket)
 *                              └─ agent.trading.<owner>.eth   operator identity (owned by the operator key)
 *
 * The operator subname carries no ENSv2 token roles, so the Bucket owner (root roles on the bucket registry) can
 * revoke the operator identity at any time; BucketAuthority re-checks it on every authorization.
 * Idempotent: existing names and registries are reused.
 */
import { randomBytes } from 'node:crypto'

import {
  ENSV2_SEPOLIA,
  SUBNAME_OWNER_ROLES,
  USER_REGISTRY_OWNER_ROLES,
  ethRegistrarAbi,
  mintableErc20Abi,
  userRegistryAbi,
  verifiableFactoryAbi,
} from '@bucket/sdk'
import { labelId } from '@bucket/protocol-types'
import {
  bytesToHex,
  encodeFunctionData,
  isAddressEqual,
  keccak256,
  parseEventLogs,
  stringToBytes,
  zeroAddress,
  zeroHash,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import { forkTestClient, publicClient, walletClient } from '../lib/clients'
import { env, required } from '../lib/env'
import { info, sleep, step } from '../lib/log'
import { readManifest, writeManifest } from '../lib/manifest'

export const BUCKET_LABELS = ['trading', 'savings', 'payments'] as const
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n

const client = publicClient()
const owner = walletClient(required('OWNER_PRIVATE_KEY'))
const operatorAddress = privateKeyToAccount(required('OPERATOR_PRIVATE_KEY')).address

async function send(request: Parameters<typeof client.simulateContract>[0]): Promise<Hex> {
  const { request: simulated } = await client.simulateContract({ ...request, account: owner.account })
  const hash = await owner.writeContract(simulated as Parameters<typeof owner.writeContract>[0])
  const receipt = await client.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`transaction ${hash} reverted`)
  return hash
}

async function waitUntil(timestamp: bigint): Promise<void> {
  const test = forkTestClient()
  const block = await client.getBlock()
  if (block.timestamp >= timestamp) return
  if (test) {
    await test.increaseTime({ seconds: Number(timestamp - block.timestamp) + 1 })
    await test.mine({ blocks: 1 })
    return
  }
  for (;;) {
    const latest = await client.getBlock()
    if (latest.timestamp >= timestamp) return
    await sleep(Math.min(Number(timestamp - latest.timestamp) * 1000 + 2_000, 15_000))
  }
}

async function registerEthName(label: string): Promise<void> {
  const registrar = ENSV2_SEPOLIA.ethRegistrar
  const duration = BigInt(env.ENS_REGISTRATION_YEARS) * SECONDS_PER_YEAR
  const [base, premium] = await client.readContract({
    address: registrar,
    abi: ethRegistrarAbi,
    functionName: 'getRegisterPrice',
    args: [label, duration, ENSV2_SEPOLIA.mockUsdc],
  })
  const price = base + premium
  info('registration price', `${price} MockUSDC units`)

  await send({ address: ENSV2_SEPOLIA.mockUsdc, abi: mintableErc20Abi, functionName: 'mint', args: [owner.account.address, price] })
  await send({ address: ENSV2_SEPOLIA.mockUsdc, abi: mintableErc20Abi, functionName: 'approve', args: [registrar, price] })

  const secret = bytesToHex(randomBytes(32))
  const commitment = await client.readContract({
    address: registrar,
    abi: ethRegistrarAbi,
    functionName: 'makeCommitment',
    args: [label, owner.account.address, secret, zeroAddress, zeroAddress, duration, zeroHash],
  })
  await send({ address: registrar, abi: ethRegistrarAbi, functionName: 'commit', args: [commitment] })
  const [committedAt, minAge] = await Promise.all([
    client.readContract({ address: registrar, abi: ethRegistrarAbi, functionName: 'commitmentAt', args: [commitment] }),
    client.readContract({ address: registrar, abi: ethRegistrarAbi, functionName: 'MIN_COMMITMENT_AGE' }),
  ])
  info('commitment', `${commitment} (reveal after ${minAge}s)`)
  await waitUntil(committedAt + minAge + 1n)

  const hash = await send({
    address: registrar,
    abi: ethRegistrarAbi,
    functionName: 'register',
    args: [label, owner.account.address, secret, zeroAddress, zeroAddress, duration, ENSV2_SEPOLIA.mockUsdc, zeroHash],
  })
  info('registered', `${label}.eth (${hash})`)
}

async function deployUserRegistry(purpose: string): Promise<Address> {
  const salt = BigInt(keccak256(stringToBytes(`bucket:${owner.account.address}:${purpose}`)))
  const hash = await send({
    address: ENSV2_SEPOLIA.verifiableFactory,
    abi: verifiableFactoryAbi,
    functionName: 'deployProxy',
    args: [
      ENSV2_SEPOLIA.userRegistryImpl,
      salt,
      encodeFunctionData({
        abi: userRegistryAbi,
        functionName: 'initialize',
        args: [[{ account: owner.account.address, roleBitmap: USER_REGISTRY_OWNER_ROLES }]],
      }),
    ],
  })
  const receipt = await client.getTransactionReceipt({ hash })
  const [deployed] = parseEventLogs({ abi: verifiableFactoryAbi, eventName: 'ProxyDeployed', logs: receipt.logs })
  if (!deployed) throw new Error('ProxyDeployed event missing')
  info(`UserRegistry (${purpose})`, deployed.args.proxyAddress)
  return deployed.args.proxyAddress
}

/** Ensures `label` in `parent` has a UserRegistry subregistry whose canonical parent is set. */
async function ensureSubregistry(parent: Address, label: string, purpose: string): Promise<Address> {
  const existing = await client.readContract({ address: parent, abi: userRegistryAbi, functionName: 'getSubregistry', args: [label] })
  if (!isAddressEqual(existing, zeroAddress)) return existing
  const registry = await deployUserRegistry(purpose)
  await send({ address: parent, abi: userRegistryAbi, functionName: 'setSubregistry', args: [labelId(label), registry] })
  await send({ address: registry, abi: userRegistryAbi, functionName: 'setParent', args: [parent, label] })
  return registry
}

async function ensureSubname(registry: Address, label: string, holder: Address, roles: bigint, expiry: bigint) {
  const current = await client.readContract({ address: registry, abi: userRegistryAbi, functionName: 'getOwner', args: [labelId(label)] })
  if (isAddressEqual(current, holder)) return
  if (!isAddressEqual(current, zeroAddress)) throw new Error(`${label} is already owned by ${current}`)
  await send({
    address: registry,
    abi: userRegistryAbi,
    functionName: 'register',
    args: [label, holder, zeroAddress, zeroAddress, roles, expiry],
  })
}

async function main(): Promise<void> {
  const deployment = readManifest()
  const label = env.ENS_OWNER_LABEL
  const ethRegistry = ENSV2_SEPOLIA.ethRegistry

  step(`ENSv2: ${label}.eth`)
  const currentOwner = await client.readContract({ address: ethRegistry, abi: userRegistryAbi, functionName: 'getOwner', args: [labelId(label)] })
  if (isAddressEqual(currentOwner, zeroAddress)) {
    await registerEthName(label)
  } else if (!isAddressEqual(currentOwner, owner.account.address)) {
    throw new Error(`${label}.eth is owned by ${currentOwner}; set ENS_OWNER_LABEL to a name you own or that is available`)
  } else {
    info('owned', `${label}.eth by ${owner.account.address}`)
  }
  const expiry = await client.readContract({ address: ethRegistry, abi: userRegistryAbi, functionName: 'getExpiry', args: [labelId(label)] })

  step(`ENSv2: ${label}.eth subregistry`)
  const ownerRegistry = await ensureSubregistry(ethRegistry, label, `${label}.eth`)
  info('owner registry', ownerRegistry)

  step('ENSv2: Bucket names')
  for (const bucket of BUCKET_LABELS) {
    await ensureSubname(ownerRegistry, bucket, owner.account.address, SUBNAME_OWNER_ROLES, expiry)
    info(`${bucket}.${label}.eth`, owner.account.address)
  }

  // Every Bucket name gets its own subregistry holding the operator identity, because a capability's
  // `operatorLabel` is resolved as a subname *under that Bucket's own name* (e.g. `exec.savings.<owner>.eth`).
  // Without it, `issue()` reverts with OperatorNameNotRegistered. `bucketRegistry` in the manifest points at
  // trading's (the canonical demo bucket); the others resolve on-chain via their own subregistry.
  step(`ENSv2: operator ${env.ENS_OPERATOR_LABEL} under each Bucket`)
  let tradingRegistry: Address = zeroAddress
  for (const bucket of BUCKET_LABELS) {
    const registry = await ensureSubregistry(ownerRegistry, bucket, `${bucket}.${label}.eth`)
    await ensureSubname(registry, env.ENS_OPERATOR_LABEL, operatorAddress, 0n, expiry)
    info(`${env.ENS_OPERATOR_LABEL}.${bucket}.${label}.eth`, operatorAddress)
    if (bucket === 'trading') tradingRegistry = registry
  }

  deployment.ens = { ownerName: `${label}.eth`, ownerAddress: owner.account.address }
  deployment.evm.ens.ownerRegistry = ownerRegistry
  deployment.evm.ens.bucketRegistry = tradingRegistry
  writeManifest(deployment)
}

main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
