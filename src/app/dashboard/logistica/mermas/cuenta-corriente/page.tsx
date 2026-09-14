import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WorkerAccountPanel } from "@/modules/logistica/mermas/worker-account-panel";

export default async function WorkerAccountPage() {
  const supabase = await createClient();
  const { data: allowed } = await supabase.rpc("has_permission", {
    p_permission_code: "logistica.mermas.account.view",
  });
  if (allowed !== true) redirect("/dashboard/logistica/mermas");
  return <WorkerAccountPanel />;
}
