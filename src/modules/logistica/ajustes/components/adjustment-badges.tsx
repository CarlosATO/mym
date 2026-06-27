import { CheckCircle2, FileText } from 'lucide-react'

export function StatusBadge({ status }: { status: string }) {
  if (status === 'COMPLETED') return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20"><CheckCircle2 className="w-3 h-3" /> Emitido</span>
  if (status === 'DRAFT') return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/20"><FileText className="w-3 h-3" /> Borrador</span>
  return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-gray-500/10 text-gray-600 dark:text-gray-400 border border-gray-500/20">{status}</span>
}

export function TypeBadge({ type }: { type: string }) {
  if (type === 'INITIAL' || type === 'POSITIVE') return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20">Ingreso +</span>
  if (type === 'NEGATIVE') return <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20">Salida -</span>
  return <span>{type}</span>
}
