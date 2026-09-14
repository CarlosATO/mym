import { getMermasBootstrap } from "@/app/actions/logistica/mermas";
import { MermasModuleProvider } from "@/modules/logistica/mermas/mermas-module-provider";
import { MermasShell } from "@/modules/logistica/mermas/mermas-shell";

export default async function MermasLayout({ children }: { children: React.ReactNode }) {
  const bootstrap = await getMermasBootstrap();
  return <MermasModuleProvider bootstrap={bootstrap}><MermasShell>{children}</MermasShell></MermasModuleProvider>;
}
