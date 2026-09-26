import { EXECUTION_KIND_LABEL, formatAmount, formatWeight } from '@bucket/protocol-types'
import type { BucketView } from '@bucket/sdk'
import { zeroAddress } from 'viem'

import { useApp } from '../lib/context'
import { evmTxUrl } from '../lib/format'
import { useExecutions } from '../lib/queries'
import { HexLink, Panel } from './primitives'

const ZERO = zeroAddress

/** Every execution recorded by this Bucket: WHO executed, WHAT kind, WHAT changed, HOW MUCH, and the tx that
 *  proves it — the "why did my money move?" audit trail. */
export function LedgerPanel({ view }: { view: BucketView }) {
  const { config } = useApp()
  const { data } = useExecutions(view.bucketId)
  const rows = [...(data ?? [])].reverse()
  const token = (address: string) => view.allocation.rows.find((r) => r.token.toLowerCase() === address.toLowerCase())

  return (
    <Panel eyebrow="BucketController.ExecutionRecorded" title="Execution ledger">
      {rows.length === 0 ? (
        <p className="muted">No executions yet.</p>
      ) : (
        <table className="ledger">
          <thead>
            <tr>
              <th>#</th>
              <th>Kind</th>
              <th>Out</th>
              <th>In</th>
              <th>Max deviation</th>
              <th>Tx</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ receipt, txHash }) => {
              const out = token(receipt.tokenOut)
              const inn = receipt.tokenIn.toLowerCase() === ZERO.toLowerCase() ? null : token(receipt.tokenIn)
              return (
                <tr key={txHash}>
                  <td className="mono">{receipt.executionNonce.toString()}</td>
                  <td className="mono">{EXECUTION_KIND_LABEL[receipt.kind]}</td>
                  <td className="mono">
                    {out ? `${formatAmount(receipt.amountOut, out.decimals)} ${out.symbol}` : receipt.amountOut.toString()}
                  </td>
                  <td className="mono">
                    {receipt.amountIn === 0n
                      ? '—'
                      : inn
                        ? `${formatAmount(receipt.amountIn, inn.decimals)} ${inn.symbol}`
                        : receipt.amountIn.toString()}
                  </td>
                  <td className="mono">
                    {formatWeight(receipt.preMaxDeviationWad, 1)} → {formatWeight(receipt.postMaxDeviationWad, 1)}
                  </td>
                  <td>
                    <HexLink value={txHash} href={evmTxUrl(config.deployment, txHash)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </Panel>
  )
}
