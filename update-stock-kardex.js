const fs = require('fs');

// --- UPDATE STOCK-PANEL.TSX ---
let stockFile = 'src/modules/logistica/stock/stock-panel.tsx';
let stockCode = fs.readFileSync(stockFile, 'utf8');

const stockNavigationState = `  // Navigation State
  const [mode, setMode] = useState<'product' | 'warehouse'>('product')
  
  // Product Mode State`;

const stockNavigationStateNew = `  // Navigation State
  const [mode, setMode] = useState<'product' | 'warehouse'>('product')
  
  const handleViewKardex = (productId: string, productSku: string, productDesc: string, warehouseId?: string, warehouseName?: string, lotNumber?: string) => {
    sessionStorage.setItem('mym_stock_to_kardex', JSON.stringify({
      productId,
      productSku,
      productDesc,
      warehouseId,
      warehouseName,
      lotNumber
    }))
    window.location.assign('/dashboard/logistica?tab=consultas&action=kardex')
  }
  
  // Product Mode State`;

stockCode = stockCode.replace(stockNavigationState, stockNavigationStateNew);

const productHeader = `                  <div className="mb-8">
                    <p className="text-sm font-mono font-bold text-theme-accent mb-2">{selectedProductDetails.info.sku}</p>
                    <h2 className="text-3xl font-black text-theme-text mb-6">{selectedProductDetails.info.description}</h2>
                    
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">`;

const productHeaderNew = `                  <div className="mb-8 flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="text-sm font-mono font-bold text-theme-accent mb-2">{selectedProductDetails.info.sku}</p>
                      <h2 className="text-3xl font-black text-theme-text mb-6 truncate" title={selectedProductDetails.info.description}>{selectedProductDetails.info.description}</h2>
                    </div>
                    <button 
                      onClick={() => handleViewKardex(selectedProductDetails.info.id, selectedProductDetails.info.sku, selectedProductDetails.info.description)}
                      className="shrink-0 flex items-center gap-2 px-4 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-sm active:scale-95"
                    >
                      <Layers className="w-4 h-4" />
                      Ver Kardex
                    </button>
                  </div>
                    
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-4">`;

stockCode = stockCode.replace(productHeader, productHeaderNew);

const tableHeader = `                          <th className="px-5 py-3 text-right">Valorizado</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-theme-border/50">
                        {selectedWarehouseDetails.items.map((it, idx) => (
                          <tr key={idx} className="hover:bg-theme-text/[0.02] transition-colors">
                            <td className="px-5 py-3">`;

const tableHeaderNew = `                          <th className="px-5 py-3 text-right">Valorizado</th>
                          <th className="px-3 py-3 text-center w-12"></th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-theme-border/50">
                        {selectedWarehouseDetails.items.map((it, idx) => (
                          <tr key={idx} onClick={() => handleViewKardex(it.product_id, it.product_sku, it.product_description, it.warehouse_id, it.warehouse_name, it.lot_number || undefined)} className="hover:bg-theme-text/[0.02] transition-colors group cursor-pointer">
                            <td className="px-5 py-3">`;

stockCode = stockCode.replace(tableHeader, tableHeaderNew);

const tableRowEnd = `                            <td className="px-5 py-3 text-right font-black text-theme-accent text-sm">{it.quantity}</td>
                            <td className="px-5 py-3 text-right text-theme-text-muted">{formatCurrency(it.unit_cost)}</td>
                            <td className="px-5 py-3 text-right font-bold text-theme-text">{formatCurrency(it.unit_cost ? it.quantity * it.unit_cost : 0)}</td>
                          </tr>`;

const tableRowEndNew = `                            <td className="px-5 py-3 text-right font-black text-theme-accent text-sm">{it.quantity}</td>
                            <td className="px-5 py-3 text-right text-theme-text-muted">{formatCurrency(it.unit_cost)}</td>
                            <td className="px-5 py-3 text-right font-bold text-theme-text">{formatCurrency(it.unit_cost ? it.quantity * it.unit_cost : 0)}</td>
                            <td className="px-3 py-3 text-center">
                              <button 
                                onClick={(e) => { e.stopPropagation(); handleViewKardex(it.product_id, it.product_sku, it.product_description, it.warehouse_id, it.warehouse_name, it.lot_number || undefined) }}
                                className="p-1.5 rounded-lg bg-theme-surface border border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-accent transition-colors opacity-0 group-hover:opacity-100 shadow-sm"
                                title="Ver Kardex"
                              >
                                <Layers className="w-3.5 h-3.5" />
                              </button>
                            </td>
                          </tr>`;

stockCode = stockCode.replace(tableRowEnd, tableRowEndNew);

fs.writeFileSync(stockFile, stockCode, 'utf8');

// --- UPDATE KARDEX-PANEL.TSX ---
let kardexFile = 'src/modules/logistica/kardex/kardex-panel.tsx';
let kardexCode = fs.readFileSync(kardexFile, 'utf8');

kardexCode = kardexCode.replace(
  "import { Search, Package, Calendar, MapPin, Tag, ArrowLeft, Filter, X, ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, RefreshCw, Undo2 } from 'lucide-react'",
  "import { Search, Package, Calendar, MapPin, Tag, ArrowLeft, Filter, X, ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, RefreshCw, Undo2, FileText } from 'lucide-react'\nimport * as XLSX from 'xlsx'"
);

const koldState = `  const [filterWarehouse, setFilterWarehouse] = useState('')
  const [filterLocation, setFilterLocation] = useState('')
  const [filterLot, setFilterLot] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  // Product Search Debounce`;

const knewState = `  const [filterWarehouse, setFilterWarehouse] = useState('')
  const [filterWarehouseId, setFilterWarehouseId] = useState('')
  const [filterLocation, setFilterLocation] = useState('')
  const [filterLot, setFilterLot] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [isFilteredFromStock, setIsFilteredFromStock] = useState(false)

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const flash = sessionStorage.getItem('mym_stock_to_kardex')
      if (flash) {
        try {
          const data = JSON.parse(flash)
          if (data.productId) {
            setSelectedProduct({
              id: data.productId,
              sku: data.productSku,
              description: data.productDesc,
              brand: null
            } as Product)
            
            if (data.warehouseId) {
              setFilterWarehouseId(data.warehouseId)
              setFilterWarehouse(data.warehouseName || '')
            }
            if (data.lotNumber) {
              setFilterLot(data.lotNumber)
            }
            
            setIsFilteredFromStock(true)
            setShowFilters(true)
            sessionStorage.removeItem('mym_stock_to_kardex')
          }
        } catch (e) {}
      }
    }
  }, [])

  // Product Search Debounce`;

kardexCode = kardexCode.replace(koldState, knewState);

const koldFilter = `    // 1. Filter raw movements (which are sorted ASC from DB)
    const filtered = movements.filter(m => {
      if (filterWarehouse && !m.warehouse_name.toLowerCase().includes(filterWarehouse.toLowerCase())) return false`;

const knewFilter = `    // 1. Filter raw movements (which are sorted ASC from DB)
    const filtered = movements.filter(m => {
      if (filterWarehouseId && m.warehouse_id !== filterWarehouseId) return false
      else if (!filterWarehouseId && filterWarehouse && !m.warehouse_name.toLowerCase().includes(filterWarehouse.toLowerCase())) return false`;

kardexCode = kardexCode.replace(koldFilter, knewFilter);

const koldInput = `<input value={filterWarehouse} onChange={e => setFilterWarehouse(e.target.value)} placeholder="Ej: Principal" className="w-full h-8 px-3 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:ring-1 focus:ring-theme-accent" />`;

const knewInput = `<input value={filterWarehouse} onChange={e => { setFilterWarehouse(e.target.value); setFilterWarehouseId(''); setIsFilteredFromStock(false); }} placeholder="Ej: Principal" className="w-full h-8 px-3 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:ring-1 focus:ring-theme-accent" />`;

kardexCode = kardexCode.replace(koldInput, knewInput);

const koldClearBtn = `            {hasActiveFilters && (
              <button 
                onClick={() => {
                  setFilterWarehouse(''); setFilterLocation(''); setFilterLot(''); setFilterType(''); setFilterDateFrom(''); setFilterDateTo('')
                }}`;

const knewClearBtn = `            {hasActiveFilters && (
              <button 
                onClick={() => {
                  setFilterWarehouse(''); setFilterWarehouseId(''); setFilterLocation(''); setFilterLot(''); setFilterType(''); setFilterDateFrom(''); setFilterDateTo(''); setIsFilteredFromStock(false);
                }}`;

kardexCode = kardexCode.replace(koldClearBtn, knewClearBtn);

const koldFilterBar = `      {/* ── Filters Bar ── */}
      <div className="shrink-0 border-b border-theme-border bg-theme-surface">
        <div className="px-6 py-2 flex items-center justify-between">
          <button 
            onClick={() => setShowFilters(!showFilters)}
            className={cn("text-xs font-bold flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors", showFilters ? "bg-theme-accent text-white" : "bg-theme-text/5 text-theme-text hover:bg-theme-text/10")}
          >
            <Filter className="w-3.5 h-3.5" />
            {showFilters ? 'Ocultar Filtros' : 'Mostrar Filtros'}
            {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-red-500" />}
          </button>
          
          {hasActiveFilters && (`;

const kexportFunc = `  const handleExportExcel = () => {
    if (!selectedProduct || filteredAndCalculatedMovements.length === 0) return

    const exportData = filteredAndCalculatedMovements.map(m => {
      const isPositive = m.isPositive
      const isNegative = m.isNegative
      const absoluteQty = Math.abs(Number(m.quantity))
      
      return {
        'Fecha / hora': formatDate(m.movement_date),
        'SKU': selectedProduct.sku,
        'Producto': selectedProduct.description,
        'Tipo movimiento': movementLabel(m.movement_type),
        'Referencia': m.source_id || '',
        'Bodega': m.warehouse_name || '',
        'Ubicación': m.location_code || '',
        'Lote': m.lot_number || '',
        'Vencimiento': m.expiration_date ? new Date(m.expiration_date).toLocaleDateString('es-CL') : '',
        'Entrada': isPositive ? absoluteQty : '',
        'Salida': isNegative ? absoluteQty : '',
        'Saldo': m.saldo,
        'Costo unitario': m.unit_cost || 0,
        'Costo total': (m.unit_cost || 0) * absoluteQty
      }
    })

    const ws = XLSX.utils.json_to_sheet(exportData)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Kardex')

    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    XLSX.writeFile(wb, \`Kardex_\${selectedProduct.sku}_\${dateStr}.xlsx\`)
  }

`;

const knewFilterBar = kexportFunc + `      {/* ── Filters Bar ── */}
      <div className="shrink-0 border-b border-theme-border bg-theme-surface">
        <div className="px-6 py-2 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setShowFilters(!showFilters)}
              className={cn("text-xs font-bold flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors", showFilters ? "bg-theme-accent text-white" : "bg-theme-text/5 text-theme-text hover:bg-theme-text/10")}
            >
              <Filter className="w-3.5 h-3.5" />
              {showFilters ? 'Ocultar Filtros' : 'Mostrar Filtros'}
              {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-red-500" />}
            </button>
            {isFilteredFromStock && (
              <span className="text-[10px] font-semibold text-emerald-600 bg-emerald-500/10 px-2 py-1 rounded border border-emerald-500/20">
                Filtro aplicado desde Stock
              </span>
            )}
          </div>
          
          <div className="flex items-center gap-3">
            <button
              onClick={handleExportExcel}
              disabled={filteredAndCalculatedMovements.length === 0}
              className="text-xs font-bold flex items-center gap-2 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white transition-colors disabled:opacity-50 shadow-sm"
              title={filteredAndCalculatedMovements.length === 0 ? "No hay movimientos para exportar" : ""}
            >
              <FileText className="w-3.5 h-3.5" /> Exportar Excel
            </button>
            {hasActiveFilters && (`;

kardexCode = kardexCode.replace(koldFilterBar, knewFilterBar);

fs.writeFileSync(kardexFile, kardexCode, 'utf8');
