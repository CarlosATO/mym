import { redirect } from 'next/navigation'

export default async function RecognizedExpensesPage({ searchParams }: { searchParams: Promise<{ year?: string; month?: string; status?: string; source?: string; search?: string }> }) {
  await searchParams
  redirect('/dashboard/analisis-comercial/control-financiero/flujo-caja')
}
