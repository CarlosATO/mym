import { redirect } from "next/navigation";
import Link from "next/link";
import { getWorkerPaymentReviewAccess } from "@/app/actions/logistica/mermas";
import { WorkerPaymentReviewPanel } from "@/modules/logistica/mermas/worker-payment-review-panel";

export default async function WorkerPaymentReviewPage() {
  if (!await getWorkerPaymentReviewAccess()) redirect("/dashboard/logistica/mermas");
  return <><div className="px-5 pt-4"><Link href="/dashboard/logistica/mermas" className="text-xs font-semibold text-theme-text-accent hover:underline">← Volver a Mermas</Link></div><WorkerPaymentReviewPanel /></>;
}
