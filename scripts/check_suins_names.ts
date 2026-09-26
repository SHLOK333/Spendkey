/**
 * Check if the deployer wallet has any SuiNS names on testnet.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'

const GRPC_URL = 'https://fullnode.testnet.sui.io:443'
const DEPLOYER = '0xa5bc69b87f98bfb47e6fae168991353ebc0805f398dfe011fa89dbf5e0702176'
const SUINS_ORIGINAL_PKG = '0x22fa05f21b1ad71442491220bb9338f7b7095fe35000ef88d5400d28523bdd93'

async function main(): Promise<void> {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_URL })

  console.log(`Checking owned objects for: ${DEPLOYER}`)

  // List all owned objects
  const result = await client.listOwnedObjects({
    owner: DEPLOYER,
  })

  console.log(`\nOwned objects (${result.objects.length} found):`)
  for (const obj of result.objects) {
    console.log(`  ${obj.objectId}  type: ${obj.type}  owner: ${JSON.stringify(obj.owner)}`)
  }

  // Filter for SuiNS registration NFTs
  const suinsNfts = result.objects.filter(obj =>
    obj.type?.includes('suins_registration') ||
    obj.type?.includes('SuinsRegistration') ||
    obj.type?.includes(SUINS_ORIGINAL_PKG)
  )
  console.log(`\nSuiNS NFTs: ${suinsNfts.length}`)
  for (const n of suinsNfts) {
    console.log(`  ${(n as any).objectId}  type: ${(n as any).type}`)
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
