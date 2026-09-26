/**
 * Verify the SuiNS shared object on testnet.
 */
import { SuiGrpcClient } from '@mysten/sui/grpc'

const GRPC_URL = 'https://fullnode.testnet.sui.io:443'
// From official Sui docs: https://docs.sui.io/sui-stack/suins/developer
const SUINS_OBJECT_TESTNET = '0x300369e8909b9a6464da265b9a5a9ab6fe2158a040e84e808628cde7a07ee5a3'
const SUINS_ORIGINAL_PKG = '0x22fa05f21b1ad71442491220bb9338f7b7095fe35000ef88d5400d28523bdd93'

async function main(): Promise<void> {
  const client = new SuiGrpcClient({ network: 'testnet', baseUrl: GRPC_URL })

  console.log(`Verifying SuiNS object: ${SUINS_OBJECT_TESTNET}`)
  const { objects } = await client.getObjects({ objectIds: [SUINS_OBJECT_TESTNET] })

  for (const obj of objects) {
    if (obj instanceof Error) {
      console.log('ERROR:', obj.message)
      continue
    }
    console.log(`  Object ID: ${obj.objectId}`)
    console.log(`  Type:      ${obj.type}`)
    console.log(`  Owner:     ${JSON.stringify(obj.owner)}`)
    console.log(`  Version:   ${obj.version}`)
    console.log(`  Digest:    ${obj.digest}`)

    const expectedType = `${SUINS_ORIGINAL_PKG}::suins::SuiNS`
    if (obj.type === expectedType) {
      console.log(`\n✅ Type matches expected ${expectedType}`)
    } else {
      console.log(`\n⚠️  Type mismatch. Expected: ${expectedType}`)
      console.log(`   Got: ${obj.type}`)
    }

    if (obj.owner && '$kind' in obj.owner && obj.owner.$kind === 'Shared') {
      console.log(`✅ Object is Shared (correct — SuiNS is a shared singleton)`)
    } else {
      console.log(`⚠️  Object owner is not Shared: ${JSON.stringify(obj.owner)}`)
    }
  }
}

main().catch((error: unknown) => { console.error(error); process.exitCode = 1 })
