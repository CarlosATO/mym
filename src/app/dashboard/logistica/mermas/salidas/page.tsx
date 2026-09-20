import { redirect } from "next/navigation";
import { getMermasStockExitAccess } from "@/app/actions/logistica/mermas";
import { MermasStockExitPanel } from "@/modules/logistica/mermas/mermas-stock-exit-panel";

export default async function MermasStockExitsPage() {
  const allowed = await getMermasStockExitAccess();
  if (!allowed) redirect("/dashboard/logistica/mermas");
  return <MermasStockExitPanel />;
}
