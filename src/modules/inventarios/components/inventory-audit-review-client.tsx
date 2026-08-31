'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { notifyInventoryNavigation } from '@/modules/inventarios/components/inventory-navigation-feedback'
import {
  AlertTriangle,
  ArrowLeft,
  Building2,
  Check,
  CheckCircle2,
  ChevronDown,
  ClipboardCheck,
  Loader2,
  MapPin,
  RefreshCw,
  Search,
  X,
} from 'lucide-react'
import {
  getActiveCompanyAuditCandidates,
  getActiveCompanyAuditEligibleParticipants,
  getActiveCompanyAuditSearchScopes,
  getActiveCompanyCreateAudit,
  type ActiveAuditSummary,
  type AuditCandidatesResult,
  type AuditCandidateItem,
  type AuditSearchScopesResult,
  type AuditSearchScopeSection,
  type AuditSortBy,
  type AuditSortDirection,
  type AuditVarianceStatus,
  type EligibleAuditParticipant,
} from '@/app/actions/inventarios/audit-review'
import { InventoryAuditResolutionDialog } from '@/modules/inventarios/components/inventory-audit-resolution-client'
import { InventoryAuditDetailDialog } from '@/modules/inventarios/components/inventory-audit-detail-dialog'
import { getActiveCompanyAuditResolvableAudits, type ResolvableAuditSummary } from '@/app/actions/inventarios/audit-resolution'
import { formatQuantity, formatSignedQuantity } from '@/modules/inventarios/lib/format'

const PAGE_SIZE = 50

const VARIANCE_OPTIONS: { value: AuditVarianceStatus | ''; label: string }[] = [
  { value: '', label: 'Faltantes y sobrantes' },
  { value: 'FALTANTE', label: 'Faltantes' },
  { value: 'SOBRANTE', label: 'Sobrantes' },
]

function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function VarianceBadge({ status }: { status: string }) {
  if (status === 'FALTANTE') {
    return (
      <span className="inline-flex items-center rounded-full border border-red-500/25 bg-red-500/10 px-2 py-0.5 text-[11px] font-medium text-red-700 dark:text-red-300">
        FALTANTE
      </span>
    )
  }
  return (
    <span className="inline-flex items-center rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
      SOBRANTE
    </span>
  )
}

// Distingue visualmente el alcance de ubicaciones del candidato.
// Sin ubicación previa: el administrador debe indicar dónde buscarlo al asignar la auditoría.
function ScopeBadge({ status }: { status: string }) {
  if (status === 'NO_PREVIOUS_LOCATION') {
    return (
      <span
        title="Sin ubicación conocida: al asignar la auditoría deberás indicar en qué bodega/sección y zonas buscar."
        className="inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
      >
        <MapPin className="h-3 w-3" />
        Sin ubicación previa
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/20 bg-sky-500/5 px-2 py-0.5 text-[10px] font-medium text-sky-700 dark:text-sky-300">
      <Check className="h-3 w-3" />
      Con ubicación conocida
    </span>
  )
}

// Traduce errores de negocio del backend a mensajes de usuario sin detalles técnicos.
function auditErrorMessage(businessCode: string | undefined, fallback: string | null): string {
  switch (businessCode) {
    case 'SEARCH_SCOPE_REQUIRED':
      return 'Debes indicar dónde buscar este producto.'
    case 'SEARCH_SCOPE_INVALID':
      return 'El alcance seleccionado ya no es válido. Actualiza las opciones e inténtalo nuevamente.'
    case 'PRODUCT_ALREADY_ASSIGNED':
      return 'Uno de los productos ya tiene una auditoría activa.'
    default:
      return fallback ?? 'No se pudo crear la auditoría.'
  }
}

interface InventoryAuditReviewClientProps {
  campaignId: string
  companyId: string
  campaignName: string
  campaignStatus: string | null
  initialCandidates: AuditCandidatesResult | null
  initialParticipants: EligibleAuditParticipant[] | null
  canManageCampaigns: boolean
}

// Estado de alcance configurado por producto (solo aplica a NO_PREVIOUS_LOCATION).
interface ProductScopeState {
  session_id: string
  zone_ids: string[]
}

function SearchScopeConfig({
  product,
  scope,
  sections,
  onSectionChange,
  onToggleZone,
}: {
  product: AuditCandidateItem
  scope: ProductScopeState | undefined
  sections: AuditSearchScopeSection[]
  onSectionChange: (variant: number, sessionId: string) => void
  onToggleZone: (variant: number, zoneId: string) => void
}) {
  const currentSection = sections.find(s => s.session_id === scope?.session_id)
  const zones = currentSection?.zones ?? []
  const missingSection = !scope?.session_id
  const missingZone = Boolean(scope?.session_id) && (scope?.zone_ids.length ?? 0) === 0

  return (
    <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-xs font-semibold text-theme-text">
            {product.sku ?? '—'} · {product.name ?? `V${product.bsale_variant_id}`}
          </p>
          <span className="mt-0.5 inline-flex items-center gap-1 rounded-full border border-amber-500/25 bg-amber-500/10 px-2 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
            <MapPin className="h-3 w-3" />
            Sin ubicación previa
          </span>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-theme-text-muted">Indica dónde debe buscar este producto:</p>

      <div className="mt-1.5 space-y-2">
        <div>
          <label className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
            <Building2 className="h-3 w-3" />
            Bodega / Sección
          </label>
          <select
            value={scope?.session_id ?? ''}
            onChange={e => onSectionChange(product.bsale_variant_id, e.target.value)}
            aria-label={`Bodega o sección para ${product.name ?? product.sku}`}
            className="h-8 w-full rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text shadow-sm outline-none focus:border-theme-border-accent"
          >
            <option value="">Seleccionar bodega/sección</option>
            {sections.map(s => (
              <option key={s.session_id} value={s.session_id} title={s.session_name}>
                {s.site_name ?? s.session_name}
              </option>
            ))}
          </select>
          {missingSection && (
            <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
              <AlertTriangle className="h-3 w-3" />
              Indica la bodega/sección.
            </p>
          )}
        </div>

        <div>
          <label className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-theme-text-muted">
            <MapPin className="h-3 w-3" />
            Zona(s)
          </label>
          {!scope?.session_id ? (
            <p className="rounded-md border border-dashed border-theme-border px-2 py-1.5 text-[11px] text-theme-text-muted/70">
              Primero selecciona una bodega/sección.
            </p>
          ) : zones.length === 0 ? (
            <p className="rounded-md border border-dashed border-theme-border px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">
              Esta bodega/sección no tiene zonas habilitadas.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {zones.map(z => {
                  const active = scope?.zone_ids.includes(z.zone_id) ?? false
                  return (
                    <button
                      key={z.zone_id}
                      type="button"
                      onClick={() => onToggleZone(product.bsale_variant_id, z.zone_id)}
                      aria-pressed={active}
                      className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1 text-[11px] font-medium transition-colors ${
                        active
                          ? 'border-theme-accent bg-theme-accent/15 text-theme-accent'
                          : 'border-theme-border bg-theme-surface text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text'
                      }`}
                    >
                      {active && <Check className="h-3 w-3" />}
                      {z.zone_name ?? z.zone_code}
                    </button>
                  )
                })}
              </div>
              {missingZone && (
                <p className="mt-1 flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                  <AlertTriangle className="h-3 w-3" />
                  Selecciona al menos una zona.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

export function InventoryAuditReviewClient({
  campaignId,
  companyId,
  campaignName,
  campaignStatus,
  initialCandidates,
  initialParticipants,
  canManageCampaigns,
}: InventoryAuditReviewClientProps) {
  const router = useRouter()
  const [candidates, setCandidates] = useState<AuditCandidatesResult | null>(initialCandidates)
  const [participants, setParticipants] = useState<EligibleAuditParticipant[] | null>(initialParticipants)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [variance, setVariance] = useState<AuditVarianceStatus | ''>('')
  const [sortBy, setSortBy] = useState<AuditSortBy>('SKU')
  const [sortDir, setSortDir] = useState<AuditSortDirection>('ASC')
  const [page, setPage] = useState(1)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [pending, startTransition] = useTransition()
  const [refreshing, setRefreshing] = useState(false)
  const [revision, setRevision] = useState(0)
  const [assignOpen, setAssignOpen] = useState(false)
  const [assigning, setAssigning] = useState(false)
  const [assignParticipant, setAssignParticipant] = useState<string>('')
  const [assignSuccess, setAssignSuccess] = useState<string | null>(null)
  const [searchScopes, setSearchScopes] = useState<AuditSearchScopesResult | null>(null)
  const [searchScopesLoading, setSearchScopesLoading] = useState(false)
  const [searchScopesError, setSearchScopesError] = useState<string | null>(null)
  const [selectedScopes, setSelectedScopes] = useState<Record<number, ProductScopeState>>({})
  const idempotencyRef = useRef<string>('')
  const [resolutionAudit, setResolutionAudit] = useState<ResolvableAuditSummary | null>(null)
  const [resolvableAudits, setResolvableAudits] = useState<ResolvableAuditSummary[]>([])
  const [resolvableError, setResolvableError] = useState<string | null>(null)
  const [detailAudit, setDetailAudit] = useState<ActiveAuditSummary | null>(null)
  // Congelado: campaña APPROVED/CANCELLED → solo lectura (consultar historial,
  // sin asignar/resolver auditorías). El backend rechaza cualquier mutación.
  const frozen = campaignStatus === 'APPROVED' || campaignStatus === 'CANCELLED'

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const load = useCallback(
    async () => {
      if (!companyId) return
      const result = await getActiveCompanyAuditCandidates(campaignId, {
        search: debouncedSearch,
        variance_status: variance,
        page,
        page_size: PAGE_SIZE,
        sort_by: sortBy,
        sort_direction: sortDir,
      })
      if (result.error || !result.data) {
        setError(result.error ?? 'No se pudieron cargar los productos con diferencia.')
        return
      }
      setError(null)
      setCandidates(result.data)
      setSelected(current => {
        const next = new Set<number>()
        for (const id of current) {
          const item = result.data!.items.find(i => i.bsale_variant_id === id)
          if (item && item.selectable) next.add(id)
        }
        return next
      })
    },
    [companyId, campaignId, debouncedSearch, variance, page, sortBy, sortDir]
  )

  useEffect(() => {
    startTransition(async () => {
      await load()
    })
  }, [load, revision])

  const handleRefresh = useCallback(() => {
    setRefreshing(true)
    setRevision(r => r + 1)
    Promise.all([
      getActiveCompanyAuditCandidates(campaignId, {
        search: debouncedSearch,
        variance_status: variance,
        page,
        page_size: PAGE_SIZE,
        sort_by: sortBy,
        sort_direction: sortDir,
      }),
      getActiveCompanyAuditEligibleParticipants(campaignId),
    ]).then(([c, p]) => {
      if (c.data) setCandidates(c.data)
      if (c.error) setError(c.error)
      if (p.data) setParticipants(p.data.participants)
    }).finally(() => setRefreshing(false))
  }, [campaignId, debouncedSearch, variance, page, sortBy, sortDir])

  // Contrato read-only de resolución: auditorías SUBMITTED / PARTIALLY_RESOLVED aún resolubles.
  const loadResolvableAudits = useCallback(async () => {
    const result = await getActiveCompanyAuditResolvableAudits(campaignId)
    if (result.error || !result.data) {
      setResolvableError(result.error ?? 'No se pudieron cargar las auditorías pendientes de decisión.')
      return
    }
    setResolvableError(null)
    setResolvableAudits(result.data.items)
  }, [campaignId])

  useEffect(() => {
    startTransition(async () => {
      await loadResolvableAudits()
    })
  }, [loadResolvableAudits])

  // Tras resolver un producto se refresca el estado de la campaña sin recargar la página.
  const handleAuditResolved = useCallback(() => {
    setRevision(r => r + 1)
    void getActiveCompanyAuditEligibleParticipants(campaignId).then(r => {
      if (r.data) setParticipants(r.data.participants)
    })
    void loadResolvableAudits()
  }, [campaignId, loadResolvableAudits])

  const handleSort = useCallback((key: AuditSortBy) => {
    if (sortBy === key) {
      setSortDir(d => (d === 'ASC' ? 'DESC' : 'ASC'))
    } else {
      setSortBy(key)
      setSortDir('ASC')
    }
    setPage(1)
  }, [sortBy])

  const toggleSelect = useCallback((bsaleVariantId: number, selectable: boolean) => {
    if (!selectable || frozen) return
    if (selected.has(bsaleVariantId)) {
      // Deseleccionar también limpia el alcance configurado para evitar estado residual.
      setSelected(current => {
        const next = new Set(current)
        next.delete(bsaleVariantId)
        return next
      })
      setSelectedScopes(prev => {
        if (!prev[bsaleVariantId]) return prev
        const copy = { ...prev }
        delete copy[bsaleVariantId]
        return copy
      })
    } else {
      setSelected(current => {
        const next = new Set(current)
        next.add(bsaleVariantId)
        return next
      })
    }
  }, [selected, frozen])

  const toggleAll = useCallback(() => {
    if (frozen || !canManageCampaigns) return
    const selectableItems = candidates?.items.filter(i => i.selectable) ?? []
    if (selectableItems.length > 0 && selectableItems.every(i => selected.has(i.bsale_variant_id))) {
      setSelected(new Set())
      setSelectedScopes({})
      return
    }
    setSelected(new Set(selectableItems.map(i => i.bsale_variant_id)))
    setSelectedScopes({})
  }, [candidates, selected, frozen, canManageCampaigns])

  const openAssign = useCallback(() => {
    if (frozen || !canManageCampaigns) return
    setAssignSuccess(null)
    idempotencyRef.current = makeKey()
    setAssignOpen(true)
    // Solo hace falta el catálogo de bodegas/zonas si hay productos sin ubicación previa.
    const needsScopes = (candidates?.items ?? []).some(
      i => selected.has(i.bsale_variant_id) && i.scope_status === 'NO_PREVIOUS_LOCATION'
    )
    if (needsScopes && !searchScopes) {
      setSearchScopesLoading(true)
      setSearchScopesError(null)
      void getActiveCompanyAuditSearchScopes(campaignId).then(r => {
        setSearchScopesLoading(false)
        if (r.data) setSearchScopes(r.data)
        else setSearchScopesError(r.error ?? 'No se pudieron cargar las bodegas y zonas disponibles.')
      })
    }
  }, [candidates, selected, campaignId, searchScopes, frozen, canManageCampaigns])

  const closeAssign = useCallback(() => {
    setAssignOpen(false)
    setAssigning(false)
    setAssignParticipant('')
  }, [])

  const handleSectionChange = useCallback((variant: number, sessionId: string) => {
    // Cambiar de bodega/sección limpia las zonas previamente seleccionadas del producto.
    setSelectedScopes(prev => ({ ...prev, [variant]: { session_id: sessionId, zone_ids: [] } }))
  }, [])

  const handleToggleZone = useCallback((variant: number, zoneId: string) => {
    setSelectedScopes(prev => {
      const current = prev[variant] ?? { session_id: '', zone_ids: [] }
      const has = current.zone_ids.includes(zoneId)
      return {
        ...prev,
        [variant]: {
          ...current,
          zone_ids: has ? current.zone_ids.filter(z => z !== zoneId) : [...current.zone_ids, zoneId],
        },
      }
    })
  }, [])

  const handleAssign = useCallback(async () => {
    if (frozen || !canManageCampaigns) return
    if (assigning || selected.size === 0) return
    if (!assignParticipant) {
      setError('Debes seleccionar un auditor para continuar.')
      return
    }
    const items = (candidates?.items ?? []).filter(i => selected.has(i.bsale_variant_id))
    const nplItems = items.filter(i => i.scope_status === 'NO_PREVIOUS_LOCATION')
    const hasIncomplete = nplItems.some(p => {
      const s = selectedScopes[p.bsale_variant_id]
      return !s || !s.session_id || s.zone_ids.length === 0
    })
    if (hasIncomplete) {
      setError('Completa el alcance de búsqueda de los productos sin ubicación previa.')
      return
    }

    setAssigning(true)
    setError(null)
    const searchScopesPayload = nplItems.map(p => {
      const s = selectedScopes[p.bsale_variant_id]!
      return { bsale_variant_id: p.bsale_variant_id, session_id: s.session_id, zone_ids: s.zone_ids }
    })
    const result = await getActiveCompanyCreateAudit({
      campaignId,
      assignedParticipantId: assignParticipant,
      bsaleVariantIds: Array.from(selected),
      idempotencyKey: idempotencyRef.current,
      searchScopes: searchScopesPayload,
    })
    setAssigning(false)
    if (result.error || !result.data) {
      setError(auditErrorMessage(result.businessCode, result.error))
      setAssignOpen(false)
      return
    }
    setAssignSuccess(`Auditoría #${result.data.audit_number} creada con ${result.data.products.length} producto(s).`)
    setAssignOpen(false)
    setAssignParticipant('')
    setSelectedScopes({})
    setSelected(new Set())
    setPage(1)
    setRevision(r => r + 1)
    void getActiveCompanyAuditEligibleParticipants(campaignId).then(r => {
      if (r.data) setParticipants(r.data.participants)
    })
  }, [assigning, selected, assignParticipant, campaignId, candidates, selectedScopes, frozen, canManageCampaigns])

  const selectedCount = selected.size
  const totalPages = Math.max(1, Math.ceil((candidates?.total ?? 0) / PAGE_SIZE))
  const summary = candidates?.summary
  const items = candidates?.items ?? []

  const selectedItems = items.filter(i => selected.has(i.bsale_variant_id))
  const nplSelected = selectedItems.filter(i => i.scope_status === 'NO_PREVIOUS_LOCATION')
  const resolvedSelected = selectedItems.filter(i => i.scope_status !== 'NO_PREVIOUS_LOCATION')
  const scopeSections = (searchScopes?.sections ?? []).filter(s => s.zones.length > 0)
  const hasIncompleteScope = nplSelected.some(p => {
    const s = selectedScopes[p.bsale_variant_id]
    return !s || !s.session_id || s.zone_ids.length === 0
  })
  const canConfirm =
    !assigning && Boolean(assignParticipant) && selectedCount > 0 && !hasIncompleteScope

  const clearFilters = useCallback(() => {
    setSearch('')
    setVariance('')
    setSortBy('SKU')
    setSortDir('ASC')
    setPage(1)
    setSelected(new Set())
    setSelectedScopes({})
  }, [])

  const hasFilters = Boolean(search.trim() || variance)

  return (
    <div className="space-y-3">
      <nav className="flex items-center gap-1.5 text-xs text-theme-text-muted">
        <span>Inventarios</span>
        <span>/</span>
        <span className="font-medium text-theme-text">Revisar diferencias</span>
      </nav>

      {/* Cabecera */}
      <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="flex items-center gap-2 text-base font-bold text-theme-text">
              <ClipboardCheck className="h-4 w-4 text-theme-text-muted/60" />
              Revisar diferencias
            </h1>
            <p className="text-[11px] text-theme-text-muted">{campaignName}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {campaignStatus && (
              <span className="inline-flex items-center rounded-full border border-theme-border bg-theme-text/5 px-2.5 py-1 text-[11px] font-medium text-theme-text-muted">
                {campaignStatus}
              </span>
            )}
            <button
              type="button"
              onClick={handleRefresh}
              disabled={refreshing}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
            >
              {refreshing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {refreshing ? 'Actualizando…' : 'Actualizar'}
            </button>
            <button
              type="button"
              onClick={() => { notifyInventoryNavigation(); router.push(`/dashboard/inventarios/campanas/${campaignId}?tab=informe`) }}
              className="inline-flex h-7 items-center gap-1 rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Volver al informe
            </button>
          </div>
        </div>
        <p className="mt-1.5 text-[11px] text-theme-text-muted/70">
          Muestra únicamente productos con diferencia distinta de cero ({`física − teórica`}). La auditoría se asigna a un
          participante apto y no altera el resultado del inventario.
        </p>
        {frozen && (
          <p className="mt-1.5 rounded-lg border border-theme-border bg-theme-text/5 px-3 py-2 text-[11px] text-theme-text-muted">
            Este inventario está cerrado (solo lectura). No se pueden asignar ni resolver auditorías; el historial
            permanece consultable.
          </p>
        )}
      </section>

      {/* Resumen */}
      <section className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl border border-theme-border bg-theme-surface px-4 py-3 shadow-sm sm:grid-cols-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Con diferencia</p>
          <p className="text-base font-bold text-theme-text">{formatQuantity(summary?.total_differences ?? 0)}</p>
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Faltantes</p>
          <p className="text-base font-bold text-red-600 dark:text-red-400">{formatQuantity(summary?.faltantes ?? 0)}</p>
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">Sobrantes</p>
          <p className="text-base font-bold text-emerald-600 dark:text-emerald-400">{formatQuantity(summary?.sobrantes ?? 0)}</p>
        </div>
        <div className="flex flex-col gap-0.5">
          <p className="text-[10px] uppercase tracking-wider text-theme-text-muted/60">En auditoría</p>
          <p className="text-base font-bold text-sky-600 dark:text-sky-400">{formatQuantity(summary?.audited_products ?? 0)}</p>
        </div>
      </section>

      {/* Auditorías pendientes de decisión (flujo de resolución: SUBMITTED + PARTIALLY_RESOLVED) */}
      {(() => {
        if (resolvableAudits.length === 0 && !resolvableError) return null
        return (
          <section className="rounded-xl border border-amber-500/20 bg-theme-surface px-4 py-2.5 shadow-sm">
            <h3 className="flex items-center gap-1.5 text-xs font-bold text-theme-text">
              <ClipboardCheck className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
              Auditorías pendientes de decisión
            </h3>
            {resolvableError && (
              <div className="mt-1.5 flex items-center justify-between gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
                <span>{resolvableError}</span>
                <button
                  type="button"
                  onClick={() => void loadResolvableAudits()}
                  className="rounded-md border border-theme-border bg-theme-surface px-2 py-0.5 text-[11px] font-medium text-theme-text hover:bg-theme-text/5"
                >
                  Reintentar
                </button>
              </div>
            )}
            {resolvableAudits.length === 0 ? (
              <p className="mt-1.5 text-[11px] text-theme-text-muted/70">No hay auditorías pendientes de decisión.</p>
            ) : (
              <div className="mt-1.5 space-y-1.5">
                {resolvableAudits.map((a: ResolvableAuditSummary) => (
                  <div
                    key={a.audit_id}
                    className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/25 bg-amber-500/5 px-2.5 py-2 text-[11px] text-theme-text"
                  >
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="font-semibold">Auditoría #{a.audit_number}</span>
                      <span
                        className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[9px] font-semibold ${
                          a.status === 'PARTIALLY_RESOLVED'
                            ? 'border-violet-500/25 bg-violet-500/10 text-violet-700 dark:text-violet-300'
                            : 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                        }`}
                      >
                        {a.status === 'PARTIALLY_RESOLVED' ? 'PARCIALMENTE RESUELTA' : 'POR RESOLVER'}
                      </span>
                      <span className="text-theme-text-muted">·</span>
                      <span>{a.auditor_name ?? 'Sin asignar'}</span>
                      <span className="text-theme-text-muted">·</span>
                      <span>
                        {a.pending_count} pendiente(s) de decisión · {a.product_count} producto(s) en {a.location_count}{' '}
                        ubicación(es)
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setResolutionAudit(a)}
                      disabled={frozen}
                      className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      <ClipboardCheck className="h-3.5 w-3.5" />
                      Resolver
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )
      })()}

      {/* Auditorías en curso */}
      {(() => {
        const activeAudits = (candidates?.active_audits ?? []).filter(a => a.status !== 'SUBMITTED')
        if (activeAudits.length === 0) return null
        return (
          <section className="rounded-xl border border-theme-border bg-theme-surface px-4 py-2.5 shadow-sm">
            <h3 className="text-xs font-bold text-theme-text">Auditorías en curso</h3>
            <div className="mt-1.5 flex flex-wrap gap-2">
              {activeAudits.map((a: ActiveAuditSummary) => (
                <button
                  type="button"
                  onClick={() => setDetailAudit(a)}
                  key={a.audit_id}
                  className="flex cursor-pointer items-center gap-2 rounded-lg border border-sky-500/25 bg-sky-500/10 px-2.5 py-1.5 text-left text-[11px] text-theme-text transition-colors hover:border-sky-500/45 hover:bg-sky-500/15 focus:outline-none focus:ring-2 focus:ring-theme-accent/40"
                  aria-label={`Abrir detalle de auditoría número ${a.audit_number}`}
                >
                  <CheckCircle2 className="h-3.5 w-3.5 text-sky-600 dark:text-sky-400" />
                  <span className="font-semibold">Auditoría #{a.audit_number}</span>
                  <span className="text-theme-text-muted">·</span>
                  <span>{a.auditor_name ?? 'Sin asignar'}</span>
                  <span className="text-theme-text-muted">·</span>
                  <span>
                    {a.product_count} producto(s) · {a.location_count} ubicación(es) · {a.search_scope_count} alcance(s)
                  </span>
                </button>
              ))}
            </div>
          </section>
        )
      })()}

      {assignSuccess && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-700 dark:text-emerald-300">
          <span>{assignSuccess}</span>
          <button
            type="button"
            onClick={() => setAssignSuccess(null)}
            className="rounded-md border border-theme-border bg-theme-surface px-2 py-0.5 text-[11px] font-medium text-theme-text hover:bg-theme-text/5"
          >
            <X className="h-3 w-3" />
          </button>
        </div>
      )}

      {detailAudit && (
        <InventoryAuditDetailDialog
          companyId={companyId}
          campaignId={campaignId}
          auditId={detailAudit.audit_id}
          onClose={() => setDetailAudit(null)}
        />
      )}

      {error && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-xs text-red-600 dark:text-red-400">
          <span>{error}</span>
          <button
            type="button"
            onClick={handleRefresh}
            className="rounded-md border border-theme-border bg-theme-surface px-2 py-0.5 text-[11px] font-medium text-theme-text hover:bg-theme-text/5"
          >
            Reintentar
          </button>
        </div>
      )}

      {/* Filtros + selección */}
      <div className="flex flex-wrap items-center gap-1.5">
        <div className="relative min-w-[180px] flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-theme-text-muted/50" />
          <input
            value={search}
            onChange={e => {
              setSearch(e.target.value)
              setPage(1)
            }}
            placeholder="Buscar por SKU o producto"
            aria-label="Buscar producto"
            className="h-7 w-full rounded-lg border border-theme-border bg-theme-surface pl-8 pr-2.5 text-xs text-theme-text shadow-sm outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
          />
        </div>
        <select
          value={variance}
          onChange={e => {
            setVariance(e.target.value as AuditVarianceStatus | '')
            setPage(1)
          }}
          aria-label="Filtrar por clasificación"
          className="h-7 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text shadow-sm outline-none focus:border-theme-border-accent"
        >
          {VARIANCE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        {hasFilters && (
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex h-7 items-center gap-1 rounded-lg px-2 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <X className="h-3.5 w-3.5" />
            Limpiar
          </button>
        )}
        {selectedCount > 0 && (
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <span className="text-xs text-theme-text-muted">
              <strong className="text-theme-text">{selectedCount}</strong> seleccionado(s)
            </span>
            <button
              type="button"
              onClick={openAssign}
              disabled={frozen}
              className="inline-flex h-7 items-center gap-1 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
            >
              <ClipboardCheck className="h-3.5 w-3.5" />
              Asignar auditoría
            </button>
          </div>
        )}
      </div>

      {/* Tabla */}
      <section className="relative overflow-hidden rounded-xl border border-theme-border bg-theme-surface shadow-sm">
        {pending && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-start justify-center pt-8">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-theme-border bg-theme-surface/90 px-3 py-1 text-[11px] font-medium text-theme-text-muted shadow-sm">
              <Loader2 className="h-3 w-3 animate-spin" />
              Actualizando…
            </span>
          </div>
        )}
        <div className={pending ? 'overflow-x-auto opacity-60 transition-opacity' : 'overflow-x-auto transition-opacity'}>
          <table className="w-full min-w-[820px] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-theme-border bg-theme-text/[0.03] text-[10px] uppercase tracking-wider text-theme-text-muted">
                <th className="w-10 px-3 py-2">
                  <input
                    type="checkbox"
                    checked={items.length > 0 && items.every(i => !i.selectable || selected.has(i.bsale_variant_id))}
                    onChange={toggleAll}
                    disabled={frozen}
                    aria-label="Seleccionar todos"
                    className="h-3.5 w-3.5 accent-theme-accent disabled:cursor-not-allowed disabled:opacity-40"
                  />
                </th>
                <th className="px-3 py-2">
                  <button type="button" onClick={() => handleSort('SKU')} className="inline-flex items-center gap-1 hover:text-theme-text">
                    SKU
                    <ChevronDown className={`h-3 w-3 ${sortBy === 'SKU' ? (sortDir === 'ASC' ? 'rotate-180' : '') : 'opacity-30'}`} />
                  </button>
                </th>
                <th className="px-3 py-2">
                  <button type="button" onClick={() => handleSort('NAME')} className="inline-flex items-center gap-1 hover:text-theme-text">
                    Producto
                    <ChevronDown className={`h-3 w-3 ${sortBy === 'NAME' ? (sortDir === 'ASC' ? 'rotate-180' : '') : 'opacity-30'}`} />
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button type="button" onClick={() => handleSort('THEORETICAL')} className="inline-flex items-center gap-1 hover:text-theme-text">
                    Stock teórico
                    <ChevronDown className={`h-3 w-3 ${sortBy === 'THEORETICAL' ? (sortDir === 'ASC' ? 'rotate-180' : '') : 'opacity-30'}`} />
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button type="button" onClick={() => handleSort('PHYSICAL')} className="inline-flex items-center gap-1 hover:text-theme-text">
                    Contado efectivo
                    <ChevronDown className={`h-3 w-3 ${sortBy === 'PHYSICAL' ? (sortDir === 'ASC' ? 'rotate-180' : '') : 'opacity-30'}`} />
                  </button>
                </th>
                <th className="px-3 py-2 text-right">
                  <button type="button" onClick={() => handleSort('DIFFERENCE')} className="inline-flex items-center gap-1 hover:text-theme-text">
                    Diferencia
                    <ChevronDown className={`h-3 w-3 ${sortBy === 'DIFFERENCE' ? (sortDir === 'ASC' ? 'rotate-180' : '') : 'opacity-30'}`} />
                  </button>
                </th>
                <th className="px-3 py-2">Clasificación</th>
                <th className="px-3 py-2">Auditoría</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-4 py-10 text-center text-xs text-theme-text-muted/70">
                    No hay productos con diferencia para los filtros seleccionados.
                  </td>
                </tr>
              ) : (
                items.map(item => {
                  const isSelected = selected.has(item.bsale_variant_id)
                  const inAudit = Boolean(item.audit_id)
                  return (
                    <tr key={item.bsale_variant_id} className={`border-b border-theme-border/50 ${isSelected ? 'bg-theme-accent/5' : ''}`}>
                      <td className="px-3 py-2">
                        <input
                          type="checkbox"
                          checked={isSelected}
                          disabled={!item.selectable || frozen}
                          onChange={() => toggleSelect(item.bsale_variant_id, item.selectable)}
                          title={inAudit ? 'Este producto ya tiene una auditoría activa.' : 'Seleccionar para auditar'}
                          aria-label={`Seleccionar ${item.name ?? item.sku ?? item.bsale_variant_id}`}
                          className="h-3.5 w-3.5 accent-theme-accent disabled:cursor-not-allowed disabled:opacity-40"
                        />
                      </td>
                      <td className="px-3 py-2 font-medium text-theme-text">{item.sku ?? '—'}</td>
                      <td className="max-w-[220px] px-3 py-2 text-theme-text">{item.name ?? `V${item.bsale_variant_id}`}</td>
                      <td className="px-3 py-2 text-right text-theme-text">{formatQuantity(item.theoretical_quantity)}</td>
                      <td className="px-3 py-2 text-right text-theme-text">{formatQuantity(item.physical_quantity)}</td>
                      <td className="px-3 py-2 text-right">
                        <span
                          className={
                            item.difference_quantity < 0
                              ? 'font-semibold text-red-600 dark:text-red-400'
                              : 'font-semibold text-emerald-600 dark:text-emerald-400'
                          }
                        >
                          {formatSignedQuantity(item.difference_quantity)}
                        </span>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col items-start gap-1">
                          <VarianceBadge status={item.variance_status} />
                          <ScopeBadge status={item.scope_status} />
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        {inAudit ? (
                          <div className="flex flex-col items-start gap-0.5">
                            <span className="inline-flex items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/10 px-2 py-0.5 text-[11px] font-medium text-sky-700 dark:text-sky-300">
                              <CheckCircle2 className="h-3 w-3" />
                              {item.audit_status ?? 'EN AUDITORÍA'}
                            </span>
                            <span className="text-[10px] text-theme-text-muted">
                              {item.auditor_name ?? 'Sin asignar'}
                              {item.audit_number ? ` · #${item.audit_number}` : ''}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[11px] text-theme-text-muted/60">Sin auditoría</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Paginación */}
      {candidates && (
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-theme-text-muted/70">
            Mostrando {candidates.total === 0 ? 0 : (candidates.page - 1) * PAGE_SIZE + 1}–
            {Math.min(candidates.page * PAGE_SIZE, candidates.total)} de {candidates.total} productos
          </p>
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={candidates.page <= 1}
              onClick={() => setPage(candidates.page - 1)}
              className="flex h-7 items-center rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              Anterior
            </button>
            <span className="px-1 text-xs font-medium text-theme-text-muted">
              {candidates.page} / {totalPages}
            </span>
            <button
              type="button"
              disabled={!candidates.has_more}
              onClick={() => setPage(candidates.page + 1)}
              className="flex h-7 items-center rounded-lg border border-theme-border bg-theme-surface px-2.5 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-40"
            >
              Siguiente
            </button>
          </div>
        </div>
      )}

      {/* Diálogo de asignación */}
      {assignOpen && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl border border-theme-border bg-theme-surface shadow-2xl">
            <div className="flex items-center justify-between border-b border-theme-border px-4 py-3">
              <h2 className="text-sm font-bold text-theme-text">Asignar auditoría</h2>
              <button
                type="button"
                onClick={closeAssign}
                className="rounded-md p-1 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                aria-label="Cerrar"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              {nplSelected.length > 0 && (
                <section className="mb-4 space-y-3">
                  <div>
                    <h3 className="text-xs font-bold text-theme-text">Alcance de búsqueda</h3>
                    <p className="text-[11px] text-theme-text-muted">
                      {nplSelected.length === 1
                        ? 'Este producto no tiene una ubicación conocida. Indica dónde debe buscarlo el auditor dentro del inventario.'
                        : 'Estos productos no tienen una ubicación conocida. Indica dónde debe buscarlos el auditor dentro del inventario.'}
                    </p>
                  </div>

                  {searchScopesLoading && (
                    <p className="flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-[11px] text-theme-text-muted">
                      <Loader2 className="h-3 w-3 animate-spin" />
                      Cargando bodegas y zonas disponibles…
                    </p>
                  )}

                  {!searchScopesLoading && searchScopesError && (
                    <p className="flex items-center gap-1.5 rounded-lg border border-red-500/20 bg-red-500/5 px-3 py-2 text-[11px] text-red-600 dark:text-red-400">
                      <AlertTriangle className="h-3 w-3" />
                      {searchScopesError}
                    </p>
                  )}

                  {!searchScopesLoading && !searchScopesError && scopeSections.length === 0 && (
                    <p className="flex items-center gap-1.5 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                      <AlertTriangle className="h-3 w-3" />
                      No hay bodegas/secciones con zonas habilitadas en este inventario. No se puede asignar la auditoría.
                    </p>
                  )}

                  {nplSelected.map(p => (
                    <SearchScopeConfig
                      key={p.bsale_variant_id}
                      product={p}
                      scope={selectedScopes[p.bsale_variant_id]}
                      sections={scopeSections}
                      onSectionChange={handleSectionChange}
                      onToggleZone={handleToggleZone}
                    />
                  ))}

                  {resolvedSelected.length > 0 && (
                    <p className="rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2 text-[11px] text-theme-text-muted">
                      {resolvedSelected.length === 1
                        ? '1 producto con ubicación conocida no requiere alcance adicional.'
                        : `${resolvedSelected.length} productos con ubicación conocida no requieren alcance adicional.`}
                    </p>
                  )}
                </section>
              )}

              {/* Auditor */}
              <section className="mb-4">
                <h3 className="text-xs font-bold text-theme-text">Auditor</h3>
                <p className="mb-2 text-[11px] text-theme-text-muted">
                  Selecciona el participante apto que realizará la auditoría de{' '}
                  <strong className="text-theme-text">{selectedCount}</strong> producto(s). La auditoría se crea como una
                  única tarea para el mismo auditor.
                </p>
                {participants && participants.length > 0 ? (
                  <div className="space-y-1.5">
                    {participants.map(p => {
                      const active = assignParticipant === p.participant_id
                      return (
                        <label
                          key={p.participant_id}
                          className={`flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
                            active
                              ? 'border-theme-border-accent bg-theme-accent/10'
                              : 'border-theme-border bg-theme-surface hover:bg-theme-text/5'
                          }`}
                        >
                          <input
                            type="radio"
                            name="audit-participant"
                            checked={active}
                            onChange={() => setAssignParticipant(p.participant_id)}
                            className="h-3.5 w-3.5 accent-theme-accent"
                          />
                          <div className="flex-1">
                            <p className="font-medium text-theme-text">{p.user_name ?? p.email}</p>
                            <p className="text-[10px] text-theme-text-muted">{p.email}</p>
                          </div>
                          <span className="rounded-full border border-theme-border bg-theme-text/5 px-2 py-0.5 text-[10px] font-medium text-theme-text-muted">
                            {p.participant_role}
                          </span>
                        </label>
                      )
                    })}
                  </div>
                ) : (
                  <p className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-700 dark:text-amber-300">
                    No hay participantes aptos (COUNTER activo) en este inventario.
                  </p>
                )}
              </section>

              {/* Resumen previo a confirmar */}
              {selectedItems.length > 0 && (
                <section className="rounded-lg border border-theme-border bg-theme-text/[0.03] px-3 py-2.5">
                  <h3 className="text-xs font-bold text-theme-text">Resumen de la asignación</h3>
                  <ul className="mt-1.5 space-y-1.5">
                    {selectedItems.map(p => {
                      if (p.scope_status === 'NO_PREVIOUS_LOCATION') {
                        const s = selectedScopes[p.bsale_variant_id]
                        const section = scopeSections.find(x => x.session_id === s?.session_id)
                        const zones = section?.zones.filter(z => s?.zone_ids.includes(z.zone_id)) ?? []
                        const complete = Boolean(s?.session_id) && s!.zone_ids.length > 0
                        return (
                          <li key={p.bsale_variant_id} className="text-[11px] text-theme-text">
                            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                              <span className="font-medium">{p.sku ?? '—'}</span>
                              <span className="text-theme-text-muted">·</span>
                              <span className="truncate text-theme-text-muted">{p.name ?? `V${p.bsale_variant_id}`}</span>
                              <span className="rounded-full border border-amber-500/25 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-medium text-amber-700 dark:text-amber-300">
                                Sin ubicación previa
                              </span>
                            </div>
                            {complete ? (
                              <p className="mt-0.5 text-[10px] text-theme-text-muted">
                                Buscar en: <span className="font-medium text-theme-text">{section!.site_name ?? section!.session_name}</span>
                                {zones.length > 0 && (
                                  <>
                                    {' · '}
                                    {zones.map(z => z.zone_name ?? z.zone_code).join(', ')}
                                  </>
                                )}
                              </p>
                            ) : (
                              <p className="mt-0.5 flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                <AlertTriangle className="h-3 w-3" />
                                Pendiente: indica bodega/sección y al menos una zona.
                              </p>
                            )}
                          </li>
                        )
                      }
                      return (
                        <li key={p.bsale_variant_id} className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-theme-text">
                          <span className="font-medium">{p.sku ?? '—'}</span>
                          <span className="text-theme-text-muted">·</span>
                          <span className="truncate text-theme-text-muted">{p.name ?? `V${p.bsale_variant_id}`}</span>
                          <span className="rounded-full border border-sky-500/20 bg-sky-500/5 px-1.5 py-0.5 text-[9px] font-medium text-sky-700 dark:text-sky-300">
                            Con ubicación conocida
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                  <p className="mt-2 text-[10px] text-theme-text-muted/70">
                    Auditor seleccionado: <span className="font-medium text-theme-text">{assignParticipant ? (participants?.find(p => p.participant_id === assignParticipant)?.user_name ?? 'Seleccionar') : 'Sin seleccionar'}</span>
                  </p>
                </section>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-theme-border px-4 py-3">
              <button
                type="button"
                onClick={closeAssign}
                className="inline-flex h-8 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => void handleAssign()}
                disabled={!canConfirm}
                title={
                  hasIncompleteScope
                    ? 'Completa el alcance de búsqueda de los productos sin ubicación previa.'
                    : undefined
                }
                className="inline-flex h-8 items-center gap-1 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {assigning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ClipboardCheck className="h-3.5 w-3.5" />}
                {assigning ? 'Asignando…' : 'Confirmar asignación'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Diálogo de resolución administrativa por producto */}
      {resolutionAudit && (
        <InventoryAuditResolutionDialog
          key={resolutionAudit.audit_id}
          auditId={resolutionAudit.audit_id}
          auditNumber={resolutionAudit.audit_number}
          auditorName={resolutionAudit.auditor_name}
          onClose={() => setResolutionAudit(null)}
          onResolved={handleAuditResolved}
        />
      )}
    </div>
  )
}
