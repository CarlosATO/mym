import { getFinanceReceivablesAnalysis } from '@/lib/control-financiero/finance-api'
import { Cobranza } from '@/modules/analisis-comercial/views/cobranza'

export default async function CobranzaPage() {
  const result = await getFinanceReceivablesAnalysis(2026, 0)

  if (!result.ok) {
    return <Cobranza error={result.message} />
  }

  return <Cobranza data={result.data} />
}
