import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { MermasReport } from "@/modules/logistica/mermas/mermas-report";

export default async function MermasReportPage() {
  const supabase = await createClient();
  const { data: allowed } = await supabase.rpc("has_permission", {
    p_permission_code: "logistica.mermas.view",
  });
  if (allowed !== true) redirect("/dashboard/logistica/mermas");
  return <MermasReport />;
}
