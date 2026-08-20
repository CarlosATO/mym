'use client'

import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, ChevronDown, Link2, Loader2, Search, Unlink, X } from 'lucide-react'
import { toast } from 'sonner'
import {
  linkBsaleBrandSupplier,
  listBsaleBrandSupplierCandidates,
  unlinkBsaleBrandSupplier,
  type BsaleBrandSupplierCandidate,
} from '@/app/actions/integraciones/bsale-brand-supplier-links'
import { getSuppliers, type Supplier } from '@/app/actions/adquisiciones/suppliers'
import { OperationalTableResizeHandle, OperationalTableSortIndicator, sortOperationalRows, useOperationalTableSort, useOperationalTableWidths, type OperationalTableColumn } from '@/components/ui/operational-table'

type LinkTarget = {
  brand: BsaleBrandSupplierCandidate
  supplierId: string
  supplierName: string
  supplierRut: string | null
}

type Props = {
  canWrite: boolean
}

const classificationLabels: Record< BsaleBrandSupplierCandidate['classification'], string> = {
  INEQUIVOCO: 'Inequívoco',
  CASI_INEQUIVOCO: 'Casi inequívoco',
  MIXTO: 'Mixto',
  SIN_RESOLVER: 'Sin resolver',
}

const statusLabels: Record< BsaleBrandSupplierCandidate['derived_status'], string> = {
  LINKED: 'Vinculado',
  PENDING: 'Pendiente',
  CONFLICT: 'Requiere revisión',
}

const BRAND_TABLE_KEY = 'mym:table:adquisiciones:proveedor-bsale'
const BRAND_COLUMNS: OperationalTableColumn[] = [
  { id: 'brand', defaultWidth: 135, minWidth: 105, maxWidth: 220, sortable: true, sortKey: 'bsale_brand_id', sortType: 'number' },
  { id: 'products', defaultWidth: 105, minWidth: 85, maxWidth: 160, sortable: true, sortKey: 'active_products', sortType: 'number' },
  { id: 'candidate', defaultWidth: 260, minWidth: 180, maxWidth: 460, sortable: true, sortKey: 'candidate_supplier_name', sortType: 'text' },
  { id: 'coverage', defaultWidth: 180, minWidth: 140, maxWidth: 280 },
  { id: 'classification', defaultWidth: 170, minWidth: 130, maxWidth: 280, sortable: true, sortKey: 'classification', sortType: 'text' },
  { id: 'status', defaultWidth: 145, minWidth: 115, maxWidth: 240, sortable: true, sortKey: 'derived_status', sortType: 'text' },
  { id: 'linked', defaultWidth: 280, minWidth: 190, maxWidth: 480, sortable: true, sortKey: 'linked_supplier_name', sortType: 'text' },
  { id: 'actions', defaultWidth: 250, minWidth: 220, maxWidth: 360, sticky: 'right' },
]

function coverage(candidate: BsaleBrandSupplierCandidate) {
  const total = candidate.active_products
  const resolved = candidate.resolved_preferred_products
  const percentage = total > 0 ? (resolved / total) * 100 : 0
  return `${resolved} / ${total} · ${percentage.toLocaleString('es-CL', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} %`
}

function classificationClass(classification: BsaleBrandSupplierCandidate['classification']) {
  if (classification === 'INEQUIVOCO') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500'
  if (classification === 'CASI_INEQUIVOCO') return 'border-amber-500/20 bg-amber-500/10 text-amber-500'
  if (classification === 'MIXTO') return 'border-red-500/20 bg-red-500/10 text-red-400'
  return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
}

function statusClass(status: BsaleBrandSupplierCandidate['derived_status']) {
  if (status === 'LINKED') return 'border-emerald-500/20 bg-emerald-500/10 text-emerald-500'
  if (status === 'CONFLICT') return 'border-red-500/20 bg-red-500/10 text-red-400'
  return 'border-amber-500/20 bg-amber-500/10 text-amber-500'
}

export function BsaleBrandSupplierPanel({ canWrite }: Props) {
  const [candidates, setCandidates] = useState<BsaleBrandSupplierCandidate[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [statusFilter, setStatusFilter] = useState<'ALL' | BsaleBrandSupplierCandidate['derived_status']>('ALL')
  const [classificationFilter, setClassificationFilter] = useState<'ALL' | BsaleBrandSupplierCandidate['classification']>('ALL')
  const [search, setSearch] = useState('')
  const [target, setTarget] = useState<LinkTarget | null>(null)
  const [unlinkTarget, setUnlinkTarget] = useState<BsaleBrandSupplierCandidate | null>(null)
  const [supplierPicker, setSupplierPicker] = useState<BsaleBrandSupplierCandidate | null>(null)
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [supplierSearch, setSupplierSearch] = useState('')
  const [loadingSuppliers, setLoadingSuppliers] = useState(false)
  const [mutation, setMutation] = useState<'LINK' | 'UNLINK' | null>(null)
  const { widths, setColumnWidth, persist, reset: resetWidths } = useOperationalTableWidths(BRAND_TABLE_KEY, BRAND_COLUMNS)
  const { sort, cycleSort } = useOperationalTableSort(BRAND_TABLE_KEY, BRAND_COLUMNS)

  async function loadCandidates() {
    setLoading(true)
    setError(null)
    const result = await listBsaleBrandSupplierCandidates()
    if (result.error) {
      setError('No se pudieron cargar los Brands Bsale.')
      setCandidates([])
    } else {
      setCandidates(result.data)
    }
    setLoading(false)
  }

  useEffect(() => {
    const timer = window.setTimeout(() => { void loadCandidates() }, 0)
    return () => window.clearTimeout(timer)
  }, [])

  const visibleCandidates = useMemo(() => {
    const term = search.trim().toLowerCase()
    return candidates.filter(candidate => {
      if (statusFilter !== 'ALL' && candidate.derived_status !== statusFilter) return false
      if (classificationFilter !== 'ALL' && candidate.classification !== classificationFilter) return false
      if (!term) return true
      return String(candidate.bsale_brand_id).includes(term)
        || (candidate.candidate_supplier_name ?? '').toLowerCase().includes(term)
        || (candidate.linked_supplier_name ?? '').toLowerCase().includes(term)
    })
  }, [candidates, classificationFilter, search, statusFilter])

  const sortedCandidates = useMemo(() => sortOperationalRows(visibleCandidates, sort, BRAND_COLUMNS, (candidate, key) => candidate[key as keyof BsaleBrandSupplierCandidate]), [sort, visibleCandidates])

  function brandColumn(id: string) { return BRAND_COLUMNS.find(column => column.id === id)! }
  function brandHeader(id: string, label: string) {
    const column = brandColumn(id)
    if (!column.sortable) return <span className="truncate">{label}</span>
    const active = sort?.column === id
    return <button type="button" onClick={() => cycleSort(column)} className="group flex min-w-0 items-center gap-1 text-left hover:text-theme-text" title="Ordenar columna"><span className="truncate">{label}</span><OperationalTableSortIndicator active={active} direction={active ? sort?.direction : undefined} /></button>
  }
  function brandResize(id: string) {
    const column = brandColumn(id)
    return <OperationalTableResizeHandle column={column} width={widths[id] ?? column.defaultWidth} onResize={width => setColumnWidth(column, width)} onResizeEnd={persist} />
  }

  const summary = useMemo(() => ({
    total: candidates.length,
    linked: candidates.filter(candidate => candidate.derived_status === 'LINKED').length,
    pending: candidates.filter(candidate => candidate.derived_status === 'PENDING').length,
    conflicts: candidates.filter(candidate => candidate.derived_status === 'CONFLICT').length,
  }), [candidates])

  const filteredSuppliers = useMemo(() => {
    const term = supplierSearch.trim().toLowerCase()
    return suppliers.filter(supplier => !term
      || supplier.business_name.toLowerCase().includes(term)
      || (supplier.rut ?? '').toLowerCase().includes(term)
    )
  }, [supplierSearch, suppliers])

  async function openSupplierPicker(brand: BsaleBrandSupplierCandidate) {
    setSupplierPicker(brand)
    setSupplierSearch('')
    setLoadingSuppliers(true)
    const available = await getSuppliers(undefined, 'REAL')
    setSuppliers(available.filter(supplier => supplier.is_active && supplier.status === 'ACTIVE'))
    setLoadingSuppliers(false)
  }

  function openCandidateConfirmation(brand: BsaleBrandSupplierCandidate) {
    if (!brand.candidate_supplier_id || !brand.candidate_supplier_name) return
    setTarget({
      brand,
      supplierId: brand.candidate_supplier_id,
      supplierName: brand.candidate_supplier_name,
      supplierRut: brand.candidate_supplier_rut,
    })
  }

  function chooseSupplier(supplier: Supplier) {
    if (!supplierPicker) return
    setTarget({
      brand: supplierPicker,
      supplierId: supplier.id,
      supplierName: supplier.business_name,
      supplierRut: supplier.rut,
    })
    setSupplierPicker(null)
  }

  async function confirmLink() {
    if (!target || mutation) return
    setMutation('LINK')
    const result = await linkBsaleBrandSupplier(target.brand.bsale_brand_id, target.supplierId)
    setMutation(null)
    if (result.error) {
      toast.error('No se pudo vincular el Brand Bsale.')
      return
    }
    setTarget(null)
    toast.success('Brand Bsale vinculado correctamente.')
    await loadCandidates()
  }

  async function confirmUnlink() {
    if (!unlinkTarget || mutation) return
    setMutation('UNLINK')
    const result = await unlinkBsaleBrandSupplier(unlinkTarget.bsale_brand_id)
    setMutation(null)
    if (result.error) {
      toast.error('No se pudo desvincular el Brand Bsale.')
      return
    }
    setUnlinkTarget(null)
    toast.success('Vínculo Brand Bsale eliminado.')
    await loadCandidates()
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden bg-theme-surface">
      <div className="shrink-0 border-b border-theme-border/70 bg-theme-text/[0.02] px-4 py-4 md:px-5">
        <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
          <div>
            <h2 className="text-base font-bold text-theme-text">Proveedor en Bsale</h2>
            <p className="mt-1 max-w-3xl text-xs text-theme-text-muted/75">Resuelve manualmente Marca/Brand Bsale hacia un proveedor REAL PetGroup. Los candidatos son evidencia, no vínculos aprobados.</p>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Summary label="Brands detectados" value={summary.total} />
            <Summary label="Vinculados" value={summary.linked} tone="green" />
            <Summary label="Pendientes" value={summary.pending} tone="amber" />
            <Summary label="Conflictos" value={summary.conflicts} tone="red" />
          </div>
        </div>
      </div>

      <div className="shrink-0 flex flex-col gap-2 border-b border-theme-border/60 p-3 md:flex-row md:items-center">
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" />
          <input value={search} onChange={event => setSearch(event.target.value)} placeholder="Buscar Brand, candidato o proveedor vinculado..." className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent" />
        </div>
        <select value={statusFilter} onChange={event => setStatusFilter(event.target.value as typeof statusFilter)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none">
          <option value="ALL">Todos los estados</option>
          <option value="PENDING">Pendientes</option>
          <option value="LINKED">Vinculados</option>
          <option value="CONFLICT">Conflicto</option>
        </select>
        <select value={classificationFilter} onChange={event => setClassificationFilter(event.target.value as typeof classificationFilter)} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text outline-none">
          <option value="ALL">Todas las clasificaciones</option>
          <option value="INEQUIVOCO">Inequívoco</option>
          <option value="CASI_INEQUIVOCO">Casi inequívoco</option>
          <option value="MIXTO">Mixto</option>
          <option value="SIN_RESOLVER">Sin resolver</option>
        </select>
        <button type="button" onClick={resetWidths} className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text">Restablecer anchos</button>
      </div>

      {loading ? <LoadingState /> : error ? <ErrorState onRetry={() => void loadCandidates()} /> : visibleCandidates.length === 0 ? <EmptyState /> : (
        <div className="min-h-0 flex-1 overflow-x-auto overflow-y-auto">
          <table className="min-w-[1500px] w-full table-fixed whitespace-nowrap text-xs">
            <colgroup>{BRAND_COLUMNS.map(column => <col key={column.id} style={{ width: widths[column.id] ?? column.defaultWidth }} />)}</colgroup>
            <thead className="sticky top-0 z-10 border-b border-theme-border bg-theme-surface text-[10px] uppercase tracking-wider text-theme-text-muted">
              <tr>
                <th className="relative border-r border-theme-border/30 px-4 py-3 text-left font-semibold">{brandHeader('brand', 'Brand Bsale')}{brandResize('brand')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-3 text-left font-semibold">{brandHeader('products', 'Productos')}{brandResize('products')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-3 text-left font-semibold">{brandHeader('candidate', 'Proveedor candidato')}{brandResize('candidate')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-3 text-left font-semibold">{brandHeader('coverage', 'Cobertura')}{brandResize('coverage')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-3 text-left font-semibold">{brandHeader('classification', 'Clasificación')}{brandResize('classification')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-3 text-left font-semibold">{brandHeader('status', 'Estado')}{brandResize('status')}</th>
                <th className="relative border-r border-theme-border/30 px-4 py-3 text-left font-semibold">{brandHeader('linked', 'Proveedor vinculado')}{brandResize('linked')}</th>
                <th className="sticky right-0 z-30 border-l border-theme-border bg-theme-surface px-4 py-3 text-right font-semibold">Acción</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-theme-border/50">
              {sortedCandidates.map(candidate => (
                <BrandRow
                  key={`${candidate.company_id}-${candidate.bsale_brand_id}`}
                  candidate={candidate}
                  canWrite={canWrite}
                  onLink={openCandidateConfirmation}
                  onPick={() => void openSupplierPicker(candidate)}
                  onUnlink={setUnlinkTarget}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!canWrite && <div className="shrink-0 border-t border-theme-border bg-theme-text/[0.02] px-4 py-2 text-[11px] text-theme-text-muted">Modo lectura: requiere permiso de actualización de proveedores para aprobar o desvincular.</div>}

      {target && <ConfirmationDialog target={target} busy={mutation === 'LINK'} onCancel={() => setTarget(null)} onConfirm={() => void confirmLink()} />}
      {unlinkTarget && <UnlinkDialog candidate={unlinkTarget} busy={mutation === 'UNLINK'} onCancel={() => setUnlinkTarget(null)} onConfirm={() => void confirmUnlink()} />}
      {supplierPicker && <SupplierPicker suppliers={filteredSuppliers} loading={loadingSuppliers} search={supplierSearch} onSearch={setSupplierSearch} onSelect={chooseSupplier} onCancel={() => setSupplierPicker(null)} />}
    </div>
  )
}

function Summary({ label, value, tone = 'default' }: { label: string; value: number; tone?: 'default' | 'green' | 'amber' | 'red' }) {
  const color = tone === 'green' ? 'text-emerald-500' : tone === 'amber' ? 'text-amber-500' : tone === 'red' ? 'text-red-400' : 'text-theme-text'
  return <div className="rounded-lg border border-theme-border bg-theme-surface px-3 py-2"><div className={`text-lg font-bold leading-none ${color}`}>{value}</div><div className="mt-1 text-[10px] text-theme-text-muted">{label}</div></div>
}

function BrandRow({ candidate, canWrite, onLink, onPick, onUnlink }: { candidate: BsaleBrandSupplierCandidate; canWrite: boolean; onLink: (candidate: BsaleBrandSupplierCandidate) => void; onPick: () => void; onUnlink: (candidate: BsaleBrandSupplierCandidate) => void }) {
  return (
    <tr className="hover:bg-theme-text/[0.025]">
      <td className="px-4 py-3 align-top"><div className="font-mono font-bold text-theme-text">Brand {candidate.bsale_brand_id}</div><div className="mt-1 text-[10px] text-theme-text-muted">ID fuente Bsale</div></td>
      <td className="px-4 py-3 align-top font-mono text-theme-text">{candidate.active_products}</td>
      <td className="px-4 py-3 align-top"><div className="truncate font-semibold text-theme-text" title={candidate.candidate_supplier_name ?? undefined}>{candidate.candidate_supplier_name ?? '—'}</div><div className="mt-1 truncate text-[10px] text-theme-text-muted">{candidate.candidate_supplier_rut ?? 'Sin RUT disponible'}</div></td>
      <td className="px-4 py-3 align-top font-mono text-theme-text">{coverage(candidate)}</td>
      <td className="px-4 py-3 align-top"><span className={`inline-flex rounded border px-2 py-1 text-[10px] font-semibold ${classificationClass(candidate.classification)}`}>{classificationLabels[candidate.classification]}</span></td>
      <td className="px-4 py-3 align-top"><span className={`inline-flex rounded border px-2 py-1 text-[10px] font-semibold ${statusClass(candidate.derived_status)}`}>{statusLabels[candidate.derived_status]}</span></td>
      <td className="px-4 py-3 align-top"><div className="truncate font-semibold text-theme-text" title={candidate.linked_supplier_name ?? undefined}>{candidate.linked_supplier_name ?? '—'}</div>{candidate.linked_supplier_rut && <div className="mt-1 truncate text-[10px] text-theme-text-muted">{candidate.linked_supplier_rut}</div>}</td>
      <td className="sticky right-0 z-20 border-l border-theme-border bg-theme-surface px-4 py-3 text-right align-top shadow-[-6px_0_12px_-10px_rgba(0,0,0,0.5)]">
        {!canWrite ? <span className="text-[10px] text-theme-text-muted">Solo lectura</span> : candidate.derived_status === 'LINKED' ? <button onClick={() => onUnlink(candidate)} className="inline-flex h-7 items-center gap-1 rounded-lg border border-red-500/20 px-2.5 text-[11px] font-semibold text-red-400 hover:bg-red-500/10"><Unlink className="h-3.5 w-3.5" /> Desvincular</button> : (
          <div className="flex justify-end gap-1.5">
            {candidate.derived_status === 'PENDING' && candidate.candidate_supplier_id && <button onClick={() => onLink(candidate)} className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-2.5 text-[11px] font-semibold text-white hover:bg-theme-accent-hover"><Link2 className="h-3.5 w-3.5" /> Vincular</button>}
            <button onClick={onPick} className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border px-2.5 text-[11px] font-semibold text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text">{candidate.candidate_supplier_id ? 'Usar otro' : 'Seleccionar proveedor'}</button>
          </div>
        )}
      </td>
    </tr>
  )
}

function LoadingState() {
  return <div className="flex min-h-64 flex-1 items-center justify-center gap-2 text-sm text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Cargando Brands Bsale...</div>
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-3 text-center"><AlertCircle className="h-8 w-8 text-red-400" /><p className="text-sm text-theme-text-muted">No fue posible cargar la relación Brand/Proveedor.</p><button onClick={onRetry} className="h-8 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text hover:bg-theme-text/5">Reintentar</button></div>
}

function EmptyState() {
  return <div className="flex min-h-64 flex-1 flex-col items-center justify-center gap-2 text-center"><Search className="h-8 w-8 text-theme-text-muted/40" /><p className="text-sm font-semibold text-theme-text">No hay Brands para mostrar</p><p className="text-xs text-theme-text-muted">Prueba con otros filtros o espera una nueva sincronización de catálogo.</p></div>
}

function ConfirmationDialog({ target, busy, onCancel, onConfirm }: { target: LinkTarget; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Modal title="Confirmar vínculo" onClose={onCancel}>
    <div className="space-y-4"><div className="rounded-lg border border-theme-border bg-theme-text/[0.03] p-3 text-xs"><p className="text-theme-text-muted">Vincular Brand Bsale</p><p className="mt-1 text-lg font-bold text-theme-text">Brand {target.brand.bsale_brand_id}</p><p className="mt-3 text-theme-text-muted">con proveedor REAL PetGroup</p><p className="mt-1 font-semibold text-theme-text">{target.supplierName}</p><p className="mt-1 text-theme-text-muted">{target.supplierRut ?? 'Sin RUT disponible'}</p></div><div className="grid grid-cols-2 gap-2 text-xs"><Evidence label="Productos cubiertos" value={coverage(target.brand)} /><Evidence label="Clasificación" value={classificationLabels[target.brand.classification]} /></div><p className="text-xs leading-5 text-theme-text-muted">Esta acción requiere aprobación humana. No crea proveedores ni modifica productos o mappings.</p><div className="flex justify-end gap-2"><button onClick={onCancel} disabled={busy} className="h-8 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text-muted">Cancelar</button><button onClick={onConfirm} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white hover:bg-theme-accent-hover">{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Confirmar vínculo</button></div></div>
  </Modal>
}

function UnlinkDialog({ candidate, busy, onCancel, onConfirm }: { candidate: BsaleBrandSupplierCandidate; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  return <Modal title="Desvincular Brand Bsale" onClose={onCancel}><div className="space-y-4"><p className="text-sm leading-6 text-theme-text-muted">Se eliminará solamente el vínculo entre <strong className="text-theme-text">Brand {candidate.bsale_brand_id}</strong> y <strong className="text-theme-text">{candidate.linked_supplier_name}</strong>.</p><p className="text-xs leading-5 text-theme-text-muted">No se elimina el Brand ni se modifica ningún producto, mapping o proveedor.</p><div className="flex justify-end gap-2"><button onClick={onCancel} disabled={busy} className="h-8 rounded-lg border border-theme-border px-3 text-xs font-semibold text-theme-text-muted">Cancelar</button><button onClick={onConfirm} disabled={busy} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-red-500 px-3 text-xs font-semibold text-white hover:bg-red-600">{busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Confirmar desvinculación</button></div></div></Modal>
}

function SupplierPicker({ suppliers, loading, search, onSearch, onSelect, onCancel }: { suppliers: Supplier[]; loading: boolean; search: string; onSearch: (value: string) => void; onSelect: (supplier: Supplier) => void; onCancel: () => void }) {
  return <Modal title="Seleccionar proveedor REAL" onClose={onCancel}><div className="space-y-3"><p className="text-xs text-theme-text-muted">Sólo se muestran proveedores REAL activos de la empresa. No puedes crear proveedores desde aquí.</p><div className="relative"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-theme-text-muted/50" /><input autoFocus value={search} onChange={event => onSearch(event.target.value)} placeholder="Buscar por nombre o RUT..." className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface pl-9 pr-3 text-xs text-theme-text outline-none focus:border-theme-accent" /></div><div className="max-h-64 overflow-y-auto rounded-lg border border-theme-border">{loading ? <div className="flex items-center justify-center gap-2 p-6 text-xs text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Cargando proveedores...</div> : suppliers.length === 0 ? <p className="p-6 text-center text-xs text-theme-text-muted">No se encontraron proveedores REAL activos.</p> : suppliers.map(supplier => <button key={supplier.id} onClick={() => onSelect(supplier)} className="flex w-full items-center justify-between border-b border-theme-border/50 px-3 py-2.5 text-left last:border-0 hover:bg-theme-text/5"><span className="min-w-0"><span className="block truncate text-xs font-semibold text-theme-text">{supplier.business_name}</span><span className="mt-0.5 block text-[10px] text-theme-text-muted">{supplier.rut ?? 'Sin RUT'}</span></span><ChevronDown className="h-3.5 w-3.5 -rotate-90 text-theme-text-muted" /></button>)}</div></div></Modal>
}

function Evidence({ label, value }: { label: string; value: string }) {
  return <div className="rounded-lg border border-theme-border bg-theme-text/[0.03] p-2"><div className="text-[10px] text-theme-text-muted">{label}</div><div className="mt-1 font-semibold text-theme-text">{value}</div></div>
}

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-label={title}><div className="w-full max-w-lg rounded-2xl border border-theme-border bg-theme-surface p-5 shadow-2xl"><div className="mb-4 flex items-center justify-between"><h3 className="text-base font-bold text-theme-text">{title}</h3><button onClick={onClose} className="rounded-lg p-1.5 text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text" aria-label="Cerrar"><X className="h-4 w-4" /></button></div>{children}</div></div>
}
