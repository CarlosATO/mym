const fs = require('fs');

let file = 'src/modules/logistica/kardex/kardex-panel.tsx';
let content = fs.readFileSync(file, 'utf8');

// 1. Add import XLSX and FileText icon
content = content.replace(
  "import { Search, Package, Calendar, MapPin, Tag, ArrowLeft, Filter, X, ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, RefreshCw, Undo2 } from 'lucide-react'",
  "import { Search, Package, Calendar, MapPin, Tag, ArrowLeft, Filter, X, ArrowRightLeft, ArrowDownToLine, ArrowUpFromLine, RefreshCw, Undo2, FileText } from 'lucide-react'\nimport * as XLSX from 'xlsx'"
);

// 2. Add new states and useEffect
const oldState = `  const [filterWarehouse, setFilterWarehouse] = useState('')
  const [filterLocation, setFilterLocation] = useState('')
  const [filterLot, setFilterLot] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)

  // Product Search Debounce`;

const newState = `  const [filterWarehouse, setFilterWarehouse] = useState('')
  const [filterWarehouseId, setFilterWarehouseId] = useState('')
  const [filterLocation, setFilterLocation] = useState('')
  const [filterLot, setFilterLot] = useState('')
  const [filterType, setFilterType] = useState('')
  const [filterDateFrom, setFilterDateFrom] = useState('')
  const [filterDateTo, setFilterDateTo] = useState('')
  const [showFilters, setShowFilters] = useState(false)
  const [isFilteredFromStock, setIsFilteredFromStock] = useState(false)

  // Read sessionStorage on mount
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

content = content.replace(oldState, newState);

// 3. Update filter logic
const oldFilter = `    // 1. Filter raw movements (which are sorted ASC from DB)
    const filtered = movements.filter(m => {
      if (filterWarehouse && !m.warehouse_name.toLowerCase().includes(filterWarehouse.toLowerCase())) return false`;

const newFilter = `    // 1. Filter raw movements (which are sorted ASC from DB)
    const filtered = movements.filter(m => {
      if (filterWarehouseId && m.warehouse_id !== filterWarehouseId) return false
      else if (!filterWarehouseId && filterWarehouse && !m.warehouse_name.toLowerCase().includes(filterWarehouse.toLowerCase())) return false`;

content = content.replace(oldFilter, newFilter);

// 4. Update warehouse input to clear ID
const oldInput = `<input value={filterWarehouse} onChange={e => setFilterWarehouse(e.target.value)} placeholder="Ej: Principal" className="w-full h-8 px-3 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:ring-1 focus:ring-theme-accent" />`;

const newInput = `<input value={filterWarehouse} onChange={e => { setFilterWarehouse(e.target.value); setFilterWarehouseId(''); setIsFilteredFromStock(false); }} placeholder="Ej: Principal" className="w-full h-8 px-3 rounded-lg border border-theme-border bg-theme-surface text-xs text-theme-text focus:ring-1 focus:ring-theme-accent" />`;

content = content.replace(oldInput, newInput);

// 5. Add Export to Excel function and replace button
const oldClearBtn = `            {hasActiveFilters && (
              <button 
                onClick={() => {
                  setFilterWarehouse(''); setFilterLocation(''); setFilterLot(''); setFilterType(''); setFilterDateFrom(''); setFilterDateTo('')
                }}`;

const newClearBtn = `            {hasActiveFilters && (
              <button 
                onClick={() => {
                  setFilterWarehouse(''); setFilterWarehouseId(''); setFilterLocation(''); setFilterLot(''); setFilterType(''); setFilterDateFrom(''); setFilterDateTo(''); setIsFilteredFromStock(false);
                }}`;
                
content = content.replace(oldClearBtn, newClearBtn);

const oldFilterBar = `        <div className="px-6 py-2 flex items-center justify-between">
          <button 
            onClick={() => setShowFilters(!showFilters)}
            className={cn("text-xs font-bold flex items-center gap-2 px-3 py-1.5 rounded-lg transition-colors", showFilters ? "bg-theme-accent text-white" : "bg-theme-text/5 text-theme-text hover:bg-theme-text/10")}
          >
            <Filter className="w-3.5 h-3.5" />
            {showFilters ? 'Ocultar Filtros' : 'Mostrar Filtros'}
            {hasActiveFilters && <span className="w-2 h-2 rounded-full bg-red-500" />}
          </button>
          
          {hasActiveFilters && (`;

const exportFunc = `
  const handleExportExcel = () => {
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

const newFilterBar = exportFunc + `        <div className="px-6 py-2 flex items-center justify-between">
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

content = content.replace(oldFilterBar, newFilterBar);

fs.writeFileSync(file, content, 'utf8');
