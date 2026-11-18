import { redirect } from 'next/navigation'

export default async function AdquisicionesPage() {
  redirect('/dashboard/adquisiciones/ordenes-compra')
}
