import { redirect } from 'next/navigation'

export default async function RecognizedExpensesPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; status?: string; source?: string; search?: string }> }) {
  const params = await searchParams
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) query.set(key === 'source' ? 'source' : key, value)
  redirect(`/dashboard/analisis-comercial/control-financiero/movimientos?tab=movimientos${query.toString() ? `&${query.toString()}` : ''}`)
}
