import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { InternalSalePanel } from "@/modules/logistica/mermas/internal-sale-panel";

export default async function InternalSalePage() {
  const supabase = await createClient();
  const { data: allowed } = await supabase.rpc("has_permission", {
    p_permission_code: "logistica.mermas.internal_sale.create",
  });
  if (allowed !== true) redirect("/dashboard/logistica/mermas");
  return <InternalSalePanel />;
}
