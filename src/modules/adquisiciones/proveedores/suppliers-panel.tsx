'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getSuppliers, createSupplier, updateSupplier, deactivateSupplier, importSuppliers, getBsalePseudoStats, type Supplier, type BsalePseudoStat } from '@/app/actions/adquisiciones/suppliers'
import * as XLSX from 'xlsx'
import { Search, Plus, FileSpreadsheet, Upload, Download, MoreHorizontal, Filter, X, ArrowLeft, Check, AlertCircle, LoaderCircle } from 'lucide-react'
import { PseudoSupplierBsaleSyncStatus } from '@/components/integraciones/bsale-sync-status'
import { BsaleBrandSupplierPanel } from './bsale-brand-supplier-panel'
import { OperationalTableResizeHandle, OperationalTableSortIndicator, sortOperationalRows, useOperationalTableSort, useOperationalTableWidths, type OperationalTableColumn } from '@/components/ui/operational-table'

const REAL_TABLE_KEY = 'mym:table:adquisiciones:proveedores-reales'
const PSEUDO_TABLE_KEY = 'mym:table:adquisiciones:pseudoproveedores'

const REAL_COLUMNS: OperationalTableColumn[] = [
  { id: 'rut', defaultWidth: 135, minWidth: 110, maxWidth: 220, sortable: true, sortKey: 'rut', sortType: 'text' },
  { id: 'business-name', defaultWidth: 280, minWidth: 200, maxWidth: 520, sortable: true, sortKey: 'business_name', sortType: 'text' },
  { id: 'fantasy-name', defaultWidth: 210, minWidth: 150, maxWidth: 400, sortable: true, sortKey: 'fantasy_name', sortType: 'text' },
  { id: 'contact', defaultWidth: 180, minWidth: 130, maxWidth: 320, sortable: true, sortKey: 'contact_name', sortType: 'text' },
  { id: 'email', defaultWidth: 240, minWidth: 170, maxWidth: 400, sortable: true, sortKey: 'contact_email', sortType: 'text' },
  { id: 'payment', defaultWidth: 150, minWidth: 110, maxWidth: 280, sortable: true, sortKey: 'payment_terms', sortType: 'text' },
  { id: 'status', defaultWidth: 110, minWidth: 90, maxWidth: 180, sortable: true, sortKey: 'is_active', sortType: 'number' },
  { id: 'actions', defaultWidth: 165, minWidth: 150, maxWidth: 230, sticky: 'right' },
]

const PSEUDO_COLUMNS: OperationalTableColumn[] = [
  { id: 'display-name', defaultWidth: 280, minWidth: 200, maxWidth: 520, sortable: true, sortKey: 'display_name', sortType: 'text' },
  { id: 'root', defaultWidth: 180, minWidth: 130, maxWidth: 320, sortable: true, sortKey: 'suggested_root', sortType: 'text' },
  { id: 'parent', defaultWidth: 260, minWidth: 180, maxWidth: 460, sortable: true, sortKey: 'parent_supplier_name', sortType: 'text' },
  { id: 'total', defaultWidth: 125, minWidth: 100, maxWidth: 180, sortable: true, sortKey: 'total_products', sortType: 'number' },
  { id: 'active', defaultWidth: 155, minWidth: 120, maxWidth: 220, sortable: true, sortKey: 'active_products', sortType: 'number' },
  { id: 'mappings', defaultWidth: 180, minWidth: 140, maxWidth: 260, sortable: true, sortKey: 'mappings_with_cost', sortType: 'number' },
  { id: 'status', defaultWidth: 230, minWidth: 170, maxWidth: 360 },
]

export function SuppliersPanel({ canManageBsale = false }: { canManageBsale?: boolean }) {
  const [activeTab, setActiveTab] = useState<'REAL' | 'BSALE' | 'BSALE_BRANDS'>('REAL')

  // REAL
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  // BSALE
  const [pseudos, setPseudos] = useState<BsalePseudoStat[]>([])

  const [search, setSearch] = useState('')
  const [filters, setFilters] = useState({ region: '', city: '', is_active: '' })
  const [showFilters, setShowFilters] = useState(false)
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [initialLoading, setInitialLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [message, setMessage] = useState('')

  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; errors: string[]; warnings: string[] } | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const requestSequence = useRef(0)
  const loadedTabs = useRef({ REAL: false, BSALE: false })
  const { widths: realWidths, setColumnWidth: setRealColumnWidth, persist: persistRealWidths, reset: resetRealWidths } = useOperationalTableWidths(REAL_TABLE_KEY, REAL_COLUMNS)
  const { sort: realSort, cycleSort: cycleRealSort } = useOperationalTableSort(REAL_TABLE_KEY, REAL_COLUMNS)
  const { widths: pseudoWidths, setColumnWidth: setPseudoColumnWidth, persist: persistPseudoWidths, reset: resetPseudoWidths } = useOperationalTableWidths(PSEUDO_TABLE_KEY, PSEUDO_COLUMNS)
  const { sort: pseudoSort, cycleSort: cyclePseudoSort } = useOperationalTableSort(PSEUDO_TABLE_KEY, PSEUDO_COLUMNS)

  function tableColumn(columns: OperationalTableColumn[], id: string) { return columns.find(column => column.id === id)! }
  function headerLabel(columns: OperationalTableColumn[], sort: ReturnType<typeof useOperationalTableSort>['sort'], cycleSort: ReturnType<typeof useOperationalTableSort>['cycleSort'], id: string, label: string) {
    const column = tableColumn(columns, id)
    if (!column.sortable) return <span className="truncate">{label}</span>
    const active = sort?.column === id
    return <button type="button" onClick={() => cycleSort(column)} className="group flex min-w-0 items-center gap-1 text-left hover:text-theme-text" title="Ordenar columna"><span className="truncate">{label}</span><OperationalTableSortIndicator active={active} direction={active ? sort?.direction : undefined} /></button>
  }
  function resizeHandle(columns: OperationalTableColumn[], widths: Record<string, number>, setWidth: (column: OperationalTableColumn, width: number) => void, persist: () => void, id: string) {
    const column = tableColumn(columns, id)
    return <OperationalTableResizeHandle column={column} width={widths[id] ?? column.defaultWidth} onResize={width => setWidth(column, width)} onResizeEnd={persist} />
  }

  // Form states
  const [form, setForm] = useState({
    rut: '', business_name: '', fantasy_name: '', business_activity: '',
    contact_name: '', contact_email: '', contact_phone: '', address: '',
    city: '', region: '', payment_terms: '', credit_days: '0', discount_percent: '0', notes: '',
  })

  // Association Checklist states
  const [pseudoSearch, setPseudoSearch] = useState('')
  const [selectedPseudos, setSelectedPseudos] = useState<Set<string>>(new Set())

  const load = useCallback(async () => {
    if (activeTab === 'BSALE_BRANDS') return
    const requestId = ++requestSequence.current
    const tab = activeTab === 'REAL' ? 'REAL' : 'BSALE'
    const isInitialLoad = !loadedTabs.current[tab]
    if (isInitialLoad) setInitialLoading(true)
    else setRefreshing(true)
    try {
      if (activeTab === 'REAL') {
        const data = await getSuppliers(search || undefined, 'REAL')
        if (requestId !== requestSequence.current) return
        setSuppliers(data)
      } else {
        const data = await getBsalePseudoStats()
        const term = search.toLowerCase()
        if (requestId !== requestSequence.current) return
        setPseudos(data.filter(p => !term || p.display_name.toLowerCase().includes(term) || p.business_name.toLowerCase().includes(term) || p.suggested_root.toLowerCase().includes(term)))
      }
      loadedTabs.current[tab] = true
    } catch {
      if (requestId === requestSequence.current) msg('No se pudo actualizar la tabla de proveedores.')
    } finally {
      if (requestId === requestSequence.current) {
        setInitialLoading(false)
        setRefreshing(false)
      }
    }
  }, [search, activeTab])

  useEffect(() => { load() }, [load])

  // Pre-load all pseudos for the form checklist if needed
  const [allPseudos, setAllPseudos] = useState<BsalePseudoStat[]>([])
  const loadAllPseudos = async () => {
    const data = await getBsalePseudoStats()
    setAllPseudos(data)
  }

  const visibleRealSuppliers = useMemo(() => {
    return suppliers.filter(s => s.supplier_kind === 'REAL')
  }, [suppliers])

  const filteredSuppliers = useMemo(() => {
    return visibleRealSuppliers.filter(s => {
      if (filters.region && s.region !== filters.region) return false
      if (filters.city && s.city !== filters.city) return false
      if (filters.is_active === 'true' && !s.is_active) return false
      if (filters.is_active === 'false' && s.is_active) return false
      return true
    })
  }, [visibleRealSuppliers, filters])

  const sortedSuppliers = useMemo(() => sortOperationalRows(filteredSuppliers, realSort, REAL_COLUMNS, (supplier, key) => supplier[key as keyof Supplier]), [filteredSuppliers, realSort])

  useEffect(() => {
    console.log('[SuppliersPanel]', {
      activeTab,
      realSuppliersLength: suppliers.length,
      visibleRealSuppliersLength: visibleRealSuppliers.length,
      pseudoSuppliersLength: pseudos.length,
    })
  }, [activeTab, suppliers, visibleRealSuppliers, pseudos])

  const uniqueRegions = useMemo(() => Array.from(new Set(visibleRealSuppliers.map(s => s.region).filter(Boolean))), [visibleRealSuppliers])
  const uniqueCities = useMemo(() => Array.from(new Set(visibleRealSuppliers.map(s => s.city).filter(Boolean))), [visibleRealSuppliers])

  const sortedPseudos = useMemo(() => sortOperationalRows(pseudos, pseudoSort, PSEUDO_COLUMNS, (pseudo, key) => pseudo[key as keyof BsalePseudoStat]), [pseudos, pseudoSort])

  const filteredFormPseudos = useMemo(() => {
    let list = allPseudos
    const t = pseudoSearch.toLowerCase()
    if (t) {
      list = list.filter(p => p.display_name.toLowerCase().includes(t) || p.suggested_root.toLowerCase().includes(t))
    }
    // Always show selected, then group by remanente vs normal
    return list.sort((a, b) => {
      const aSel = selectedPseudos.has(a.id) ? 1 : 0
      const bSel = selectedPseudos.has(b.id) ? 1 : 0
      if (aSel !== bSel) return bSel - aSel
      const aRem = a.total_products === 0 ? 1 : 0
      const bRem = b.total_products === 0 ? 1 : 0
      if (aRem !== bRem) return aRem - bRem
      return a.display_name.localeCompare(b.display_name)
    })
  }, [allPseudos, pseudoSearch, selectedPseudos])

  function exportToExcel(rows: Supplier[], label: string) {
    const headers = [
      'rut', 'razon_social', 'nombre_fantasia', 'giro', 'contacto', 'correo',
      'telefono', 'direccion', 'ciudad', 'region', 'condicion_pago',
      'dias_credito', 'descuento_porcentaje', 'observacion', 'estado'
    ]
    const data = rows.map(r => ({
      rut: r.rut || '', razon_social: r.business_name, nombre_fantasia: r.fantasy_name || '',
      giro: r.business_activity || '', contacto: r.contact_name || '', correo: r.contact_email || '',
      telefono: r.contact_phone || '', direccion: r.address || '', ciudad: r.city || '',
      region: r.region || '', condicion_pago: r.payment_terms || '', dias_credito: r.credit_days,
      descuento_porcentaje: r.discount_percent, observacion: r.notes || '', estado: r.is_active ? 'Activo' : 'Inactivo'
    }))
    const ws = XLSX.utils.json_to_sheet(data, { header: headers })
    ws['!cols'] = headers.map(() => ({ wch: 22 }))
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Proveedores')
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    XLSX.writeFile(wb, `proveedores_mym_${label}_${date}.xlsx`)
    setShowExportMenu(false)
  }

  function downloadTemplate() {
    const headers = [
      'rut', 'razon_social', 'nombre_fantasia', 'giro', 'contacto', 'correo',
      'telefono', 'direccion', 'ciudad', 'region', 'condicion_pago',
      'dias_credito', 'descuento_porcentaje', 'observacion',
    ]
    const example = {
      rut: '76.123.456-7',
      razon_social: 'Distribuidora de Alimentos Ltda.',
      nombre_fantasia: 'Alimentos Premium',
      giro: 'Venta al por mayor de alimentos para mascotas',
      contacto: 'Juan Pérez',
      correo: 'jperez@ejemplo.cl',
      telefono: '+56 9 1234 5678',
      direccion: 'Av. Principal 1234',
      ciudad: 'Santiago',
      region: 'Región Metropolitana',
      condicion_pago: '30 días',
      dias_credito: 30,
      descuento_porcentaje: 5,
      observacion: 'Proveedor con descuento por volumen',
    }
    const ws = XLSX.utils.json_to_sheet([example], { header: headers })
    ws['!cols'] = headers.map(() => ({ wch: 22 }))
    ws['!rows'] = [{ hpx: 28 }]
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Proveedores')
    XLSX.writeFile(wb, 'plantilla_proveedores_mym.xlsx')
  }

  function msg(text: string) { setMessage(text); setTimeout(() => setMessage(''), 3500) }

  function resetForm() {
    setForm({ rut: '', business_name: '', fantasy_name: '', business_activity: '', contact_name: '', contact_email: '', contact_phone: '', address: '', city: '', region: '', payment_terms: '', credit_days: '0', discount_percent: '0', notes: '' })
    setEditId(null)
    setSelectedPseudos(new Set())
    setPseudoSearch('')
  }

  async function openCreate() {
    resetForm()
    await loadAllPseudos()
    setShowForm(true)
  }

  async function openEdit(s: Supplier) {
    setForm({
      rut: s.rut ?? '', business_name: s.business_name, fantasy_name: s.fantasy_name ?? '',
      business_activity: s.business_activity ?? '', contact_name: s.contact_name ?? '',
      contact_email: s.contact_email ?? '', contact_phone: s.contact_phone ?? '',
      address: s.address ?? '', city: s.city ?? '', region: s.region ?? '',
      payment_terms: s.payment_terms ?? '', credit_days: String(s.credit_days),
      discount_percent: String(s.discount_percent), notes: s.notes ?? '',
    })
    setEditId(s.id)
    const stats = await getBsalePseudoStats()
    setAllPseudos(stats)
    const sel = new Set<string>()
    stats.forEach(p => {
      if (p.parent_supplier_id === s.id) sel.add(p.id)
    })
    setSelectedPseudos(sel)
    setShowForm(true)
  }

  function togglePseudo(p: BsalePseudoStat) {
    const next = new Set(selectedPseudos)
    if (next.has(p.id)) {
      next.delete(p.id)
      setSelectedPseudos(next)
    } else {
      if (p.parent_supplier_id && p.parent_supplier_id !== editId) {
        if (!confirm(`El pseudoproveedor "${p.display_name}" ya está asociado a "${p.parent_supplier_name}". ¿Deseas reasignarlo a este proveedor?`)) {
          return
        }
      }
      next.add(p.id)
      setSelectedPseudos(next)
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const fd = new FormData()
    Object.entries(form).forEach(([k, v]) => fd.set(k, v))
    const ids = Array.from(selectedPseudos)

    if (editId) {
      const res = await updateSupplier(editId, fd, ids)
      if (res.error) { msg(res.error); return }
      msg('Proveedor actualizado exitosamente con sus asociaciones')
    } else {
      const res = await createSupplier(fd, ids)
      if (res.error) { msg(res.error); return }
      msg('Proveedor real y asociaciones guardados con éxito')
    }
    setShowForm(false)
    resetForm()
    load()
  }

  async function handleDeactivate(s: Supplier) {
    if (!confirm(`¿Desactivar proveedor "${s.business_name}"?`)) return
    const res = await deactivateSupplier(s.id)
    if (res.error) { msg(res.error); return }
    msg(res.newActive ? 'Proveedor activado' : 'Proveedor desactivado')
    load()
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer)
      const workbook = XLSX.read(data, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
      const errors: string[] = []
      const warnings: string[] = []
      function normalizeRut(r: string) { return r.replace(/[.-]/g, '').replace(/\s/g, '').toUpperCase() }
      const seenRuts = new Set<string>()
      const validRows: Record<string, unknown>[] = []

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]
        const rut = String(row.rut ?? '').trim()
        const bname = String(row.razon_social ?? '').trim()
        if (!rut && !bname) continue
        const rutNorm = rut ? normalizeRut(rut) : ''
        if (rutNorm && seenRuts.has(rutNorm)) { errors.push(`Fila ${i + 1}: RUT ${rut} duplicado en el archivo`); continue }
        if (rutNorm) seenRuts.add(rutNorm)
        validRows.push({
          rut, razon_social: bname,
          nombre_fantasia: String(row.nombre_fantasia ?? '').trim(),
          giro: String(row.giro ?? '').trim(),
          contacto: String(row.contacto ?? '').trim(),
          correo: String(row.correo ?? '').trim(),
          telefono: String(row.telefono ?? '').trim(),
          direccion: String(row.direccion ?? '').trim(),
          ciudad: String(row.ciudad ?? '').trim(),
          region: String(row.region ?? '').trim(),
          condicion_pago: String(row.condicion_pago ?? '').trim(),
          dias_credito: Number(row.dias_credito || 0),
          descuento_porcentaje: Number(row.descuento_porcentaje || 0),
          observacion: String(row.observacion ?? '').trim(),
        })
      }

      if (errors.length > 0) {
        setPreview({ rows: [], errors, warnings })
        return
      }
      setPreview({ rows: validRows, errors: [], warnings })
    }
    reader.readAsArrayBuffer(file)
  }

  async function handleImportConfirm() {
    if (!preview || preview.errors.length > 0) return
    const cleanRows = preview.rows.map(row => ({
      rut: String(row.rut ?? '').trim(),
      razon_social: String(row.razon_social ?? '').trim(),
      nombre_fantasia: String(row.nombre_fantasia ?? '').trim(),
      giro: String(row.giro ?? '').trim(),
      contacto: String(row.contacto ?? '').trim(),
      correo: String(row.correo ?? '').trim(),
      telefono: String(row.telefono ?? '').trim(),
      direccion: String(row.direccion ?? '').trim(),
      ciudad: String(row.ciudad ?? '').trim(),
      region: String(row.region ?? '').trim(),
      condicion_pago: String(row.condicion_pago ?? '').trim(),
      dias_credito: Number(row.dias_credito || 0),
      descuento_porcentaje: Number(row.descuento_porcentaje || 0),
      observacion: String(row.observacion ?? '').trim(),
    }))
    const res = await importSuppliers(cleanRows)
    if ('error' in res && typeof res.error === 'string') { msg(res.error); return }
    setPreview(null)
    msg(`${res.created} proveedores importados${res.errors.length > 0 ? `, ${res.errors.length} errores` : ''}`)
    load()
  }

  if (showForm) {
    return (
      <div className="flex h-full flex-col overflow-hidden bg-[#EFE9E1] animate-in fade-in zoom-in-95 duration-200">
        <form onSubmit={handleSubmit} className="flex-1 overflow-auto">
          <div className="sticky top-0 z-10 flex flex-wrap items-center justify-between gap-3 border-b border-[#AC9C8D]/35 bg-[#322D29] px-4 py-2 sm:px-6">
            <div className="flex min-w-0 items-center gap-2.5">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="rounded-md p-1.5 text-[#D1C7BD] transition-colors hover:bg-white/10 hover:text-[#EFE9E1]">
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0">
                <p className="text-[9px] font-semibold uppercase tracking-[0.18em] text-[#AC9C8D]">Proveedores</p>
                <h2 className="truncate text-sm font-bold uppercase tracking-wide text-[#EFE9E1]">{editId ? 'Editar proveedor real' : 'Nuevo proveedor real'}</h2>
              </div>
            </div>
            <div className="flex w-full flex-wrap gap-1.5 sm:w-auto">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="flex-1 rounded-md px-3 py-1.5 text-xs font-semibold text-[#D1C7BD] transition-colors hover:bg-white/10 hover:text-[#EFE9E1] sm:flex-none">
                Cancelar
              </button>
              <button type="submit" className="flex-1 rounded-md bg-[#72383D] px-4 py-1.5 text-xs font-bold text-[#EFE9E1] transition-colors hover:bg-[#5D2E32] sm:flex-none">
                Guardar Proveedor
              </button>
            </div>
          </div>
          <div className="px-4 py-4 sm:px-6 sm:py-5">
            <div className="mx-auto max-w-7xl space-y-5">
              
              <div className="border-b border-[#D1C7BD] pb-4">
                <div className="mb-3 border-b border-[#D1C7BD] pb-2">
                  <h3 className="text-sm font-bold uppercase tracking-wide text-[#322D29]">Datos legales y comerciales</h3>
                  <p className="mt-0.5 text-[10px] text-[#AC9C8D]">Información principal del proveedor real.</p>
                </div>
                <div className="grid grid-cols-1 gap-x-4 gap-y-2.5 md:grid-cols-2 xl:grid-cols-4">
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">RUT</label>
                    <input type="text" value={form.rut} onChange={e => setForm(p => ({ ...p, rut: e.target.value }))}
                      disabled={!!editId}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] disabled:cursor-not-allowed disabled:bg-[#D1C7BD]/35 disabled:text-[#AC9C8D] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Razón social *</label>
                    <input type="text" value={form.business_name} onChange={e => setForm(p => ({ ...p, business_name: e.target.value }))} required
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Nombre fantasía</label>
                    <input type="text" value={form.fantasy_name} onChange={e => setForm(p => ({ ...p, fantasy_name: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Giro</label>
                    <input type="text" value={form.business_activity} onChange={e => setForm(p => ({ ...p, business_activity: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Contacto</label>
                    <input type="text" value={form.contact_name} onChange={e => setForm(p => ({ ...p, contact_name: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Correo</label>
                    <input type="email" value={form.contact_email} onChange={e => setForm(p => ({ ...p, contact_email: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Teléfono</label>
                    <input type="text" value={form.contact_phone} onChange={e => setForm(p => ({ ...p, contact_phone: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Condición de pago</label>
                    <input type="text" value={form.payment_terms} onChange={e => setForm(p => ({ ...p, payment_terms: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Días crédito</label>
                    <input type="number" min="0" value={form.credit_days} onChange={e => setForm(p => ({ ...p, credit_days: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Descuento %</label>
                    <input type="number" min="0" max="100" step="0.01" value={form.discount_percent} onChange={e => setForm(p => ({ ...p, discount_percent: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Ciudad</label>
                    <input type="text" value={form.city} onChange={e => setForm(p => ({ ...p, city: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Región</label>
                    <input type="text" value={form.region} onChange={e => setForm(p => ({ ...p, region: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="col-span-1 space-y-1 md:col-span-2 xl:col-span-4">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Dirección</label>
                    <input type="text" value={form.address} onChange={e => setForm(p => ({ ...p, address: e.target.value }))}
                      className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                  <div className="col-span-1 space-y-1 md:col-span-2 xl:col-span-4">
                    <label className="text-[10px] font-semibold text-[#6D625B]">Observaciones</label>
                    <textarea value={form.notes} onChange={e => setForm(p => ({ ...p, notes: e.target.value }))} rows={3}
                      className="h-14 w-full resize-none rounded-md border border-[#D1C7BD] bg-[#F7F4F0] px-2.5 py-1.5 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                  </div>
                </div>
              </div>

              {/* Sección de Asociación Bsale */}
              <div className="border-b border-[#D1C7BD] pb-4">
                <div className="mb-3 flex items-end justify-between gap-3 border-b border-[#D1C7BD] pb-2">
                  <div>
                    <h3 className="text-sm font-bold uppercase tracking-wide text-[#322D29]">Asociar pseudoproveedores Bsale</h3>
                    <p className="mt-0.5 text-[10px] text-[#AC9C8D]">Selecciona qué orígenes operativos de Bsale pertenecen a esta entidad legal.</p>
                  </div>
                  <div className="shrink-0 border border-[#72383D]/30 bg-[#F5EDEE] px-2.5 py-1 text-[10px] font-semibold text-[#72383D]">
                    {selectedPseudos.size} seleccionados
                  </div>
                </div>
                
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#AC9C8D]" />
                  <input type="text" value={pseudoSearch} onChange={e => setPseudoSearch(e.target.value)}
                    placeholder="Filtrar por nombre o raíz sugerida..."
                    className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] pl-8 pr-3 text-xs text-[#322D29] focus:border-[#72383D] focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
                </div>

                <div className="mt-3 overflow-hidden border border-[#D1C7BD] bg-white">
                  <div className="max-h-96 overflow-x-auto overflow-y-auto">
                    <table className="w-full min-w-[760px] text-left text-xs">
                      <thead className="sticky top-0 z-10 bg-[#322D29]">
                        <tr>
                          <th className="w-10 border-r border-[#AC9C8D]/35 px-3 py-1.5 font-semibold text-[#EFE9E1]"></th>
                          <th className="border-r border-[#AC9C8D]/35 px-3 py-1.5 font-semibold text-[#EFE9E1]">Nombre Bsale</th>
                          <th className="border-r border-[#AC9C8D]/35 px-3 py-1.5 font-semibold text-[#EFE9E1]">Raíz</th>
                          <th className="border-r border-[#AC9C8D]/35 px-3 py-1.5 text-right font-semibold text-[#EFE9E1]">Productos</th>
                          <th className="px-3 py-1.5 font-semibold text-[#EFE9E1]">Estado Actual</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#E5DDD4] bg-white">
                        {filteredFormPseudos.map(p => {
                          const isSelected = selectedPseudos.has(p.id)
                          const isRemnant = p.total_products === 0
                          const hasOtherParent = p.parent_supplier_id !== null && p.parent_supplier_id !== editId
                          
                          return (
                            <tr key={p.id} className={`cursor-pointer transition-colors hover:bg-[#F3EFE9] ${isSelected ? 'bg-[#F5EDEE]' : ''}`}
                                onClick={() => togglePseudo(p)}>
                              <td className="w-10 px-3 py-1.5">
                                <div className={`flex h-3.5 w-3.5 items-center justify-center rounded-sm border transition-colors ${isSelected ? 'border-[#72383D] bg-[#72383D]' : 'border-[#D1C7BD] bg-[#F7F4F0]'}`}>
                                  {isSelected && <Check className="w-3 h-3 text-white" />}
                                </div>
                              </td>
                              <td className="px-3 py-1.5 font-medium text-[#322D29]">
                                {p.display_name}
                                {isRemnant && <span className="ml-2 rounded border border-[#D1C7BD] bg-[#EFE9E1] px-1.5 py-0.5 text-[10px] text-[#6D625B]">Remanente</span>}
                              </td>
                              <td className="px-3 py-1.5 text-[#6D625B]">{p.suggested_root}</td>
                              <td className="px-3 py-1.5 text-right font-mono text-[#322D29]">{p.total_products}</td>
                              <td className="px-3 py-1.5">
                                {hasOtherParent ? (
                                  <span className="flex items-center gap-1 text-[11px] font-semibold text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded w-fit">
                                    <AlertCircle className="w-3 h-3" /> Asociado a {p.parent_supplier_name}
                                  </span>
                                ) : (p.parent_supplier_id !== null && p.parent_supplier_id === editId) ? (
                                    <span className="w-fit rounded border border-[#72383D]/20 bg-[#F5EDEE] px-2 py-0.5 text-[11px] font-semibold text-[#72383D]">
                                    Asociado actual
                                  </span>
                                ) : isRemnant ? (
                                    <span className="w-fit rounded border border-[#D1C7BD] bg-[#EFE9E1] px-2 py-0.5 text-[11px] font-medium text-[#6D625B]">
                                    Remanente sin productos
                                  </span>
                                ) : (
                                    <span className="w-fit rounded border border-[#D1C7BD] bg-[#EFE9E1] px-2 py-0.5 text-[11px] font-medium text-[#6D625B]">
                                    Sin asociar
                                  </span>
                                )}
                              </td>
                            </tr>
                          )
                        })}
                        {filteredFormPseudos.length === 0 && (
                          <tr><td colSpan={5} className="py-8 text-center text-theme-text-muted/50">No se encontraron pseudoproveedores</td></tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

              </div>
            </div>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-w-0 flex-col overflow-hidden bg-[#EFE9E1]">
      {message && (
        <div className="shrink-0 border-b border-[#D1C7BD] bg-[#F5EDEE] px-4 py-2 text-sm text-[#72383D]">{message}</div>
      )}

      {/* TABS */}
      <div className="shrink-0 flex items-center overflow-x-auto border-b border-[#D1C7BD] bg-[#EFE9E1] px-3 pt-1">
        <button onClick={() => { setActiveTab('REAL'); setSearch('') }} className={`border-b-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-all ${activeTab === 'REAL' ? 'border-[#72383D] bg-[#72383D] text-[#EFE9E1]' : 'border-transparent text-[#AC9C8D] hover:text-[#322D29]'}`}>
          Proveedores Reales
        </button>
        <button onClick={() => { setActiveTab('BSALE'); setSearch('') }} className={`border-b-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-all ${activeTab === 'BSALE' ? 'border-[#72383D] bg-[#72383D] text-[#EFE9E1]' : 'border-transparent text-[#AC9C8D] hover:text-[#322D29]'}`}>
          Pseudoproveedores Bsale
        </button>
        <button onClick={() => { setActiveTab('BSALE_BRANDS'); setSearch('') }} className={`border-b-2 px-3 py-1.5 text-xs font-bold uppercase tracking-wide transition-all ${activeTab === 'BSALE_BRANDS' ? 'border-[#72383D] bg-[#72383D] text-[#EFE9E1]' : 'border-transparent text-[#AC9C8D] hover:text-[#322D29]'}`}>
          Proveedor en Bsale
        </button>
      </div>

      <div className={`shrink-0 flex flex-col gap-2 border-b border-[#D1C7BD] bg-[#EFE9E1] px-3 py-2 ${activeTab === 'BSALE_BRANDS' ? 'hidden' : ''}`}>
        
        {activeTab === 'BSALE' && (
          <div className="flex w-full">
            <PseudoSupplierBsaleSyncStatus />
          </div>
        )}

        <div className="flex flex-col md:flex-row items-center gap-2 w-full">
          <div className="relative flex-1 w-full">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[#AC9C8D]" />
            <input type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder={activeTab === 'REAL' ? "Buscar reales por RUT o razón social..." : "Buscar pseudos por nombre o raíz..."}
              className="h-8 w-full rounded-md border border-[#D1C7BD] bg-[#F7F4F0] pl-8 pr-3 text-xs text-[#322D29] placeholder:text-[#AC9C8D] transition-all focus:border-[#72383D] focus:bg-white focus:outline-none focus:ring-2 focus:ring-[#72383D]/15" />
          </div>

          <div className="flex items-center gap-1.5 w-full md:w-auto">
            {activeTab === 'REAL' && (
              <>
                <div className="relative group z-10">
                  <button className="flex h-8 items-center justify-center gap-1.5 rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-2.5 text-xs font-semibold text-[#6D625B] transition-all hover:bg-[#D1C7BD]/40 hover:text-[#322D29]">
                    <MoreHorizontal className="w-4 h-4" />
                    <span className="hidden md:inline">Opciones</span>
                  </button>
                  <div className="absolute right-0 top-full mt-2 w-56 bg-theme-surface backdrop-blur-xl border border-theme-border rounded-2xl shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 p-2">
                    <button onClick={downloadTemplate} className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors flex items-center gap-2">
                      <FileSpreadsheet className="w-4 h-4" /> Descargar plantilla
                    </button>
                    <label className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors flex items-center gap-2 cursor-pointer">
                      <Upload className="w-4 h-4" /> Importar Excel
                      <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleFileUpload} className="hidden" />
                    </label>
                    <button type="button" onClick={resetRealWidths} className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Restablecer ancho de columnas</button>
                    <div className="h-px bg-theme-border my-1" />
                    <div className="w-full text-left px-3 py-2 text-[10px] font-bold text-theme-text-muted/50 uppercase tracking-wider">Exportar</div>
                    <button onClick={() => exportToExcel(suppliers, 'todos_reales')} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Todos los proveedores</button>
                    <button onClick={() => exportToExcel(filteredSuppliers, 'filtrados_reales')} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Proveedores filtrados</button>
                  </div>
                </div>

                  <button onClick={() => setShowFilters(!showFilters)} className={`flex h-8 items-center justify-center gap-1.5 rounded-md border px-2.5 text-xs font-semibold transition-all ${showFilters ? 'border-[#72383D]/40 bg-[#72383D]/10 text-[#72383D]' : 'border-[#D1C7BD] bg-[#EFE9E1] text-[#6D625B] hover:bg-[#D1C7BD]/40 hover:text-[#322D29]'}`}>
                  <Filter className="w-4 h-4" />
                  <span className="hidden md:inline">Filtros</span>
                </button>

                <button onClick={openCreate} className="ml-auto flex h-8 items-center justify-center gap-1.5 rounded-md bg-[#72383D] px-3 text-xs font-bold text-[#EFE9E1] transition-all hover:bg-[#5D2E32] md:ml-0">
                  <Plus className="w-4 h-4" />
                  <span className="hidden sm:inline">Nuevo</span>
                </button>
              </>
            )}
            {activeTab === 'BSALE' && <button type="button" onClick={resetPseudoWidths} className="h-8 rounded-md border border-[#D1C7BD] bg-[#EFE9E1] px-2.5 text-[11px] font-semibold text-[#6D625B] hover:bg-[#D1C7BD]/40 hover:text-[#322D29]">Restablecer anchos</button>}
          </div>
        </div>

        {activeTab === 'REAL' && showFilters && (
          <div className="border-t border-[#D1C7BD] pt-2 animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between mb-3">
              <h4 className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#AC9C8D]">Filtros avanzados</h4>
              <button onClick={() => setFilters({ region: '', city: '', is_active: '' })} className="text-xs font-semibold text-theme-text-accent hover:text-theme-text flex items-center gap-1 transition-colors">
                <X className="w-3 h-3" /> Limpiar filtros
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <select value={filters.region} onChange={e => setFilters(p => ({...p, region: e.target.value}))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Todas las regiones</option>
                {uniqueRegions.map(r => <option key={String(r)} value={String(r)}>{String(r)}</option>)}
              </select>
              <select value={filters.city} onChange={e => setFilters(p => ({...p, city: e.target.value}))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Todas las ciudades</option>
                {uniqueCities.map(c => <option key={String(c)} value={String(c)}>{String(c)}</option>)}
              </select>
              <select value={filters.is_active} onChange={e => setFilters(p => ({...p, is_active: e.target.value}))} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Estado (Todos)</option>
                <option value="true">Activos</option>
                <option value="false">Inactivos</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {activeTab === 'REAL' && preview && (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-5 space-y-4 m-5 mb-0">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-theme-text">Vista previa - {preview.rows.length} filas válidas</h3>
            <div className="flex gap-2">
              <button onClick={() => setPreview(null)} className="px-3 py-1.5 rounded-lg border border-theme-border text-xs text-theme-text-muted/70 hover:text-theme-text">Cancelar</button>
              {preview.errors.length === 0 && preview.rows.length > 0 && (
                <button onClick={handleImportConfirm} className="px-3 py-1.5 rounded-lg bg-theme-accent text-xs text-white font-semibold hover:bg-theme-accent-hover">Confirmar importación</button>
              )}
            </div>
          </div>
          {preview.errors.length > 0 && (
            <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 space-y-1">
              {preview.errors.map((e, i) => <p key={i} className="text-xs text-red-400">{e}</p>)}
            </div>
          )}
        </div>
      )}

      {refreshing && activeTab !== 'BSALE_BRANDS' && <div role="status" aria-live="polite" className="pointer-events-none absolute left-1/2 top-20 z-50 inline-flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-theme-border bg-theme-surface/95 px-3 py-1.5 text-[11px] font-semibold text-theme-text-muted shadow-md"><LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin text-theme-accent" />Actualizando...</div>}
      {activeTab === 'BSALE_BRANDS' ? <BsaleBrandSupplierPanel canWrite={canManageBsale} /> : initialLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-theme-text-muted/50 text-sm font-medium">Cargando...</p>
        </div>
      ) : activeTab === 'REAL' ? (
        filteredSuppliers.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-10 text-center animate-in fade-in">
            <div className="w-16 h-16 rounded-2xl bg-theme-text/5 border border-theme-border flex items-center justify-center mb-4">
              <FileSpreadsheet className="w-8 h-8 text-theme-text-muted/40" />
            </div>
            <h3 className="text-base font-bold text-theme-text mb-1">Aún no existen proveedores reales</h3>
            <p className="text-sm text-theme-text-muted/70 max-w-sm mb-6">Crea un proveedor real (legal) y asóciale los pseudoproveedores operativos de Bsale para unificar su catálogo.</p>
            <button onClick={openCreate} className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold shadow-lg shadow-theme-accent/20">
              Crear Proveedor Real
            </button>
          </div>
        ) : (
           <div className="min-w-0 flex-1 overflow-x-auto overflow-y-auto bg-white">
             <table className="min-w-[1450px] w-full table-fixed whitespace-nowrap text-sm border-collapse">
              <colgroup>{REAL_COLUMNS.map(column => <col key={column.id} style={{ width: realWidths[column.id] ?? column.defaultWidth }} />)}</colgroup>
               <thead className="sticky top-0 z-10 bg-[#322D29]">
                 <tr className="border-b border-[#AC9C8D]/35 text-[9px] uppercase tracking-[0.1em] text-[#EFE9E1]">
                   <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left font-semibold">{headerLabel(REAL_COLUMNS, realSort, cycleRealSort, 'rut', 'RUT')}{resizeHandle(REAL_COLUMNS, realWidths, setRealColumnWidth, persistRealWidths, 'rut')}</th>
                   <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left font-semibold">{headerLabel(REAL_COLUMNS, realSort, cycleRealSort, 'business-name', 'Razón social')}{resizeHandle(REAL_COLUMNS, realWidths, setRealColumnWidth, persistRealWidths, 'business-name')}</th>
                   <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left font-semibold">{headerLabel(REAL_COLUMNS, realSort, cycleRealSort, 'fantasy-name', 'Nombre fantasía')}{resizeHandle(REAL_COLUMNS, realWidths, setRealColumnWidth, persistRealWidths, 'fantasy-name')}</th>
                   <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left font-semibold">{headerLabel(REAL_COLUMNS, realSort, cycleRealSort, 'contact', 'Contacto')}{resizeHandle(REAL_COLUMNS, realWidths, setRealColumnWidth, persistRealWidths, 'contact')}</th>
                   <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left font-semibold">{headerLabel(REAL_COLUMNS, realSort, cycleRealSort, 'email', 'Correo')}{resizeHandle(REAL_COLUMNS, realWidths, setRealColumnWidth, persistRealWidths, 'email')}</th>
                   <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left font-semibold">{headerLabel(REAL_COLUMNS, realSort, cycleRealSort, 'payment', 'Cond. pago')}{resizeHandle(REAL_COLUMNS, realWidths, setRealColumnWidth, persistRealWidths, 'payment')}</th>
                   <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left font-semibold">{headerLabel(REAL_COLUMNS, realSort, cycleRealSort, 'status', 'Estado')}{resizeHandle(REAL_COLUMNS, realWidths, setRealColumnWidth, persistRealWidths, 'status')}</th>
                   <th className="sticky right-0 z-30 border-l border-[#D1C7BD] bg-[#322D29] px-3 py-1.5 text-right font-semibold">Acciones</th>
                </tr>
              </thead>
               <tbody className="bg-white">
                {sortedSuppliers.map(s => (
                  <tr key={s.id} onDoubleClick={event => { if (!(event.target instanceof Element && event.target.closest('button, input, select, textarea, a'))) openEdit(s) }} className="border-b border-[#E5DDD4] transition-colors hover:bg-[#F3EFE9]">
                    <td className="truncate px-3 py-1.5 font-mono text-xs text-[#6D625B]" title={s.rut || undefined}>{s.rut || '—'}</td>
                    <td className="truncate px-3 py-1.5 text-xs font-medium text-[#322D29]" title={s.business_name}>{s.business_name}</td>
                    <td className="truncate px-3 py-1.5 text-xs text-[#6D625B]" title={s.fantasy_name || undefined}>{s.fantasy_name || '—'}</td>
                    <td className="truncate px-3 py-1.5 text-xs text-[#6D625B]" title={s.contact_name || undefined}>{s.contact_name || '—'}</td>
                    <td className="truncate px-3 py-1.5 text-xs text-[#AC9C8D]" title={s.contact_email || undefined}>{s.contact_email || '—'}</td>
                    <td className="truncate px-3 py-1.5 text-xs text-[#6D625B]" title={s.payment_terms || undefined}>{s.payment_terms || '—'}</td>
                    <td className="py-2.5 px-4">
                      {s.is_active ? (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-theme-accent-hover/10 text-theme-accent border-theme-accent/20">Activo</span>
                      ) : (
                        <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-red-500/10 text-red-400 border-red-500/20">Inactivo</span>
                      )}
                    </td>
                    <td className="sticky right-0 z-20 border-l border-[#D1C7BD] bg-white px-3 py-1.5 text-right">
                      <button onClick={() => openEdit(s)} className="text-xs text-theme-accent/70 hover:text-theme-text-muted mr-3 font-semibold">Editar</button>
                      <button onClick={() => handleDeactivate(s)}
                        className={`text-xs font-semibold ${s.is_active ? 'text-red-400/70 hover:text-red-400' : 'text-theme-accent/70 hover:text-theme-text-muted'}`}>
                        {s.is_active ? 'Desactivar' : 'Activar'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
         <div className="min-w-0 flex-1 overflow-x-auto overflow-y-auto bg-white">
          <table className="min-w-[1400px] w-full table-fixed text-sm border-collapse">
            <colgroup>{PSEUDO_COLUMNS.map(column => <col key={column.id} style={{ width: pseudoWidths[column.id] ?? column.defaultWidth }} />)}</colgroup>
             <thead className="sticky top-0 z-10 bg-[#322D29]">
               <tr className="border-b border-[#AC9C8D]/35 text-[9px] font-semibold uppercase tracking-[0.1em] text-[#EFE9E1]">
                 <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left">{headerLabel(PSEUDO_COLUMNS, pseudoSort, cyclePseudoSort, 'display-name', 'Pseudoproveedor Bsale')}{resizeHandle(PSEUDO_COLUMNS, pseudoWidths, setPseudoColumnWidth, persistPseudoWidths, 'display-name')}</th>
                 <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left">{headerLabel(PSEUDO_COLUMNS, pseudoSort, cyclePseudoSort, 'root', 'Raíz Sugerida')}{resizeHandle(PSEUDO_COLUMNS, pseudoWidths, setPseudoColumnWidth, persistPseudoWidths, 'root')}</th>
                 <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-left">{headerLabel(PSEUDO_COLUMNS, pseudoSort, cyclePseudoSort, 'parent', 'Proveedor Real Asociado')}{resizeHandle(PSEUDO_COLUMNS, pseudoWidths, setPseudoColumnWidth, persistPseudoWidths, 'parent')}</th>
                 <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-right">{headerLabel(PSEUDO_COLUMNS, pseudoSort, cyclePseudoSort, 'total', 'Productos Totales')}{resizeHandle(PSEUDO_COLUMNS, pseudoWidths, setPseudoColumnWidth, persistPseudoWidths, 'total')}</th>
                 <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-right">{headerLabel(PSEUDO_COLUMNS, pseudoSort, cyclePseudoSort, 'active', 'Activos / Inactivos')}{resizeHandle(PSEUDO_COLUMNS, pseudoWidths, setPseudoColumnWidth, persistPseudoWidths, 'active')}</th>
                 <th className="relative border-r border-[#AC9C8D]/35 px-3 py-1.5 text-right">{headerLabel(PSEUDO_COLUMNS, pseudoSort, cyclePseudoSort, 'mappings', 'Mappings C / S Costo')}{resizeHandle(PSEUDO_COLUMNS, pseudoWidths, setPseudoColumnWidth, persistPseudoWidths, 'mappings')}</th>
                 <th className="relative px-3 py-1.5 text-left">{headerLabel(PSEUDO_COLUMNS, pseudoSort, cyclePseudoSort, 'status', 'Estado')}{resizeHandle(PSEUDO_COLUMNS, pseudoWidths, setPseudoColumnWidth, persistPseudoWidths, 'status')}</th>
              </tr>
            </thead>
               <tbody className="divide-y divide-[#E5DDD4] bg-white">
              {sortedPseudos.map(p => {
                const isRemnant = p.total_products === 0
                return (
                  <tr key={p.id} className="transition-colors hover:bg-[#F3EFE9]">
                    <td className="truncate px-3 py-1.5 text-xs font-medium text-[#322D29]" title={`${p.display_name}${p.display_name !== p.business_name ? ` · ${p.business_name}` : ''}`}>
                      {p.display_name}
                      {p.display_name !== p.business_name && (
                        <div className="text-[10px] text-theme-text-muted/60 font-mono mt-0.5">{p.business_name}</div>
                      )}
                    </td>
                    <td className="truncate px-3 py-1.5 font-mono text-xs text-[#6D625B]" title={p.suggested_root}>{p.suggested_root}</td>
                      <td className="truncate px-3 py-1.5">
                      {p.parent_supplier_name ? (
                        <span className="text-xs font-semibold text-theme-text-accent bg-theme-accent/5 px-2 py-1 rounded border border-theme-accent/10">
                          {p.parent_supplier_name}
                        </span>
                      ) : (
                        <span className="text-xs text-theme-text-muted/50 italic">—</span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right font-mono text-xs text-[#322D29]">{p.total_products}</td>
                    <td className="px-3 py-1.5 text-right text-xs">
                      <span className="text-emerald-500/80 font-mono">{p.active_products}</span>
                      <span className="text-theme-text-muted/30 mx-1">/</span>
                      <span className="text-theme-text-muted/80 font-mono">{p.inactive_products}</span>
                    </td>
                    <td className="px-3 py-1.5 text-right text-xs">
                      <span className="text-emerald-500/80 font-mono">{p.mappings_with_cost}</span>
                      <span className="text-theme-text-muted/30 mx-1">/</span>
                      <span className="text-theme-text-muted/80 font-mono">{p.mappings_without_cost}</span>
                    </td>
                    <td className="px-3 py-1.5">
                      {p.parent_supplier_id ? (
                        <span className="text-[10px] font-semibold text-theme-accent bg-theme-accent/10 px-2 py-0.5 rounded border border-theme-accent/20">Asociado</span>
                      ) : isRemnant ? (
                        <span className="text-[10px] font-semibold text-theme-text-muted bg-theme-text/5 px-2 py-0.5 rounded border border-theme-border">Remanente sin productos</span>
                      ) : (
                        <span className="text-[10px] font-semibold text-orange-400 bg-orange-400/10 px-2 py-0.5 rounded border border-orange-400/20">Sin proveedor real</span>
                      )}
                    </td>
                  </tr>
                )
              })}
              {pseudos.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-theme-text-muted/50 text-sm">
                    No se encontraron pseudoproveedores operativos Bsale.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
