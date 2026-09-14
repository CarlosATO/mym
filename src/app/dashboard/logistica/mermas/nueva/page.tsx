import { redirect } from "next/navigation"
import { requireWmsPermission } from "@/app/actions/logistica/authorization"
import { MermasPanel } from '@/modules/logistica/mermas/mermas-panel'

export default async function NuevaMermaPage() {
  try {
    await requireWmsPermission("logistica.mermas.request.create")
  } catch {
    redirect("/dashboard/logistica/mermas")
  }
  return <MermasPanel mode="new" />
}
