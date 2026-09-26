/**
 * Query Sui testnet to find the SuiNS shared object by type.
 * The SuiNS package original ID on testnet: 0x22fa05f21b1ad71442491220bb9338f7b7095fe35000ef88d5400d28523bdd93
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'

const GRPC_URL = 'https://fullnode.testnet.sui.io:443'
const SUINS_ORIGINAL_PKG = '0x22fa05f21b1ad71442491220bb9338f7b7095fe35000ef88d5400d28523bdd93'
const SUINS_LATEST_PKG = '0x40eee27b014a872f5c3330dcd5329aa55c7fe0fcc6e70c6498852e2e3727172e'
const DEPLOYER = '0xa5bc69b87f98bfb47e6fae168991353ebc0805f398dfe011fa89dbf5e0702176'

// The SuiNS package creator address can be found from the original package
// SuiNS was published by Mysten Labs; the SuiNS shared object was created at original publish time.
// We query owned objects of the SuiNS package publisher to find it.

async function main(): Promise<void> {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_URL })

  // Query objects by type to find the SuiNS shared object
  // Type: <original_pkg>::suins::SuiNS
  const suinsType = `${SUINS_ORIGINAL_PKG}::suins::SuiNS`
  console.log(`Looking for SuiNS shared object of type: ${suinsType}`)
  console.log(`SuiNS package (latest): ${SUINS_LATEST_PKG}`)

  // Try querying the package object itself to find init objects
  try {
    const pkgObj = await client.getObjects({ objectIds: [SUINS_ORIGINAL_PKG] })
    for (const obj of pkgObj.objects) {
      if (obj instanceof Error) continue
      console.log(`\nOriginal package: ${obj.objectId}  type: ${obj.type}  owner: ${JSON.stringify(obj.owner)}`)
    }
  } catch (e) {
    console.log('Package query error:', e)
  }

  // Try querying the latest package
  try {
    const pkgObj = await client.getObjects({ objectIds: [SUINS_LATEST_PKG] })
    for (const obj of pkgObj.objects) {
      if (obj instanceof Error) continue
      console.log(`\nLatest package: ${obj.objectId}  type: ${obj.type}  owner: ${JSON.stringify(obj.owner)}`)
    }
  } catch (e) {
    console.log('Latest package query error:', e)
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
