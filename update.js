const fs = require('fs');
const file = 'src/modules/logistica/recepciones/recepciones-panel.tsx';
let code = fs.readFileSync(file, 'utf8');

// RecepcionesPanel
code = code.replace(
  'export function RecepcionesPanel() {\n  const [pos, setPos] = useState<PurchaseOrderPending[]>([])',
  'export function RecepcionesPanel() {\n  const router = useRouter()\n  const [receivingId, setReceivingId] = useState<string | null>(null)\n  const handleReceive = (id: string) => { if (receivingId) return; setReceivingId(id); router.push(`/dashboard/logistica/recepciones/${id}`) }\n  const [pos, setPos] = useState<PurchaseOrderPending[]>([])'
);

code = code.replace(
  'onDetailLoaded={(poId, data) => { detailCache.current[poId] = data }}',
  'onDetailLoaded={(poId, data) => { detailCache.current[poId] = data }}\n          receivingId={receivingId}\n          onReceive={handleReceive}'
);

code = code.replace(
  'onPrefetch={prefetchDetail}',
  'onPrefetch={prefetchDetail}\n          receivingId={receivingId}\n          onReceive={handleReceive}'
);

// DetailPanel interface
code = code.replace(
  'onDetailLoaded: (poId: string, data: any) => void\n}) {',
  'onDetailLoaded: (poId: string, data: any) => void\n  receivingId: string | null\n  onReceive: (id: string) => void\n}) {'
);

// DetailPanel Buttons (Recibir saldo)
code = code.replace(
  'onClick={() => router.push(`/dashboard/logistica/recepciones/${summary.id}`)}\n                className="px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all active:scale-95"\n              >\n                Recibir saldo',
  'disabled={!!receivingId}\n                onClick={() => onReceive(summary.id)}\n                className="px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"\n              >\n                {receivingId === summary.id ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Cargando...</> : "Recibir saldo"}'
);

// DetailPanel Buttons (Recibir OC)
code = code.replace(
  'onClick={() => router.push(`/dashboard/logistica/recepciones/${summary.id}`)}\n                className="px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all active:scale-95"\n              >\n                Recibir OC',
  'disabled={!!receivingId}\n                onClick={() => onReceive(summary.id)}\n                className="px-3 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"\n              >\n                {receivingId === summary.id ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Cargando...</> : "Recibir OC"}'
);

// TrayTable interface
code = code.replace(
  'onPrefetch: (poId: string) => void\n}) {',
  'onPrefetch: (poId: string) => void\n  receivingId: string | null\n  onReceive: (id: string) => void\n}) {'
);

// TrayTable double click
code = code.split('onDoubleClick={() => onOpenDetail(po)}').join('onDoubleClick={() => { if (po.status === "RECEPCION_TOTAL") onOpenDetail(po); else onReceive(po.id); }}');

// TrayTable Ver Button (restore double click here since we split-joined)
// Actually wait, onOpenDetail(po) is used in button too.
// Let's revert that and just do the exact row replacement.
code = code.replace(
  'onDoubleClick={() => { if (po.status === "RECEPCION_TOTAL") onOpenDetail(po); else onReceive(po.id); }}\n                          className="px-2.5 py-1 rounded-lg border border-theme-border hover:bg-theme-text/10 text-theme-text-muted text-[10px] font-semibold transition-all flex items-center gap-1 ml-auto"\n                        >\n                          <Eye className="w-3 h-3" /> Ver',
  'onClick={() => onOpenDetail(po)}\n                          className="px-2.5 py-1 rounded-lg border border-theme-border hover:bg-theme-text/10 text-theme-text-muted text-[10px] font-semibold transition-all flex items-center gap-1 ml-auto"\n                        >\n                          <Eye className="w-3 h-3" /> Ver'
);

// TrayTable Buttons (Recibir saldo)
code = code.replace(
  'onClick={() => router.push(`/dashboard/logistica/recepciones/${po.id}`)}\n                          className="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/25 text-[10px] font-bold transition-all"\n                        >\n                          Recibir saldo',
  'disabled={!!receivingId}\n                          onClick={(e) => { e.stopPropagation(); onReceive(po.id); }}\n                          className="px-2.5 py-1 rounded-lg bg-amber-500/10 hover:bg-amber-500/20 text-amber-700 dark:text-amber-400 border border-amber-500/25 text-[10px] font-bold transition-all disabled:opacity-50 flex items-center gap-1"\n                        >\n                          {receivingId === po.id ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Cargando...</> : "Recibir saldo"}'
);

// TrayTable Buttons (Recibir)
code = code.replace(
  'onClick={() => router.push(`/dashboard/logistica/recepciones/${po.id}`)}\n                          className="px-2.5 py-1 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-[10px] font-bold transition-all active:scale-95"\n                        >\n                          Recibir',
  'disabled={!!receivingId}\n                          onClick={(e) => { e.stopPropagation(); onReceive(po.id); }}\n                          className="px-2.5 py-1 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-[10px] font-bold transition-all active:scale-95 disabled:opacity-50 flex items-center gap-1"\n                        >\n                          {receivingId === po.id ? <><Loader2 className="w-3 h-3 animate-spin mr-1" /> Cargando...</> : "Recibir"}'
);

fs.writeFileSync(file, code, 'utf8');
