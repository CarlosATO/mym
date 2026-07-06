'use client'

import { useState, useEffect, useCallback, useRef, useMemo } from 'react'
import { getProducts, getClassifiers, createProduct, updateProduct, deactivateProduct, importProducts, type Product, type ProductFilters } from '@/app/actions/adquisiciones/products'
import * as XLSX from 'xlsx'
import { ClassifierCombobox } from '@/components/ui/classifier-combobox'
import { Search, Plus, FileSpreadsheet, Upload, Download, List, Grid, MoreHorizontal, Filter, X, ArrowLeft } from 'lucide-react'

export function CatalogPanel() {
  const [products, setProducts] = useState<Product[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [message, setMessage] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [preview, setPreview] = useState<{ rows: Record<string, unknown>[]; errors: string[] } | null>(null)
  const [isImporting, setIsImporting] = useState(false)
  const [viewMode, setViewMode] = useState<'table' | 'cards'>('table')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [filters, setFilters] = useState<ProductFilters>({ page: 1, pageSize: 50 })
  const [classifierOptions, setClassifierOptions] = useState<Record<string, { id: string; name: string }[]>>({})
  const [showExportMenu, setShowExportMenu] = useState(false)
  const [showFilters, setShowFilters] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const imgRef = useRef<HTMLInputElement>(null)

  const [form, setForm] = useState<Record<string, string>>({
    sku: '', barcode: '', internal_code: '', description: '', short_description: '',
    brand: '', category: '', subcategory: '', product_type: '', species: '',
    presentation: '', unit_of_measure: '', net_weight: '', weight_unit: '',
    package_quantity: '', package_unit: '', purchase_unit: '', sales_unit: '',
    min_stock: '0', max_stock: '0', reorder_point: '0', tax_rate: '19',
    is_perishable: 'false', requires_lot: 'false', requires_expiration: 'false',
    notes: '', existing_image: '',
  })
  const [bsaleMeta, setBsaleMeta] = useState<Partial<Product> | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const res = await getProducts(filters)
    setProducts(res.data)
    setTotal(res.total)
    setLoading(false)
  }, [filters])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    Promise.all([
      getClassifiers('BRAND'), getClassifiers('CATEGORY'), getClassifiers('SUBCATEGORY'),
      getClassifiers('PRODUCT_TYPE'), getClassifiers('WEIGHT_UNIT'), getClassifiers('PURCHASE_UNIT'),
      getClassifiers('SALES_UNIT'), getClassifiers('MEASURE_UNIT'), getClassifiers('PACKAGE_UNIT'),
    ]).then(([b, c, s, t, w, pu, su, mu, pku]) => {
      setClassifierOptions({ BRAND: b, CATEGORY: c, SUBCATEGORY: s, PRODUCT_TYPE: t, WEIGHT_UNIT: w, PURCHASE_UNIT: pu, SALES_UNIT: su, MEASURE_UNIT: mu, PACKAGE_UNIT: pku })
    })
  }, [])

  function msg(text: string) { setMessage(text); setTimeout(() => setMessage(''), 3500) }

  function resetForm() {
    setForm({ sku: '', barcode: '', internal_code: '', description: '', short_description: '', brand: '', category: '', subcategory: '', product_type: '', species: '', presentation: '', unit_of_measure: '', net_weight: '', weight_unit: '', package_quantity: '', package_unit: '', purchase_unit: '', sales_unit: '', min_stock: '0', max_stock: '0', reorder_point: '0', tax_rate: '19', is_perishable: 'false', requires_lot: 'false', requires_expiration: 'false', notes: '', existing_image: '' })
    setEditId(null)
    setBsaleMeta(null)
  }

  function openEdit(p: Product) {
    setForm({ sku: p.sku, barcode: p.barcode ?? '', internal_code: p.internal_code ?? '', description: p.description, short_description: p.short_description ?? '', brand: p.brand ?? '', category: p.category ?? '', subcategory: p.subcategory ?? '', product_type: p.product_type ?? '', species: p.species ?? '', presentation: p.presentation ?? '', unit_of_measure: p.unit_of_measure ?? '', net_weight: String(p.net_weight ?? ''), weight_unit: p.weight_unit ?? '', package_quantity: String(p.package_quantity ?? ''), package_unit: p.package_unit ?? '', purchase_unit: p.purchase_unit ?? '', sales_unit: p.sales_unit ?? '', min_stock: String(p.min_stock), max_stock: String(p.max_stock), reorder_point: String(p.reorder_point), tax_rate: String(p.tax_rate), is_perishable: p.is_perishable ? 'true' : 'false', requires_lot: p.requires_lot ? 'true' : 'false', requires_expiration: p.requires_expiration ? 'true' : 'false', notes: p.notes ?? '', existing_image: p.image_url ?? '' })
    setEditId(p.id); setShowForm(true)
    setBsaleMeta({ source: p.source, bsale_product_id: p.bsale_product_id, bsale_variant_id: p.bsale_variant_id, bsale_product_type_name: p.bsale_product_type_name, bsale_product_state: p.bsale_product_state, bsale_variant_state: p.bsale_variant_state, last_bsale_sync_at: p.last_bsale_sync_at, bsale_status_conflict: p.bsale_status_conflict, bsale_status_conflict_reason: p.bsale_status_conflict_reason })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    const fd = new FormData(e.target as HTMLFormElement)
    if (editId) { const res = await updateProduct(editId, fd); if (res.error) { msg(res.error); return } msg('Producto actualizado') }
    else { const res = await createProduct(fd); if (res.error) { msg(res.error); return } msg('Producto creado') }
    setShowForm(false); resetForm(); load()
  }

  async function handleDeactivate(p: Product) {
    if (!confirm(`¿Desactivar producto "${p.sku}"?`)) return
    const res = await deactivateProduct(p.id)
    if (res.error) { msg(res.error); return }
    msg(res.newActive ? 'Producto activado' : 'Producto desactivado'); load()
  }

  function toggleSelect(id: string) {
    setSelected(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  }

  function toggleSelectAll() {
    if (products.length === 0) return
    if (products.every(p => selected.has(p.id))) { setSelected(new Set()); return }
    setSelected(new Set(products.map(p => p.id)))
  }

  function downloadTemplate() {
    const headers = ['sku','codigo_barra','codigo_interno','descripcion','descripcion_corta','marca','categoria','subcategoria','tipo_producto','especie','presentacion','unidad_medida','peso_neto','unidad_peso','cantidad_empaque','unidad_empaque','unidad_compra','unidad_venta','stock_minimo','stock_maximo','punto_reposicion','iva_porcentaje','perecible','requiere_lote','requiere_vencimiento','observacion']
    const ex: Record<string, unknown> = { sku: 'ALI-PERRO-001', codigo_barra: '7801234567890', codigo_interno: 'INT-001', descripcion: 'ALIMENTO PREMIUM PARA PERROS ADULTOS 15KG', descripcion_corta: 'ALIMENTO PERRO 15KG', marca: 'PREMIUM DOG', categoria: 'ALIMENTOS', subcategoria: 'PERROS ADULTOS', tipo_producto: 'ALIMENTO SECO', especie: 'PERRO', presentacion: 'BOLSA 15KG', unidad_medida: 'KILOGRAMO', peso_neto: 15, unidad_peso: 'KG', cantidad_empaque: 1, unidad_empaque: 'BOLSA', unidad_compra: 'UNIDAD', unidad_venta: 'UNIDAD', stock_minimo: 10, stock_maximo: 100, punto_reposicion: 20, iva_porcentaje: 19, perecible: 'SI', requiere_lote: 'SI', requiere_vencimiento: 'SI', observacion: 'PRODUCTO CON ALTA ROTACION' }
    const ws = XLSX.utils.json_to_sheet([ex], { header: headers }); ws['!cols'] = headers.map(() => ({ wch: 22 }))
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Catálogo'); XLSX.writeFile(wb, 'plantilla_catalogo_mym.xlsx')
  }

  function exportToExcel(rows: Product[], label: string) {
    const headers = ['sku','codigo_barra','codigo_interno','descripcion','descripcion_corta','marca','categoria','subcategoria','tipo_producto','especie','presentacion','unidad_medida','peso_neto','unidad_peso','cantidad_empaque','unidad_empaque','unidad_compra','unidad_venta','stock_minimo','stock_maximo','punto_reposicion','iva_porcentaje','perecible','requiere_lote','requiere_vencimiento','image_url','observacion']
    const data = rows.map(r => ({
      sku: r.sku, codigo_barra: r.barcode ?? '', codigo_interno: r.internal_code ?? '',
      descripcion: r.description, descripcion_corta: r.short_description ?? '',
      marca: r.brand ?? '', categoria: r.category ?? '', subcategoria: r.subcategory ?? '',
      tipo_producto: r.product_type ?? '', especie: r.species ?? '', presentacion: r.presentation ?? '',
      unidad_medida: r.unit_of_measure ?? '', peso_neto: r.net_weight ?? '', unidad_peso: r.weight_unit ?? '',
      cantidad_empaque: r.package_quantity ?? '', unidad_empaque: r.package_unit ?? '',
      unidad_compra: r.purchase_unit ?? '', unidad_venta: r.sales_unit ?? '',
      stock_minimo: r.min_stock, stock_maximo: r.max_stock, punto_reposicion: r.reorder_point,
      iva_porcentaje: r.tax_rate, perecible: r.is_perishable ? 'SI' : 'NO',
      requiere_lote: r.requires_lot ? 'SI' : 'NO', requiere_vencimiento: r.requires_expiration ? 'SI' : 'NO',
      image_url: r.image_url ?? '', observacion: r.notes ?? '',
    }))
    const ws = XLSX.utils.json_to_sheet(data, { header: headers }); ws['!cols'] = headers.map(() => ({ wch: 22 }))
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Catálogo')
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    XLSX.writeFile(wb, `catalogo_productos_mym_${date}.xlsx`)
    setShowExportMenu(false)
  }

  async function handleExportAll() {
    const all = await getProducts({ pageSize: 100000 })
    exportToExcel(all.data, 'todos')
  }

  async function handleExportFiltered() {
    const all = await getProducts({ ...filters, pageSize: 100000 })
    exportToExcel(all.data, 'filtrados')
  }

  function handleExportSelected() {
    const rows = products.filter(p => selected.has(p.id))
    exportToExcel(rows, 'seleccionados')
  }

  function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]; if (!file) return
    const reader = new FileReader()
    reader.onload = (ev) => {
      const data = new Uint8Array(ev.target?.result as ArrayBuffer)
      const workbook = XLSX.read(data, { type: 'array' })
      const sheet = workbook.Sheets[workbook.SheetNames[0]]
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet)
      const errors: string[] = []; const seenSku = new Set<string>(); const seenBc = new Set<string>(); const validRows: Record<string, unknown>[] = []
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]; const sku = String(row.sku ?? '').trim().toUpperCase(); const desc = String(row.descripcion ?? '').trim().toUpperCase()
        if (!sku && !desc) continue
        if (seenSku.has(sku)) { errors.push(`Fila ${i + 1}: SKU "${sku}" duplicado`); continue }; seenSku.add(sku)
        const bc = String(row.codigo_barra ?? '').trim()
        if (bc && seenBc.has(bc)) { errors.push(`Fila ${i + 1}: Código barra "${bc}" duplicado`); continue }; if (bc) seenBc.add(bc)
        validRows.push({ sku, codigo_barra: bc, codigo_interno: String(row.codigo_interno ?? '').trim().toUpperCase(), descripcion: desc, descripcion_corta: String(row.descripcion_corta ?? '').trim().toUpperCase(), marca: String(row.marca ?? '').trim().toUpperCase(), categoria: String(row.categoria ?? '').trim().toUpperCase(), subcategoria: String(row.subcategoria ?? '').trim().toUpperCase(), tipo_producto: String(row.tipo_producto ?? '').trim().toUpperCase(), especie: String(row.especie ?? '').trim().toUpperCase(), presentacion: String(row.presentacion ?? '').trim().toUpperCase(), unidad_medida: String(row.unidad_medida ?? '').trim().toUpperCase(), peso_neto: Number(row.peso_neto || 0), unidad_peso: String(row.unidad_peso ?? '').trim().toUpperCase(), cantidad_empaque: Number(row.cantidad_empaque || 0), unidad_empaque: String(row.unidad_empaque ?? '').trim().toUpperCase(), unidad_compra: String(row.unidad_compra ?? '').trim().toUpperCase(), unidad_venta: String(row.unidad_venta ?? '').trim().toUpperCase(), stock_minimo: Number(row.stock_minimo || 0), stock_maximo: Number(row.stock_maximo || 0), punto_reposicion: Number(row.punto_reposicion || 0), iva_porcentaje: Number(row.iva_porcentaje || 19), perecible: String(row.perecible ?? '').trim(), requiere_lote: String(row.requiere_lote ?? '').trim(), requiere_vencimiento: String(row.requiere_vencimiento ?? '').trim(), observacion: String(row.observacion ?? '').trim().toUpperCase() })
      }
      if (errors.length > 0) { setPreview({ rows: [], errors }); return }
      setPreview({ rows: validRows, errors: [] })
    }; reader.readAsArrayBuffer(file)
  }

  async function handleImportConfirm() {
    if (!preview || preview.errors.length > 0) return
    setIsImporting(true)
    const cleanRows = preview.rows.map(r => ({
      sku: String(r.sku),
      codigo_barra: String(r.codigo_barra),
      codigo_interno: String(r.codigo_interno),
      descripcion: String(r.descripcion),
      descripcion_corta: String(r.descripcion_corta),
      marca: String(r.marca),
      categoria: String(r.categoria),
      subcategoria: String(r.subcategoria),
      tipo_producto: String(r.tipo_producto),
      especie: String(r.especie),
      presentacion: String(r.presentacion),
      unidad_medida: String(r.unidad_medida),
      peso_neto: Number(r.peso_neto),
      unidad_peso: String(r.unidad_peso),
      cantidad_empaque: Number(r.cantidad_empaque),
      unidad_empaque: String(r.unidad_empaque),
      unidad_compra: String(r.unidad_compra),
      unidad_venta: String(r.unidad_venta),
      stock_minimo: Number(r.stock_minimo),
      stock_maximo: Number(r.stock_maximo),
      punto_reposicion: Number(r.punto_reposicion),
      iva_porcentaje: Number(r.iva_porcentaje),
      perecible: String(r.perecible),
      requiere_lote: String(r.requiere_lote),
      requiere_vencimiento: String(r.requiere_vencimiento),
      observacion: String(r.observacion)
    }))

    console.log("[CATALOG_IMPORT_CONFIRM_CLICK]", cleanRows.length, cleanRows)

    try {
      const res = await importProducts(cleanRows)
      console.log("[CATALOG_IMPORT_RESULT]", res)

      if ('error' in res && typeof res.error === 'string') {
        msg(res.error)
        return
      }

      let detailMsg = `${res.created} productos importados.`
      const omitted = (res.omitted_sku ?? 0) + (res.omitted_barcode ?? 0) + (res.omitted_duplicate_name ?? 0)
      if (omitted > 0) {
        detailMsg += ` Omitidos por duplicado: ${omitted} (${res.omitted_sku ?? 0} SKU, ${res.omitted_barcode ?? 0} Cód. barra, ${res.omitted_duplicate_name ?? 0} Nombre/unidad).`
      }
      if (res.created_classifiers && res.created_classifiers > 0) {
        detailMsg += ` Creados ${res.created_classifiers} clasificadores.`
      }
      if (res.errors && res.errors.length > 0) {
        detailMsg += ` ${res.errors.length} filas con errores.`
      }

      setPreview(null)
      msg(detailMsg)
      load()
    } catch (err) {
      console.error("[CATALOG_IMPORT_ERROR]", err)
      msg('Error inesperado al importar productos.')
    } finally {
      setIsImporting(false)
    }
  }

  function setFilter(key: string, value: string) {
    setFilters(prev => ({ ...prev, [key]: value || undefined, page: 1 }))
    setSelected(new Set())
  }

  const filteredData = products
  const totalPages = Math.ceil(total / (filters.pageSize ?? 50))

  if (showForm) {
    return (
      <div className="flex flex-col h-full overflow-hidden bg-theme-surface animate-in fade-in zoom-in-95 duration-200">
        <form id="product-form" onSubmit={handleSubmit} className="flex-1 overflow-auto">
          <div className="px-6 py-4 border-b border-theme-border bg-theme-surface flex items-center justify-between sticky top-0 z-20 shadow-sm">
            <div className="flex items-center gap-4">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="p-2 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
                <ArrowLeft className="w-5 h-5" />
              </button>
              <h2 className="text-lg font-bold text-theme-text">{editId ? 'Editar producto' : 'Nuevo producto'}</h2>
            </div>
            <div className="flex gap-3">
              <button type="button" onClick={() => { setShowForm(false); resetForm() }} className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-sm font-semibold transition-colors">
                Cancelar
              </button>
              <button type="submit" className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-colors shadow-lg shadow-theme-accent/20">
                Guardar
              </button>
            </div>
          </div>
          <div className="p-6 lg:p-8 space-y-6">
            
            {/* Bsale Integration Block (Read Only) */}
            {bsaleMeta && bsaleMeta.source === 'BSALE' && (
              <div className="bg-theme-text/5 border border-theme-border rounded-xl p-5 mb-6">
                <h3 className="text-xs font-bold text-theme-text-muted/80 uppercase tracking-wider mb-4 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                  Información de Integración Bsale
                </h3>
                <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                  <div>
                    <p className="text-[10px] text-theme-text-muted/60 uppercase">Origen</p>
                    <p className="text-xs font-semibold text-theme-text mt-1">{bsaleMeta.source || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-theme-text-muted/60 uppercase">ID Prod. Bsale</p>
                    <p className="text-xs font-semibold text-theme-text mt-1">{bsaleMeta.bsale_product_id || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-theme-text-muted/60 uppercase">ID Var. Bsale</p>
                    <p className="text-xs font-semibold text-theme-text mt-1">{bsaleMeta.bsale_variant_id || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-theme-text-muted/60 uppercase">Tipo Bsale</p>
                    <p className="text-xs font-semibold text-theme-text mt-1">{bsaleMeta.bsale_product_type_name || '—'}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-theme-text-muted/60 uppercase">Estado Prod.</p>
                    <p className="text-xs font-semibold text-theme-text mt-1">{bsaleMeta.bsale_product_state === 1 ? 'Inactivo' : (bsaleMeta.bsale_product_state === 0 ? 'Activo' : '—')}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-theme-text-muted/60 uppercase">Estado Var.</p>
                    <p className="text-xs font-semibold text-theme-text mt-1">{bsaleMeta.bsale_variant_state === 1 ? 'Inactivo' : (bsaleMeta.bsale_variant_state === 0 ? 'Activo' : '—')}</p>
                  </div>
                  <div>
                    <p className="text-[10px] text-theme-text-muted/60 uppercase">Últ. Sincronización</p>
                    <p className="text-xs font-semibold text-theme-text mt-1">{bsaleMeta.last_bsale_sync_at ? new Date(bsaleMeta.last_bsale_sync_at).toLocaleString() : '—'}</p>
                  </div>
                  {bsaleMeta.bsale_status_conflict && (
                    <div className="bg-amber-500/10 border border-amber-500/20 p-2 rounded-lg">
                      <p className="text-[10px] text-amber-600/80 uppercase font-bold">Conflicto Bsale</p>
                      <p className="text-xs font-semibold text-amber-600 mt-0.5">{bsaleMeta.bsale_status_conflict_reason}</p>
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-x-6 gap-y-5">
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">SKU *</label><input name="sku" defaultValue={editId ? undefined : ''} disabled={!!editId} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text disabled:text-theme-accent-hover/50 focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Código de barra</label><input name="barcode" defaultValue={form.barcode} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Código interno</label><input name="internal_code" defaultValue={form.internal_code} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Descripción corta</label><input name="short_description" defaultValue={form.short_description} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 space-y-1"><label className="text-xs text-theme-text-muted/70">Descripción *</label><input name="description" defaultValue={form.description} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <ClassifierCombobox type="BRAND" label="Marca" value={form.brand} onChange={v => setForm(p => ({ ...p, brand: v }))} />
                <ClassifierCombobox type="CATEGORY" label="Categoría" value={form.category} onChange={v => setForm(p => ({ ...p, category: v }))} />
                <ClassifierCombobox type="SUBCATEGORY" label="Subcategoría" value={form.subcategory} onChange={v => setForm(p => ({ ...p, subcategory: v }))} />
                <ClassifierCombobox type="PRODUCT_TYPE" label="Tipo producto" value={form.product_type} onChange={v => setForm(p => ({ ...p, product_type: v }))} />
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Especie</label><input name="species" defaultValue={form.species} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Presentación</label><input name="presentation" defaultValue={form.presentation} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <ClassifierCombobox type="MEASURE_UNIT" label="Unidad de medida" value={form.unit_of_measure} onChange={v => setForm(p => ({ ...p, unit_of_measure: v }))} />
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Peso neto</label><input name="net_weight" type="number" step="0.001" defaultValue={form.net_weight} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <ClassifierCombobox type="WEIGHT_UNIT" label="Unidad peso" value={form.weight_unit} onChange={v => setForm(p => ({ ...p, weight_unit: v }))} />
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Cant. empaque</label><input name="package_quantity" type="number" step="0.001" defaultValue={form.package_quantity} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <ClassifierCombobox type="PACKAGE_UNIT" label="Unidad empaque" value={form.package_unit} onChange={v => setForm(p => ({ ...p, package_unit: v }))} />
                <ClassifierCombobox type="PURCHASE_UNIT" label="Unidad compra" value={form.purchase_unit} onChange={v => setForm(p => ({ ...p, purchase_unit: v }))} />
                <ClassifierCombobox type="SALES_UNIT" label="Unidad venta" value={form.sales_unit} onChange={v => setForm(p => ({ ...p, sales_unit: v }))} />
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Stock mínimo</label><input name="min_stock" type="number" step="0.001" defaultValue={form.min_stock} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Stock máximo</label><input name="max_stock" type="number" step="0.001" defaultValue={form.max_stock} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Punto reposición</label><input name="reorder_point" type="number" step="0.001" defaultValue={form.reorder_point} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">IVA %</label><input name="tax_rate" type="number" step="0.01" defaultValue={form.tax_rate} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40" /></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Perecible</label><select name="is_perishable" defaultValue={form.is_perishable} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"><option value="false" className="bg-white dark:bg-emerald-900">NO</option><option value="true" className="bg-white dark:bg-emerald-900">SI</option></select></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Requiere lote</label><select name="requires_lot" defaultValue={form.requires_lot} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"><option value="false" className="bg-white dark:bg-emerald-900">NO</option><option value="true" className="bg-white dark:bg-emerald-900">SI</option></select></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Requiere vencimiento</label><select name="requires_expiration" defaultValue={form.requires_expiration} className="w-full h-9 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40"><option value="false" className="bg-white dark:bg-emerald-900">NO</option><option value="true" className="bg-white dark:bg-emerald-900">SI</option></select></div>
                <div className="space-y-1"><label className="text-xs text-theme-text-muted/70">Imagen</label><input name="image" type="file" accept="image/jpeg,image/png,image/webp" ref={imgRef} className="w-full text-xs text-theme-text-muted/70 file:mr-3 file:py-1.5 file:px-3 file:rounded-lg file:border file:border-gray-200 dark:border-theme-border file:bg-theme-text/5 file:text-xs file:text-theme-text-accent file:cursor-pointer" />{form.existing_image && <p className="text-[10px] text-theme-text-muted/50 mt-1">Imagen actual subida</p>}<input name="existing_image" type="hidden" value={form.existing_image} /></div>
                <div className="col-span-1 md:col-span-2 lg:col-span-3 xl:col-span-4 space-y-1"><label className="text-xs text-theme-text-muted/70">Observaciones</label><textarea name="notes" defaultValue={form.notes} rows={2} className="w-full rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-3 py-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 resize-none" /></div>
            </div>
            <input type="hidden" name="brand" value={form.brand} /><input type="hidden" name="category" value={form.category} /><input type="hidden" name="subcategory" value={form.subcategory} /><input type="hidden" name="product_type" value={form.product_type} /><input type="hidden" name="unit_of_measure" value={form.unit_of_measure} /><input type="hidden" name="weight_unit" value={form.weight_unit} /><input type="hidden" name="package_unit" value={form.package_unit} /><input type="hidden" name="purchase_unit" value={form.purchase_unit} /><input type="hidden" name="sales_unit" value={form.sales_unit} />
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full overflow-hidden bg-theme-surface">
      {message && <div className="shrink-0 bg-theme-accent-hover/10 border-b border-theme-accent/20 px-4 py-2.5 text-sm text-theme-text-accent">{message}</div>}

      <div className="shrink-0 flex flex-col gap-4 p-5 border-b border-theme-border/60 bg-theme-text/[0.01]">
        {/* Barra superior de herramientas */}
        <div className="flex flex-col md:flex-row items-center gap-3 w-full">
          {/* Búsqueda */}
          <div className="relative flex-1 w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
            <input type="text" value={filters.search ?? ''} onChange={e => setFilter('search', e.target.value)}
              placeholder="Buscar por SKU, descripción, marca o categoría..."
              className="w-full h-11 pl-10 pr-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40" />
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto">
            {/* Toggle Tabla/Tarjetas */}
            <div className="flex items-center p-1 bg-theme-text/5 border border-theme-border rounded-xl">
              <button onClick={() => setViewMode('table')} className={`flex items-center justify-center w-10 h-8 md:w-auto md:px-3 text-xs font-semibold rounded-lg transition-all ${viewMode === 'table' ? 'bg-theme-surface shadow-sm text-theme-text' : 'text-theme-text-muted/60 hover:text-theme-text'}`}>
                <List className="w-4 h-4" />
                <span className="hidden md:inline ml-2">Tabla</span>
              </button>
              <button onClick={() => setViewMode('cards')} className={`flex items-center justify-center w-10 h-8 md:w-auto md:px-3 text-xs font-semibold rounded-lg transition-all ${viewMode === 'cards' ? 'bg-theme-surface shadow-sm text-theme-text' : 'text-theme-text-muted/60 hover:text-theme-text'}`}>
                <Grid className="w-4 h-4" />
                <span className="hidden md:inline ml-2">Tarjetas</span>
              </button>
            </div>

            {/* Opciones Importar/Exportar */}
            <div className="relative group z-10">
              <button className="h-11 px-3 md:px-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text text-sm font-semibold transition-all flex items-center justify-center gap-2">
                <MoreHorizontal className="w-5 h-5 md:w-4 md:h-4" />
                <span className="hidden md:inline">Opciones</span>
              </button>
              <div className="absolute right-0 top-full mt-2 w-56 bg-theme-surface backdrop-blur-xl border border-theme-border rounded-2xl shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 p-2">
                <button onClick={downloadTemplate} className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors flex items-center gap-2">
                  <FileSpreadsheet className="w-4 h-4" /> Descargar plantilla
                </button>
                <label className="w-full text-left px-3 py-2.5 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors flex items-center gap-2 cursor-pointer">
                  <Upload className="w-4 h-4" /> Importar Excel
                  <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={handleFileUpload} className="hidden" />
                </label>
                <div className="h-px bg-theme-border my-1" />
                <div className="w-full text-left px-3 py-2 text-[10px] font-bold text-theme-text-muted/50 uppercase tracking-wider">Exportar</div>
                <button onClick={handleExportAll} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Todos los productos</button>
                <button onClick={handleExportFiltered} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors">Productos filtrados</button>
                <button onClick={handleExportSelected} disabled={selected.size === 0} className="w-full text-left px-3 py-2 text-xs font-medium text-theme-text-muted hover:text-theme-text hover:bg-theme-text/5 rounded-lg transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                  Seleccionados {selected.size > 0 && `(${selected.size})`}
                </button>
              </div>
            </div>

            {/* Filtros Toggle */}
            <button onClick={() => setShowFilters(!showFilters)} className={`h-11 px-3 md:px-4 rounded-xl border transition-all flex items-center justify-center gap-2 text-sm font-semibold ${showFilters ? 'bg-theme-text/10 border-theme-border text-theme-text' : 'bg-theme-surface border-theme-border hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text'}`}>
              <Filter className="w-4 h-4" />
              <span className="hidden md:inline">Filtros</span>
            </button>

            {/* Nuevo */}
            <button onClick={() => { resetForm(); setShowForm(true) }} className="h-11 px-4 md:px-5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-sm font-bold transition-all shadow-lg shadow-theme-accent/20 flex items-center justify-center gap-2 ml-auto md:ml-0">
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">Nuevo</span>
            </button>
          </div>
        </div>

        {/* Panel de Filtros Expandible */}
        {showFilters && (
          <div className="p-5 rounded-2xl border border-theme-border bg-theme-text/5 animate-in slide-in-from-top-2 duration-200">
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-xs font-bold text-theme-text-muted/80 uppercase tracking-wider">Filtros Avanzados</h4>
              <button onClick={() => { setFilters({ page: 1, pageSize: 50 }); setSelected(new Set()) }} className="text-xs font-semibold text-theme-text-accent hover:text-theme-text flex items-center gap-1 transition-colors">
                <X className="w-3 h-3" /> Limpiar filtros
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-7 gap-3">
              <select value={filters.brand ?? ''} onChange={e => setFilter('brand', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Todas las marcas</option>
                {classifierOptions.BRAND?.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <select value={filters.category ?? ''} onChange={e => setFilter('category', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Categorías</option>
                {classifierOptions.CATEGORY?.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <select value={filters.subcategory ?? ''} onChange={e => setFilter('subcategory', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Subcategorías</option>
                {classifierOptions.SUBCATEGORY?.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <select value={filters.product_type ?? ''} onChange={e => setFilter('product_type', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Tipos</option>
                {classifierOptions.PRODUCT_TYPE?.map(c => <option key={c.id} value={c.name}>{c.name}</option>)}
              </select>
              <select value={filters.is_active ?? ''} onChange={e => setFilter('is_active', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Estado (Todos)</option>
                <option value="true">Activos</option>
                <option value="false">Inactivos</option>
              </select>
              <select value={filters.is_perishable ?? ''} onChange={e => setFilter('is_perishable', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Perecible (Todos)</option>
                <option value="true">Sí</option>
                <option value="false">No</option>
              </select>
              <select value={filters.requires_lot ?? ''} onChange={e => setFilter('requires_lot', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Lote (Todos)</option>
                <option value="true">Sí</option>
                <option value="false">No</option>
              </select>
              <select value={filters.requires_expiration ?? ''} onChange={e => setFilter('requires_expiration', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Venc. (Todos)</option>
                <option value="true">Sí</option>
                <option value="false">No</option>
              </select>
              <select value={filters.source ?? ''} onChange={e => setFilter('source', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Origen (Todos)</option>
                <option value="BSALE">Bsale</option>
                <option value="PETGRUP">PetGrup</option>
              </select>
              <select value={filters.bsale_status_conflict ?? ''} onChange={e => setFilter('bsale_status_conflict', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Conflicto Bsale (Todos)</option>
                <option value="true">Sí (Con Conflicto)</option>
              </select>
              <select value={filters.bsale_inactive ?? ''} onChange={e => setFilter('bsale_inactive', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Estado Bsale (Todos)</option>
                <option value="true">Inactivo en Bsale</option>
              </select>
              <select value={filters.no_barcode ?? ''} onChange={e => setFilter('no_barcode', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Cód. Barra (Todos)</option>
                <option value="true">Sin Código de Barra</option>
              </select>
              <select value={filters.no_bsale_type ?? ''} onChange={e => setFilter('no_bsale_type', e.target.value)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40 appearance-none">
                <option value="">Tipo Bsale (Todos)</option>
                <option value="true">Sin Tipo Bsale</option>
              </select>
            </div>
          </div>
        )}
      </div>

      {selected.size > 0 && (
        <div className="text-xs text-theme-text-muted/70 px-1">{selected.size} producto(s) seleccionado(s)</div>
      )}

      {preview && (
        <div className="rounded-2xl border border-gray-200/80 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-theme-text">Vista previa - {preview.rows.length} filas válidas</h3>
            <div className="flex gap-2">
              <button onClick={() => setPreview(null)} disabled={isImporting} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-theme-border text-xs text-theme-text-muted/70 hover:text-theme-text disabled:opacity-40 disabled:cursor-not-allowed">Cancelar</button>
              {preview.errors.length === 0 && preview.rows.length > 0 && (
                <button
                  type="button"
                  onClick={handleImportConfirm}
                  disabled={isImporting}
                  className="px-3 py-1.5 rounded-lg bg-theme-accent text-xs text-white font-semibold hover:bg-theme-accent-hover disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {isImporting ? 'Importando...' : 'Confirmar importación'}
                </button>
              )}
            </div>
          </div>
          {preview.errors.length > 0 && <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-3 space-y-1">{preview.errors.map((e, i) => <p key={i} className="text-xs text-red-500">{e}</p>)}</div>}
        </div>
      )}

      {loading ? (
        <div className="rounded-2xl border border-gray-200/80 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 p-10 text-center"><p className="text-theme-text-muted/50 text-sm">Cargando...</p></div>
      ) : products.length === 0 && viewMode === 'table' ? (
        <div className="rounded-2xl border border-gray-200/80 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 p-10 text-center"><p className="text-theme-text-muted/50 text-sm">No hay productos en el catálogo.</p></div>
      ) : viewMode === 'cards' ? (
        <div className="flex-1 overflow-auto p-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(products.length > 0 ? products : filteredData).map(p => (
              <div key={p.id} onClick={() => toggleSelect(p.id)} className={`rounded-2xl border overflow-hidden hover:shadow-lg hover:-translate-y-0.5 transition-all duration-200 group cursor-pointer ${selected.has(p.id) ? 'border-emerald-500/60 ring-1 ring-emerald-500/30' : 'border-gray-200/80 dark:border-theme-border'}`}>
                <div className={`aspect-[4/3] flex items-center justify-center overflow-hidden ${selected.has(p.id) ? 'bg-white dark:bg-emerald-900/20' : 'bg-theme-text/5'}`}>
                  {p.image_url ? <img src={p.image_url} alt="" className="w-full h-full object-contain p-2" /> : <div className="text-theme-text-muted/50 text-3xl">📷</div>}
                </div>
                <div className="p-4 space-y-2 bg-black/5 dark:bg-theme-text/5">
                  <div className="flex items-start justify-between gap-2">
                    <p className="text-xs font-mono font-semibold text-theme-text">{p.sku}</p>
                    {selected.has(p.id) && <span className="text-[10px] text-theme-text-accent font-semibold">✓</span>}
                  </div>
                  <p className="text-xs text-theme-text-muted/80 leading-tight line-clamp-2">{p.description}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {p.brand && <span className="text-[10px] px-2 py-0.5 rounded-full bg-black/5 dark:bg-theme-text/5 text-theme-text-muted/70">{p.brand}</span>}
                  </div>
                  <div className="flex items-center gap-2 pt-1 border-t border-gray-200/80 dark:border-theme-border">
                    <button onClick={e => { e.stopPropagation(); openEdit(p) }} className="text-xs text-theme-text-muted/70 hover:text-theme-text-accent">Editar</button>
                    <button onClick={e => { e.stopPropagation(); handleDeactivate(p) }} className={`text-xs ${p.is_active ? 'text-red-500/80 hover:text-red-500' : 'text-theme-text-muted/70 hover:text-theme-text-accent'}`}>{p.is_active ? 'Desactivar' : 'Activar'}</button>
                  </div>
                </div>
              </div>
            ))}
          </div>
          {products.length === 0 && <div className="text-center py-10 text-theme-text-muted/50 text-sm">No hay productos.</div>}
        </div>
      ) : (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-sm border-collapse">
            <thead className="sticky top-0 z-10 bg-theme-surface">
              <tr className="border-b border-gray-200/80 dark:border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                <th className="py-3 px-4 text-left w-10"><input type="checkbox" checked={products.length > 0 && products.every(p => selected.has(p.id))} onChange={toggleSelectAll} className="accent-emerald-600" /></th>
                <th className="text-left py-3 px-4 font-medium w-14">Imagen</th>
                <th className="text-left py-3 px-4 font-medium">SKU</th>
                <th className="text-left py-3 px-4 font-medium">Código barra</th>
                <th className="text-left py-3 px-4 font-medium">Descripción</th>
                <th className="text-left py-3 px-4 font-medium">Marca</th>
                <th className="text-left py-3 px-4 font-medium">Categoría</th>
                <th className="text-left py-3 px-4 font-medium">Tipo Bsale</th>
                <th className="text-left py-3 px-4 font-medium">Presentación</th>
                <th className="text-left py-3 px-4 font-medium">U.Medida</th>
                <th className="text-left py-3 px-4 font-medium">St.Min</th>
                <th className="text-left py-3 px-4 font-medium">P.Repos</th>
                <th className="text-left py-3 px-4 font-medium">Integ. Bsale</th>
                <th className="text-left py-3 px-4 font-medium">Estado</th>
                <th className="text-right py-3 px-4 font-medium">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {filteredData.map(p => (
                <tr key={p.id} className={`border-b border-theme-border hover:bg-theme-text/5 transition-colors ${selected.has(p.id) ? 'bg-white dark:bg-emerald-900/10' : ''}`}>
                  <td className="py-3 px-4"><input type="checkbox" checked={selected.has(p.id)} onChange={() => toggleSelect(p.id)} className="accent-emerald-600" /></td>
                  <td className="py-2 px-4">{p.image_url ? <img src={p.image_url} alt="" className="w-10 h-10 rounded-lg object-cover border border-gray-200 dark:border-theme-border" /> : <div className="w-10 h-10 rounded-lg bg-black/5 dark:bg-theme-text/5 border border-gray-200 dark:border-theme-border flex items-center justify-center text-theme-text-muted/50 text-xs">📷</div>}</td>
                  <td className="py-3 px-4 text-theme-text text-xs font-mono font-medium">{p.sku}</td>
                  <td className="py-3 px-4 text-theme-text-muted/60 text-xs font-mono">{p.barcode || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs max-w-[200px] truncate" title={p.description}>{p.description}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs">{p.brand || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs">{p.category || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs">{p.bsale_product_type_name || p.product_type || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs">{p.presentation || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs">{p.unit_of_measure || '—'}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs">{p.min_stock}</td>
                  <td className="py-3 px-4 text-theme-text-muted/80 text-xs">{p.reorder_point}</td>
                  <td className="py-3 px-4 flex flex-col gap-1 items-start">
                    {p.source === 'BSALE' && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 border border-blue-500/20">BSALE</span>}
                    {p.requires_lot && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 border border-purple-500/20">LOTE</span>}
                    {p.bsale_status_conflict && <span title={p.bsale_status_conflict_reason || ''} className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 border border-amber-500/20">! CONFLICTO</span>}
                  </td>
                  <td className="py-3 px-4">{p.is_active ? <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-theme-accent-hover/10 text-theme-text-accent border-theme-accent/20">Activo</span> : <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-red-500/10 text-red-500 border-red-500/20">Inactivo</span>}</td>
                  <td className="py-3 px-4 text-right">
                    <button onClick={() => openEdit(p)} className="text-xs text-theme-text-muted/70 hover:text-theme-text-accent mr-3">Editar</button>
                    <button onClick={() => handleDeactivate(p)} className={`text-xs ${p.is_active ? 'text-red-500/80 hover:text-red-500' : 'text-theme-text-muted/70 hover:text-theme-text-accent'}`}>{p.is_active ? 'Desactivar' : 'Activar'}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {totalPages > 1 && viewMode === 'table' && (
        <div className="shrink-0 flex items-center justify-between text-xs p-4 border-t border-theme-border/60 bg-theme-text/[0.01]">
          <div className="flex items-center gap-2">
            <span className="text-theme-text-muted/50">Mostrar</span>
            <select value={filters.pageSize} onChange={e => setFilter('pageSize', e.target.value)} className="h-8 rounded-lg border border-gray-200 dark:border-theme-border bg-black/5 dark:bg-theme-text/5 px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-border-accent/40">
              <option value={25} className="bg-white dark:bg-emerald-900">25</option>
              <option value={50} className="bg-white dark:bg-emerald-900">50</option>
              <option value={100} className="bg-white dark:bg-emerald-900">100</option>
            </select>
            <span className="text-theme-text-muted/50">de {total} registros</span>
          </div>
          <div className="flex items-center gap-2">
            <button disabled={(filters.page ?? 1) <= 1} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) - 1 }))} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Anterior</button>
            <span className="text-theme-text-muted/50">Pág. {filters.page ?? 1} de {totalPages}</span>
            <button disabled={(filters.page ?? 1) >= totalPages} onClick={() => setFilters(p => ({ ...p, page: (p.page ?? 1) + 1 }))} className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-theme-border text-theme-text-muted/70 hover:text-theme-text disabled:opacity-30 disabled:cursor-not-allowed">Siguiente</button>
          </div>
        </div>
      )}


    </div>
  )
}
