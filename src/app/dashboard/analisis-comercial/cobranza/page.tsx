import { getFinanceReceivablesAnalysis } from '@/lib/control-financiero/finance-api'
import { Cobranza } from '@/modules/analisis-comercial/views/cobranza'
import { getReceivablesSnapshotStatus } from '@/app/actions/comercial/cobranza-snapshot'

export default async function CobranzaPage() {
  const [result, snapshotStatus] = await Promise.all([
    getFinanceReceivablesAnalysis(2026, 0),
    getReceivablesSnapshotStatus(),
  ])

  if (!result.ok) {
    return <Cobranza error={result.message} snapshotStatus={snapshotStatus} />
  }

  return <Cobranza data={result.data} snapshotStatus={snapshotStatus} />
}
