import sys

file_path = r'c:\Users\mympr\OneDrive\Desktop\PetGrup\mym\src\modules\adquisiciones\ordenes-compra\purchase-orders-panel.tsx'
content = open(file_path, 'r', encoding='utf-8').read()

if 'PackageOpen' not in content:
    content = content.replace("Ban } from 'lucide-react'", "Ban, PackageOpen, XCircle, CheckCircle2 } from 'lucide-react'")

state_insertion = '''
  const [selectedPo, setSelectedPo] = useState<PurchaseOrder | null>(null)
  const detailCacheRef = useRef<Record<string, PurchaseOrderDetail>>({})
  const pendingRequestsRef = useRef<Record<string, Promise<PurchaseOrderDetail | null>>>({})
'''
content = content.replace("const [view, setView] = useState<'list' | 'form' | 'detail'>('list')", 
                          "const [view, setView] = useState<'list' | 'form' | 'detail'>('list')" + state_insertion)

old_openDetail = '''  function openDetail(po: PurchaseOrder) {
    setDetail(null)
    setView('detail')
    getPurchaseOrderDetail(po.id).then(d => setDetail(d))
  }'''

new_openDetail = '''  function openDetail(po: PurchaseOrder) {
    setSelectedPo(po)
    setView('list')
    setDetail(null)
    
    if (detailCacheRef.current[po.id]) {
      setDetail(detailCacheRef.current[po.id])
      return
    }
    
    if (!pendingRequestsRef.current[po.id]) {
      pendingRequestsRef.current[po.id] = getPurchaseOrderDetail(po.id)
    }
    
    pendingRequestsRef.current[po.id].then(d => {
      if (d) {
        detailCacheRef.current[po.id] = d
        setDetail(prev => d)
      }
    })
  }

  function prefetchDetail(poId: string) {
    if (detailCacheRef.current[poId]) return
    if (!pendingRequestsRef.current[poId]) {
      pendingRequestsRef.current[poId] = getPurchaseOrderDetail(poId).then(d => {
        if (d) detailCacheRef.current[poId] = d
        return d
      })
    }
  }
'''
content = content.replace(old_openDetail, new_openDetail)

old_table = 'className="border-b border-theme-border hover:bg-theme-text/5 transition-colors cursor-pointer" onClick={() => openDetail(po)}'
new_table = 'className={`border-b border-theme-border hover:bg-theme-text/5 transition-colors cursor-pointer ${selectedPo?.id === po.id ? "bg-theme-accent/5 border-l-2 border-l-theme-accent" : ""}`} onClick={() => openDetail(po)} onMouseEnter={() => prefetchDetail(po.id)}'
content = content.replace(old_table, new_table)

old_list_return = '''  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface">'''

new_list_return = '''  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface">
      <div className="flex flex-1 overflow-hidden">
        <div className={`flex flex-col h-full overflow-hidden transition-all duration-300 ${selectedPo ? "w-full md:w-1/3 lg:w-1/4 border-r border-theme-border" : "w-full"}`}>'''

content = content.replace(old_list_return, new_list_return)

old_end = '''      )}
    </div>
  )
}'''

new_end = '''      )}
        </div>
        
        {selectedPo && (
          <div className="hidden md:flex flex-col flex-1 bg-theme-surface animate-in slide-in-from-right-4 duration-300 overflow-hidden">
             <div className="flex items-center justify-between gap-4 px-5 py-3 bg-theme-text/[0.02] border-b border-theme-border/70 shrink-0">
               <div className="flex items-center gap-3">
                 <div className="w-7 h-7 rounded-lg bg-theme-accent/10 flex items-center justify-center shrink-0"><PackageOpen className="w-4 h-4 text-theme-accent" /></div>
                 <div>
                   <div className="flex items-center gap-2"><span className="font-mono text-sm font-bold text-theme-accent">{selectedPo.correlative}</span><Badge value={selectedPo.status} map={STATUS_BADGES} /></div>
                   <p className="text-xs text-theme-text-muted truncate">{selectedPo.supplier_name}</p>
                 </div>
               </div>
               <div className="flex items-center gap-2 shrink-0">
                 <button onClick={() => setSelectedPo(null)} className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors"><X className="w-3.5 h-3.5" /></button>
               </div>
             </div>
             <div className="flex-1 overflow-auto p-6 lg:p-8">
               {detail ? (
                 <div className="space-y-8">
                   <div className="flex gap-2">
                     <button onClick={handleDownloadPDF} className="px-4 py-2 rounded-xl border border-theme-border text-xs text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 transition-colors font-semibold flex items-center gap-1.5"><Download className="w-3.5 h-3.5" /> PDF</button>
                   </div>
                   <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-5">
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Fecha emisión</p><p className="text-sm text-theme-text">{formatDate(selectedPo.issue_date)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Total Neto</p><p className="text-sm text-theme-text">{formatCurrency(selectedPo.net_total, selectedPo.currency)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Total IVA</p><p className="text-sm text-theme-text">{formatCurrency(selectedPo.tax_total, selectedPo.currency)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Total Compra</p><p className="text-sm text-theme-text font-bold">{formatCurrency(selectedPo.grand_total, selectedPo.currency)}</p></div>
                     <div><p className="text-xs text-theme-text-muted/70 mb-0.5">Bodega destino</p><p className="text-sm text-theme-text">{selectedPo.warehouse_name || "—"}</p></div>
                   </div>
                   <h3 className="text-sm font-bold text-theme-text mb-4 mt-8">Líneas de la orden</h3>
                   <div className="overflow-x-auto rounded-xl border border-theme-border">
                     <table className="w-full text-sm">
                       <thead><tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider"><th className="text-left py-3 px-4">Producto/Servicio</th><th className="text-right py-3 px-4">Cantidad</th><th className="text-right py-3 px-4">Total</th></tr></thead>
                       <tbody>
                         {detail.items.map(it => (
                           <tr key={it.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                             <td className="py-3 px-4 text-xs text-theme-text">{it.product_description}</td>
                             <td className="py-3 px-4 text-xs text-theme-text text-right">{it.quantity}</td>
                             <td className="py-3 px-4 text-xs text-theme-text font-semibold text-right">{formatCurrency(it.line_total, detail.po.currency)}</td>
                           </tr>
                         ))}
                       </tbody>
                     </table>
                   </div>
                 </div>
               ) : (
                 <div className="animate-pulse space-y-4">
                   <div className="h-3 bg-theme-text/10 rounded w-1/3" />
                   <div className="space-y-2"><div className="h-8 bg-theme-text/6 rounded" /><div className="h-8 bg-theme-text/6 rounded" /></div>
                 </div>
               )}
             </div>
          </div>
        )}
      </div>
    </div>
  )
}'''

content = content.replace(old_end, new_end)

# Hide columns conditionally
old_th_actions = '<th className="text-right py-3 px-4 font-medium">Acciones</th>'
new_th_actions = '<th className={`text-right py-3 px-4 font-medium ${selectedPo ? "hidden" : ""}`}>Acciones</th>'
content = content.replace(old_th_actions, new_th_actions)

old_td_actions = '<td className="py-3 px-4 text-right" onClick={e => e.stopPropagation()}>'
new_td_actions = '<td className={`py-3 px-4 text-right ${selectedPo ? "hidden" : ""}`} onClick={e => e.stopPropagation()}>'
content = content.replace(old_td_actions, new_td_actions)

with open(file_path, 'w', encoding='utf-8') as f:
    f.write(content)

print("Modification complete")
