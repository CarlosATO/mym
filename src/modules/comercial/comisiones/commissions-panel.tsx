'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, Check, RefreshCw, Save, Settings2, UsersRound } from 'lucide-react'
import {
  getCommissionEligibleSummary,
  getCommissionSellers,
  upsertCommissionSellerProfile,
  type CommissionEligibleSummary,
  type CommissionSeller,
  type CommissionSellerProfileInput,
  type CommissionSellerType,
} from '@/app/actions/comercial/commissions'
import { cn } from '@/lib/utils'

type SellerDraft = Omit<CommissionSellerProfileInput, 'seller_bsale_id'>
type View = 'main' | 'configuration'

const sellerTypeOptions: Array<{ value: CommissionSellerType; label: string }> = [
  { value: 'FIELD', label: 'Terreno' },
  { value: 'ADMIN', label: 'Administración' },
  { value: 'MANAGEMENT', label: 'Gerencia' },
  { value: 'DISPATCH', label: 'Despacho' },
  { value: 'OTHER', label: 'Otro' },
]

function today() {
  return new Date().toISOString().slice(0, 10)
}

function initialDraft(seller: CommissionSeller): SellerDraft {
  return {
    seller_name: seller.seller_name || '',
    is_commissionable: seller.is_commissionable,
    seller_type: seller.seller_type,
    active: seller.profile_active ?? true,
    notes: seller.notes || '',
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : 'No se pudo completar la operación'
}

function statusClass(seller: CommissionSeller) {
  if (!seller.seller_profile_id) return 'border-amber-400/25 bg-amber-500/10 text-amber-500'
  if (seller.is_commissionable && seller.profile_active) return 'border-emerald-400/25 bg-emerald-500/10 text-emerald-500'
  return 'border-theme-border bg-theme-text/5 text-theme-text-muted'
}

function statusLabel(seller: CommissionSeller) {
  if (!seller.seller_profile_id) return 'Sin perfil'
  if (seller.is_commissionable && seller.profile_active) return 'Comisionable'
  return 'No comisionable'
}

function formatMoney(value: number) {
  return `$${value.toLocaleString('es-CL', { maximumFractionDigits: 0 })}`
}

export function CommissionsPanel() {
  const [view, setView] = useState<View>('main')
  const [sellers, setSellers] = useState<CommissionSeller[]>([])
  const [drafts, setDrafts] = useState<Record<number, SellerDraft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [savedId, setSavedId] = useState<number | null>(null)
  const [selectedSellerId, setSelectedSellerId] = useState('')
  const [periodFrom, setPeriodFrom] = useState('2026-06-26')
  const [periodTo, setPeriodTo] = useState(today)
  const [summary, setSummary] = useState<CommissionEligibleSummary | null>(null)
  const [loadingSummary, setLoadingSummary] = useState(false)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const rows = await getCommissionSellers()
      setSellers(rows)
      setDrafts(Object.fromEntries(rows.map(seller => [seller.seller_bsale_id, initialDraft(seller)])))
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    const handle = setTimeout(() => { void load() }, 0)
    return () => clearTimeout(handle)
  }, [])

  const commissionableSellers = sellers.filter(seller => seller.is_commissionable && seller.profile_active === true)
  const selectedSeller = commissionableSellers.find(seller => seller.seller_bsale_id === Number(selectedSellerId)) || null

  const loadSummary = async (sellerId = selectedSellerId, useSuggestedPeriod = false) => {
    if (!sellerId) return
    setLoadingSummary(true)
    setError(null)
    try {
      const nextSummary = await getCommissionEligibleSummary({
        seller_bsale_id: Number(sellerId),
        period_from: useSuggestedPeriod ? undefined : periodFrom,
        period_to: periodTo,
      })
      setSummary(nextSummary)
      setPeriodFrom(nextSummary.period_from)
    } catch (err) {
      setError(errorMessage(err))
      setSummary(null)
    } finally {
      setLoadingSummary(false)
    }
  }

  const selectSeller = (sellerId: string) => {
    setSelectedSellerId(sellerId)
    setSummary(null)
    if (sellerId) void loadSummary(sellerId, true)
  }

  const updateDraft = (sellerId: number, updates: Partial<SellerDraft>) => {
    setDrafts(current => ({ ...current, [sellerId]: { ...current[sellerId], ...updates } }))
    setSavedId(null)
  }

  const save = async (seller: CommissionSeller) => {
    const draft = drafts[seller.seller_bsale_id]
    if (!draft || savingId !== null) return

    setSavingId(seller.seller_bsale_id)
    setError(null)
    try {
      await upsertCommissionSellerProfile({ seller_bsale_id: seller.seller_bsale_id, ...draft })
      setSavedId(seller.seller_bsale_id)
      await load()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setSavingId(null)
    }
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-theme-surface">
      <header className="shrink-0 border-b border-theme-border/60 px-4 py-3 md:px-5">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <UsersRound className="h-4 w-4 text-theme-accent" />
              <h2 className="font-accent text-lg font-semibold text-theme-text">Comisiones de Vendedores</h2>
            </div>
            <p className="mt-1 text-sm text-theme-text-muted/70">
              {view === 'main' ? 'Selecciona un vendedor comisionable para revisar sus facturas pagadas pendientes de liquidación.' : 'Configura qué vendedores detectados desde Bsale son comisionables.'}
            </p>
          </div>
          {view === 'main' ? (
            <button type="button" onClick={() => setView('configuration')} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text">
              <Settings2 className="h-3.5 w-3.5" /> Configuración
            </button>
          ) : (
            <button type="button" onClick={() => setView('main')} className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text">
              <ArrowLeft className="h-3.5 w-3.5" /> Volver a comisiones
            </button>
          )}
        </div>
      </header>

      {error && <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-500"><AlertCircle className="h-4 w-4 shrink-0" />{error}</div>}

      {view === 'main' ? (
        <main className="flex-1 overflow-auto p-4 md:p-6">
          {loading ? (
            <div className="flex h-full items-center justify-center"><RefreshCw className="h-5 w-5 animate-spin text-theme-accent" /></div>
          ) : commissionableSellers.length === 0 ? (
            <section className="mx-auto mt-10 max-w-xl rounded-2xl border border-theme-border bg-theme-bg/35 p-7 text-center">
              <UsersRound className="mx-auto h-8 w-8 text-theme-text-muted/30" />
              <h3 className="mt-4 text-base font-semibold text-theme-text">No hay vendedores comisionables configurados.</h3>
              <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-theme-text-muted/70">Configura vendedores para comenzar a simular comisiones.</p>
              <button type="button" onClick={() => setView('configuration')} className="mt-5 inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-bold text-white transition-colors hover:bg-theme-accent-hover">
                <Settings2 className="h-3.5 w-3.5" /> Configurar vendedores
              </button>
            </section>
          ) : (
            <section className="mx-auto max-w-3xl space-y-4">
              <div className="rounded-2xl border border-theme-border bg-theme-bg/35 p-4 md:p-5">
                <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_150px_150px_auto] md:items-end">
                  <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted/65">Vendedor</span><select value={selectedSellerId} onChange={event => selectSeller(event.target.value)} className="h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-accent"><option value="">Selecciona un vendedor</option>{commissionableSellers.map(seller => <option key={seller.seller_bsale_id} value={seller.seller_bsale_id}>{seller.seller_name || `Vendedor ${seller.seller_bsale_id}`}</option>)}</select></label>
                  <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted/65">Desde</span><input type="date" value={periodFrom} max={periodTo} onChange={event => { setPeriodFrom(event.target.value); setSummary(null) }} className="h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
                  <label className="block"><span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted/65">Hasta</span><input type="date" value={periodTo} min={periodFrom} max={today()} onChange={event => { setPeriodTo(event.target.value); setSummary(null) }} className="h-10 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-accent" /></label>
                  <button type="button" onClick={() => void loadSummary()} disabled={!selectedSellerId || loadingSummary} className="h-10 rounded-lg bg-theme-accent px-3 text-xs font-bold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{loadingSummary ? 'Consultando...' : 'Actualizar'}</button>
                </div>
              </div>

              {selectedSeller && (
                <section className="rounded-2xl border border-theme-border bg-theme-surface p-5">
                  <div className="flex flex-col gap-1 border-b border-theme-border/60 pb-4 md:flex-row md:items-baseline md:justify-between"><div><div className="text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted/60">Vendedor seleccionado</div><h3 className="mt-1 text-base font-semibold text-theme-text">{selectedSeller.seller_name}</h3></div><span className="text-xs text-theme-text-muted/65">Período: {periodFrom} a {periodTo}</span></div>
                  {loadingSummary ? <div className="py-8 text-center text-sm text-theme-text-muted"><RefreshCw className="mr-2 inline h-4 w-4 animate-spin text-theme-accent" />Consultando líneas elegibles...</div> : summary ? <div className="grid gap-3 py-5 sm:grid-cols-2"><div className="rounded-xl border border-theme-border/70 bg-theme-bg/40 p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/60">Líneas elegibles</div><div className="mt-1 text-xl font-bold text-theme-text">{summary.lines_count.toLocaleString('es-CL')}</div></div><div className="rounded-xl border border-theme-border/70 bg-theme-bg/40 p-3"><div className="text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/60">Neto elegible</div><div className="mt-1 text-xl font-bold text-theme-text">{formatMoney(summary.total_net_amount)}</div></div></div> : <div className="py-7 text-sm text-theme-text-muted/65">Selecciona el vendedor para consultar su base pendiente de liquidación.</div>}
                  <p className="border-t border-theme-border/60 pt-4 text-sm leading-relaxed text-theme-text-muted/70">Vista de simulación en preparación. En la siguiente fase se calcularán facturas pagadas, reglas aplicadas y total de comisión.</p>
                </section>
              )}
            </section>
          )}
        </main>
      ) : (
        <section className="min-h-0 flex-1 overflow-auto">
          <div className="flex items-center justify-between border-b border-theme-border/60 px-4 py-2 text-[11px] text-theme-text-muted/60"><span>Configuración → Vendedores</span><button type="button" onClick={() => void load()} disabled={loading || savingId !== null} className="inline-flex items-center gap-1.5 font-semibold text-theme-text-muted hover:text-theme-text disabled:opacity-50"><RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Recargar</button></div>
          {loading && sellers.length === 0 ? <div className="flex h-40 items-center justify-center"><RefreshCw className="h-5 w-5 animate-spin text-theme-accent" /></div> : sellers.length === 0 ? <div className="flex h-40 flex-col items-center justify-center gap-2 text-theme-text-muted"><UsersRound className="h-8 w-8 opacity-25" /><p className="text-sm">No hay vendedores detectados desde Bsale.</p></div> : <table className="w-full min-w-[1050px] border-collapse text-xs"><thead className="sticky top-0 z-10 bg-theme-surface"><tr className="border-b border-theme-border text-left text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/65"><th className="px-4 py-2.5">Vendedor</th><th className="px-3 py-2.5 text-right">Docs / pagadas</th><th className="px-3 py-2.5">Perfil</th><th className="px-3 py-2.5">Tipo</th><th className="px-3 py-2.5 text-center">Comisionable</th><th className="px-3 py-2.5 text-center">Activo</th><th className="px-3 py-2.5">Notas</th><th className="px-4 py-2.5 text-right">Acción</th></tr></thead><tbody>{sellers.map(seller => { const draft = drafts[seller.seller_bsale_id] || initialDraft(seller); const isSaving = savingId === seller.seller_bsale_id; return <tr key={seller.seller_bsale_id} className="border-b border-theme-border/60 hover:bg-theme-text/[0.025]"><td className="px-4 py-3"><div className="font-semibold text-theme-text">{seller.seller_name || `Vendedor ${seller.seller_bsale_id}`}</div><div className="mt-0.5 font-mono text-[10px] text-theme-text-muted/45">Bsale #{seller.seller_bsale_id}</div></td><td className="px-3 py-3 text-right whitespace-nowrap text-theme-text-muted"><span className="font-semibold text-theme-text">{seller.docs_count.toLocaleString('es-CL')}</span><span className="mx-1 text-theme-text-muted/35">/</span>{seller.paid_invoices_count.toLocaleString('es-CL')}</td><td className="px-3 py-3"><span className={cn('inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold', statusClass(seller))}>{statusLabel(seller)}</span></td><td className="px-3 py-3"><select value={draft.seller_type} onChange={event => updateDraft(seller.seller_bsale_id, { seller_type: event.target.value as CommissionSellerType })} className="h-8 rounded-lg border border-theme-border bg-theme-bg px-2 text-xs text-theme-text outline-none focus:border-theme-accent">{sellerTypeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}</select></td><td className="px-3 py-3 text-center"><input type="checkbox" checked={draft.is_commissionable} onChange={event => updateDraft(seller.seller_bsale_id, { is_commissionable: event.target.checked })} aria-label={`Marcar ${seller.seller_name || seller.seller_bsale_id} como comisionable`} className="h-4 w-4 accent-[var(--theme-accent)]" /></td><td className="px-3 py-3 text-center"><input type="checkbox" checked={draft.active} onChange={event => updateDraft(seller.seller_bsale_id, { active: event.target.checked })} aria-label={`Activar perfil de ${seller.seller_name || seller.seller_bsale_id}`} className="h-4 w-4 accent-[var(--theme-accent)]" /></td><td className="px-3 py-3"><input value={draft.notes} onChange={event => updateDraft(seller.seller_bsale_id, { notes: event.target.value })} placeholder="Opcional" className="h-8 w-full min-w-[180px] rounded-lg border border-theme-border bg-theme-bg px-2 text-xs text-theme-text placeholder:text-theme-text-muted/40 outline-none focus:border-theme-accent" /></td><td className="px-4 py-3 text-right"><button type="button" onClick={() => void save(seller)} disabled={savingId !== null} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-2.5 text-xs font-bold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50">{isSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : savedId === seller.seller_bsale_id ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}{isSaving ? 'Guardando' : savedId === seller.seller_bsale_id ? 'Guardado' : 'Guardar'}</button></td></tr> })}</tbody></table>}
        </section>
      )}
    </div>
  )
}
