
import { BucketSui, SuiBucketClient, type SuiExecutor } from '@bucket/sdk'
import { decodeSuiPrivateKey } from '@mysten/sui/cryptography'
import { SuiGrpcClient } from '@mysten/sui/grpc'
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519'
import { normalizeSuiAddress } from '@mysten/sui/utils'

import { loadDeployment } from './deployment'
import { serverEnv } from './env'

export function suiServer() {
  const deployment = loadDeployment()
  if (!deployment.sui) return null
  const network = deployment.sui.network
  const client = new SuiGrpcClient({ network, baseUrl: serverEnv.suiGrpcUrl() ?? `https://fullnode.${network}.sui.io:443` })
  return { deployment, sui: deployment.sui, client, reader: new BucketSui(client, deployment.sui.packageId) }
}

export function suiAgentKeypair(): Ed25519Keypair | null {
  const key = serverEnv.suiAgentKey()
  if (!key) return null
  const { scheme, secretKey } = decodeSuiPrivateKey(key)
  if (scheme !== 'ED25519') throw new Error(`unsupported Sui key scheme ${scheme}`)
  return Ed25519Keypair.fromSecretKey(secretKey)
}

/** Executes SDK-built Move transactions as the Sui agent operator. */
export function suiAgentClient(): { client: SuiBucketClient; address: string } | null {
  const s = suiServer()
  const keypair = suiAgentKeypair()
  if (!s || !keypair) return null
  const executor: SuiExecutor = async (tx) => {
    const res = await s.client.signAndExecuteTransaction({ transaction: tx, signer: keypair, include: { effects: true } })
    const executed = res.$kind === 'Transaction' ? res.Transaction : res.FailedTransaction
    if (res.$kind !== 'Transaction' || !executed.status.success) {
      throw new Error(`Sui transaction ${executed.digest} failed: ${JSON.stringify(executed.status)}`)
    }
    const settled = await s.client.waitForTransaction({ digest: executed.digest, include: { effects: true, objectTypes: true } })
    const done = settled.$kind === 'Transaction' ? settled.Transaction : settled.FailedTransaction
    return {
      digest: executed.digest,
      created: (suffix: string) =>
        done.effects.changedObjects
          .filter((c) => c.idOperation === 'Created' && done.objectTypes[c.objectId]?.endsWith(suffix))
          .map((c) => normalizeSuiAddress(c.objectId)),
    }
  }
  return { client: new SuiBucketClient(s.reader, executor), address: keypair.toSuiAddress() }
}
