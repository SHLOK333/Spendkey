import { SuiBucketClient, type SuiExecutor } from '@bucket/sdk'
import { useCurrentAccount, useDAppKit } from '@mysten/dapp-kit-react'
import { normalizeSuiAddress } from '@mysten/sui/utils'
import { useMemo } from 'react'

import { useApp } from './app'

/** The connected Sui wallet as an SDK executor: owner actions (grant, issue, revoke) are signed in the wallet. */
export function useSuiOwner(): { address: string | null; client: SuiBucketClient | null } {
  const { suiClient, suiReader } = useApp()
  const dAppKit = useDAppKit()
  const account = useCurrentAccount()
  const client = useMemo(() => {
    if (!account || !suiClient || !suiReader) return null
    const executor: SuiExecutor = async (tx) => {
      const signed = await dAppKit.signAndExecuteTransaction({ transaction: tx })
      const executed = signed.$kind === 'Transaction' ? signed.Transaction : signed.FailedTransaction
      if (signed.$kind !== 'Transaction' || !executed.status.success) {
        throw new Error(`Sui transaction ${executed.digest} failed: ${JSON.stringify(executed.status)}`)
      }
      const settled = await suiClient.waitForTransaction({ digest: executed.digest, include: { effects: true, objectTypes: true } })
      const done = settled.$kind === 'Transaction' ? settled.Transaction : settled.FailedTransaction
      return {
        digest: executed.digest,
        created: (suffix) =>
          done.effects.changedObjects
            .filter((c) => c.idOperation === 'Created' && done.objectTypes[c.objectId]?.endsWith(suffix))
            .map((c) => normalizeSuiAddress(c.objectId)),
      }
    }
    return new SuiBucketClient(suiReader, executor)
  }, [account, suiClient, suiReader, dAppKit])
  return { address: account?.address ?? null, client }
}
