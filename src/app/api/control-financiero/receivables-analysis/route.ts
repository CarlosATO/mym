import { NextResponse } from 'next/server'
import { getFinanceReceivablesAnalysis } from '@/lib/control-financiero/finance-api'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const year = Number(url.searchParams.get('year') ?? '2026')
  const period = Number(url.searchParams.get('period') ?? '0')
  if (!Number.isInteger(year) || !Number.isInteger(period) || period < 0 || period > 12) {
    return NextResponse.json({ detail: 'Parámetros de período inválidos.' }, { status: 400 })
  }
  const result = await getFinanceReceivablesAnalysis(year, period)
  if (!result.ok) return NextResponse.json({ detail: result.message }, { status: result.status })
  return NextResponse.json(result.data)
}
