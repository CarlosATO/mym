const fs = require('fs');

let stockFile = 'src/modules/logistica/stock/stock-panel.tsx';
let content = fs.readFileSync(stockFile, 'utf8');

// 1. Update imports
content = content.replace(
  "import { useState, useEffect, useCallback, useMemo } from 'react'",
  "import { useState, useEffect, useCallback, useMemo, useRef } from 'react'"
);

content = content.replace(
  "import { getStockSummary, type StockItem } from '@/app/actions/logistica/recepciones'",
  "import { getStockSummary, getKardexMovements, type StockItem, type KardexMovement } from '@/app/actions/logistica/recepciones'"
);

content = content.replace(
  "import { Search, Package, MapPin, Layers, Coins, Box, LayoutGrid } from 'lucide-react'",
  "import { Search, Package, MapPin, Layers, Coins, Box, LayoutGrid, X, FileText, ArrowDownToLine, ArrowUpFromLine, RefreshCw, ArrowRightLeft, Undo2, Eye } from 'lucide-react'"
);

// 2. Add Badge components
const badgesCode = `
const MOVEMENT_TYPE_BADGES: Record<string, { bg: string; text: string; icon: React.ReactNode }> = {
  IN: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-600 dark:text-emerald-400', icon: <ArrowDownToLine className="w-3 h-3" /> },
  PURCHASE_RECEIPT: { bg: 'bg-emerald-500/10 border-emerald-500/20', text: 'text-emerald-600 dark:text-emerald-400', icon: <ArrowDownToLine className="w-3 h-3" /> },
  OUT: { bg: 'bg-red-500/10 border-red-500/20', text: 'text-red-600 dark:text-red-400', icon: <ArrowUpFromLine className="w-3 h-3" /> },
  ADJUSTMENT: { bg: 'bg-amber-500/10 border-amber-500/20', text: 'text-amber-600 dark:text-amber-400', icon: <RefreshCw className="w-3 h-3" /> },
  TRANSFER_IN: { bg: 'bg-blue-500/10 border-blue-500/20', text: 'text-blue-600 dark:text-blue-400', icon: <ArrowRightLeft className="w-3 h-3" /> },
  TRANSFER_OUT: { bg: 'bg-indigo-500/10 border-indigo-500/20', text: 'text-indigo-600 dark:text-indigo-400', icon: <ArrowRightLeft className="w-3 h-3" /> },
  RETURN: { bg: 'bg-purple-500/10 border-purple-500/20', text: 'text-purple-600 dark:text-purple-400', icon: <Undo2 className="w-3 h-3" /> },
}

function movementLabel(type: string) {
  const map: Record<string, string> = {
    IN: 'Entrada por recepción',
    PURCHASE_RECEIPT: 'Entrada por recepción',
    OUT: 'Salida',
    ADJUSTMENT: 'Ajuste',
    TRANSFER_IN: 'Traspaso entrada',
    TRANSFER_OUT: 'Traspaso salida',
    RETURN: 'Devolución'
  }
  return map[type] || type
}

function Badge({ type }: { type: string }) {
  const s = MOVEMENT_TYPE_BADGES[type] || { bg: 'bg-gray-500/10 border-gray-500/20', text: 'text-gray-500', icon: <Package className="w-3 h-3" /> }
  return (
    <span className={cn("inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[9px] font-bold uppercase tracking-wider", s.bg, s.text)}>
      {s.icon} <span className="truncate max-w-[100px]">{movementLabel(type)}</span>
    </span>
  )
}

function formatDate(dateStr: string) {
  return new Date(dateStr).toLocaleString('es-CL', { 
    day: '2-digit', month: '2-digit', year: '2-digit', 
    hour: '2-digit', minute: '2-digit' 
  })
}
`;

content = content.replace("export function StockPanel() {", badgesCode + "\nexport function StockPanel() {");

// 3. Update handleViewKardex to take full object
const handleViewKardexOld = `  const handleViewKardex = (productId: string, productSku: string, productDesc: string, warehouseId?: string, warehouseName?: string, lotNumber?: string) => {
    sessionStorage.setItem('mym_stock_to_kardex', JSON.stringify({
      productId,
      productSku,
      productDesc,
      warehouseId,
      warehouseName,
      lotNumber
    }))
    window.location.assign('/dashboard/logistica?tab=consultas&action=kardex')
  }`;

const handleViewKardexNew = `  const handleViewKardex = (it: any) => {
    sessionStorage.setItem('mym_stock_to_kardex', JSON.stringify({
      productId: it.product_id,
      productSku: it.product_sku,
      productDesc: it.product_description,
      warehouseId: it.warehouse_id,
      warehouseName: it.warehouse_name,
      locationId: it.location_id,
      locationCode: it.location_code,
      lotNumber: it.lot_number,
      expirationDate: it.expiration_date
    }))
    window.location.assign('/dashboard/logistica?tab=consultas&action=kardex')
  }`;

content = content.replace(handleViewKardexOld, handleViewKardexNew);

// 4. Update Product Details Table to use new handleViewKardex signature
content = content.replace(
  /onClick=\{\(\) \=\> handleViewKardex\(it\.product_id, it\.product_sku, it\.product_description, it\.warehouse_id, it\.warehouse_name, it\.lot_number \|\| undefined\)\}/g,
  "onClick={() => handleViewKardex(it)}"
);

content = content.replace(
  /onClick=\{\(e\) \=\> \{ e\.stopPropagation\(\); handleViewKardex\(it\.product_id, it\.product_sku, it\.product_description, it\.warehouse_id, it\.warehouse_name, it\.lot_number \|\| undefined\) \}\}/g,
  "onClick={(e) => { e.stopPropagation(); handleViewKardex(it) }}"
);

// 5. Update selected Product Details handleViewKardex for the top button
content = content.replace(
  "onClick={() => handleViewKardex(selectedProductDetails.info.id, selectedProductDetails.info.sku, selectedProductDetails.info.description)}",
  "onClick={() => handleViewKardex({ product_id: selectedProductDetails.info.id, product_sku: selectedProductDetails.info.sku, product_description: selectedProductDetails.info.description })}"
);

// 6. Add Preview State & Logic
const stateCode = `
  // Preview State
  const [selectedRowForPreview, setSelectedRowForPreview] = useState<StockItem | null>(null)
  const [previewMovements, setPreviewMovements] = useState<any[]>([])
  const [previewLoading, setPreviewLoading] = useState(false)
  const kardexCache = useRef<Map<string, KardexMovement[]>>(new Map())

  // Load Preview Kardex
  useEffect(() => {
    if (!selectedRowForPreview) return
    const row = selectedRowForPreview
    const cacheKey = \`\${row.product_id}_\${row.warehouse_id}_\${row.location_id || 'null'}_\${row.lot_number || 'null'}\`
    
    let active = true
    const processMovements = (allMvs: KardexMovement[]) => {
      // Filtrar y calcular saldo solo para esta fila
      const filtered = allMvs.filter(m => {
        if (m.warehouse_id !== row.warehouse_id) return false
        if (row.location_id && m.location_id !== row.location_id) return false
        if (!row.location_id && m.location_id) return false // si la fila no tiene ubicación, el mov tampoco debe tener (o debe coincidir null/undefined logic) - Wait, Stock summary groups by location.
        // To be safe, let's just match location_id if both are present or both are falsy
        const locMatch = (m.location_id || null) === (row.location_id || null)
        if (!locMatch) return false
        
        const lotMatch = (m.lot_number || null) === (row.lot_number || null)
        if (!lotMatch) return false
        
        return true
      })

      let currentBalance = 0
      const calculated = filtered.map(m => {
        const isPositive = ['IN', 'PURCHASE_RECEIPT', 'TRANSFER_IN', 'ADJUSTMENT'].includes(m.movement_type)
        const isNegative = ['OUT', 'TRANSFER_OUT', 'RETURN'].includes(m.movement_type)
        
        let delta = Number(m.quantity)
        if (isNegative) delta = -delta
        if (delta < 0 && m.quantity < 0) delta = m.quantity
        else if (isNegative && m.quantity > 0) delta = -m.quantity
        else if (isPositive && m.quantity < 0) delta = m.quantity

        currentBalance += delta
        return {
          ...m,
          delta,
          saldo: currentBalance,
          isPositive: delta > 0,
          isNegative: delta < 0
        }
      })

      if (active) {
        setPreviewMovements(calculated.reverse().slice(0, 10))
        setPreviewLoading(false)
      }
    }

    setPreviewLoading(true)
    
    // Check Cache
    if (kardexCache.current.has(row.product_id)) {
      processMovements(kardexCache.current.get(row.product_id)!)
      return
    }

    // Fetch from server
    getKardexMovements(row.product_id).then(data => {
      if (!active) return
      kardexCache.current.set(row.product_id, data)
      processMovements(data)
    })

    return () => { active = false }
  }, [selectedRowForPreview])
`;

content = content.replace("const load = useCallback", stateCode + "\n  const load = useCallback");

// Clear preview when mode changes
content = content.replace(
  "setMode('product'); setSelectedWarehouseId(null)",
  "setMode('product'); setSelectedWarehouseId(null); setSelectedRowForPreview(null)"
);

content = content.replace(
  "setMode('warehouse'); setSelectedProductId(null)",
  "setMode('warehouse'); setSelectedProductId(null); setSelectedRowForPreview(null)"
);

// 7. Update Warehouse Detail View TR and buttons
content = content.replace(
  /<tr key=\{idx\} onClick=\{[^\}]+\} className="hover:bg-theme-text\/\[0\.02\] transition-colors group cursor-pointer">/g,
  '<tr key={idx} onClick={() => setSelectedRowForPreview(it)} className={cn("transition-colors group cursor-pointer", selectedRowForPreview === it ? "bg-theme-accent/5 border-l-2 border-l-theme-accent" : "hover:bg-theme-text/[0.02]")}>'
);

content = content.replace(
  /<button[\s\S]*?<Layers className="w-3\.5 h-3\.5" \/>\s*<\/button>/g,
  \`<button 
    onClick={(e) => { e.stopPropagation(); setSelectedRowForPreview(it) }}
    className="p-1.5 rounded-lg bg-theme-surface border border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-accent transition-colors opacity-0 group-hover:opacity-100 shadow-sm flex items-center gap-1 px-2"
    title="Vista Previa"
  >
    <Eye className="w-3.5 h-3.5" /> <span className="text-[10px] font-bold">Preview</span>
  </button>\`
);


// 8. Add Mini Kardex layout
const oldWarehouseDetailDiv = `<div className="flex-1 bg-theme-surface overflow-y-auto">
              {!selectedWarehouseDetails ? (`;

const newWarehouseDetailDiv = `<div className="flex-1 flex overflow-hidden">
              <div className="flex-1 bg-theme-surface overflow-y-auto">
              {!selectedWarehouseDetails ? (`;

content = content.replace(oldWarehouseDetailDiv, newWarehouseDetailDiv);


// Find where warehouse details ends and insert Mini Kardex
const miniKardexCode = `
                </div>
              )}
            </div>

            {/* ── Mini Kardex Sidebar ── */}
            {selectedRowForPreview && (
              <div className="w-[420px] shrink-0 border-l border-theme-border bg-theme-surface flex flex-col animate-in slide-in-from-right-8 duration-300 shadow-[-4px_0_15px_rgba(0,0,0,0.03)] z-10">
                <div className="p-4 border-b border-theme-border flex items-center justify-between bg-theme-text/[0.015]">
                  <div>
                    <h3 className="font-bold text-theme-text flex items-center gap-2">
                      <Layers className="w-4 h-4 text-theme-accent" />
                      Vista Previa Kardex
                    </h3>
                  </div>
                  <button onClick={() => setSelectedRowForPreview(null)} className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                    <X className="w-4 h-4" />
                  </button>
                </div>
                
                <div className="flex-1 overflow-y-auto p-4">
                  {/* Resumen del Lote/Ubicación */}
                  <div className="mb-6">
                    <p className="font-mono text-[10px] font-bold text-theme-accent mb-1">{selectedRowForPreview.product_sku}</p>
                    <p className="font-bold text-theme-text text-sm mb-4 leading-tight">{selectedRowForPreview.product_description}</p>
                    
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border">
                        <p className="text-[9px] font-bold text-theme-text-muted uppercase">Bodega</p>
                        <p className="font-semibold text-theme-text truncate">{selectedRowForPreview.warehouse_name}</p>
                      </div>
                      <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border">
                        <p className="text-[9px] font-bold text-theme-text-muted uppercase">Ubicación</p>
                        <p className="font-mono font-medium text-theme-text truncate">{selectedRowForPreview.location_code || '—'}</p>
                      </div>
                      <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border">
                        <p className="text-[9px] font-bold text-theme-text-muted uppercase">Lote</p>
                        <p className="font-semibold text-theme-text truncate">{selectedRowForPreview.lot_number || '—'}</p>
                      </div>
                      <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border">
                        <p className="text-[9px] font-bold text-theme-text-muted uppercase">Vence</p>
                        <p className="font-semibold text-theme-text truncate">{selectedRowForPreview.expiration_date ? new Date(selectedRowForPreview.expiration_date).toLocaleDateString('es-CL') : '—'}</p>
                      </div>
                      <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border">
                        <p className="text-[9px] font-bold text-theme-text-muted uppercase">Stock Actual</p>
                        <p className="font-black text-theme-accent text-sm">{selectedRowForPreview.quantity}</p>
                      </div>
                      <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border">
                        <p className="text-[9px] font-bold text-theme-text-muted uppercase">Valorizado</p>
                        <p className="font-black text-theme-text text-sm">{formatCurrency(selectedRowForPreview.unit_cost ? selectedRowForPreview.quantity * selectedRowForPreview.unit_cost : 0)}</p>
                      </div>
                    </div>
                  </div>

                  <h4 className="font-bold text-xs text-theme-text-muted uppercase tracking-wider mb-3">Últimos Movimientos</h4>
                  
                  {previewLoading ? (
                    <div className="py-8 flex flex-col items-center justify-center">
                      <div className="w-6 h-6 border-2 border-theme-accent border-t-transparent rounded-full animate-spin mb-2" />
                      <p className="text-xs text-theme-text-muted">Cargando...</p>
                    </div>
                  ) : previewMovements.length === 0 ? (
                    <div className="py-8 text-center bg-theme-text/5 rounded-xl border border-theme-border border-dashed">
                      <p className="text-xs text-theme-text-muted">No hay movimientos recientes para esta combinación.</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {previewMovements.map((m: any) => (
                        <div key={m.id} className="bg-theme-surface border border-theme-border p-3 rounded-xl shadow-sm text-xs">
                          <div className="flex items-center justify-between mb-2">
                            <span className="font-mono text-[9px] text-theme-text-muted">{formatDate(m.movement_date)}</span>
                            <Badge type={m.movement_type} />
                          </div>
                          <p className="font-semibold text-theme-text mb-2 truncate" title={m.source_id}>{m.source_id}</p>
                          <div className="flex items-center justify-between bg-theme-text/[0.015] p-2 rounded-lg border border-theme-border/50">
                            <div className="text-center flex-1">
                              <p className="text-[9px] font-bold text-theme-text-muted uppercase">Entrada</p>
                              <p className="font-black text-emerald-600">{m.isPositive ? '+' + Math.abs(m.quantity) : '—'}</p>
                            </div>
                            <div className="w-px h-6 bg-theme-border/50 mx-2" />
                            <div className="text-center flex-1">
                              <p className="text-[9px] font-bold text-theme-text-muted uppercase">Salida</p>
                              <p className="font-black text-red-600">{m.isNegative ? '-' + Math.abs(m.quantity) : '—'}</p>
                            </div>
                            <div className="w-px h-6 bg-theme-border/50 mx-2" />
                            <div className="text-center flex-1">
                              <p className="text-[9px] font-bold text-theme-accent uppercase">Saldo</p>
                              <p className="font-black text-theme-text">{m.saldo}</p>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="p-4 border-t border-theme-border bg-theme-surface shrink-0">
                  <button 
                    onClick={() => handleViewKardex(selectedRowForPreview)}
                    className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-sm active:scale-95"
                  >
                    Ver Kardex Completo <ArrowRight className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            )}
`;

content = content.replace("</div>\n              )}\n            </div>\n          </>\n        )}", miniKardexCode + "\n            </div>\n          </>\n        )}");


fs.writeFileSync(stockFile, content);
