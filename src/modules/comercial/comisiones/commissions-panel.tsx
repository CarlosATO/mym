'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, Check, RefreshCw, Save, UsersRound } from 'lucide-react'
import {
  getCommissionSellers,
  upsertCommissionSellerProfile,
  type CommissionSeller,
  type CommissionSellerProfileInput,
  type CommissionSellerType,
} from '@/app/actions/comercial/commissions'
import { cn } from '@/lib/utils'

type SellerDraft = Omit<CommissionSellerProfileInput, 'seller_bsale_id'>

const sellerTypeOptions: Array<{ value: CommissionSellerType; label: string }> = [
  { value: 'FIELD', label: 'Terreno' },
  { value: 'ADMIN', label: 'Administración' },
  { value: 'MANAGEMENT', label: 'Gerencia' },
  { value: 'DISPATCH', label: 'Despacho' },
  { value: 'OTHER', label: 'Otro' },
]

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
  return error instanceof Error ? error.message : 'No se pudo guardar el perfil'
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

export function CommissionsPanel() {
  const [sellers, setSellers] = useState<CommissionSeller[]>([])
  const [drafts, setDrafts] = useState<Record<number, SellerDraft>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [savingId, setSavingId] = useState<number | null>(null)
  const [savedId, setSavedId] = useState<number | null>(null)

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
            <p className="mt-1 text-sm text-theme-text-muted/70">Configura qué vendedores detectados desde Bsale son comisionables.</p>
          </div>
          <button
            type="button"
            onClick={() => void load()}
            disabled={loading || savingId !== null}
            className="inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface px-3 text-xs font-semibold text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text disabled:cursor-not-allowed disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} /> Recargar
          </button>
        </div>
      </header>

      {error && (
        <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-sm text-red-500">
          <AlertCircle className="h-4 w-4 shrink-0" />{error}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {loading && sellers.length === 0 ? (
          <div className="flex h-full items-center justify-center"><RefreshCw className="h-5 w-5 animate-spin text-theme-accent" /></div>
        ) : sellers.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-theme-text-muted">
            <UsersRound className="h-8 w-8 opacity-25" />
            <p className="text-sm">No hay vendedores detectados desde Bsale.</p>
          </div>
        ) : (
          <table className="min-w-[1050px] w-full border-collapse text-xs">
            <thead className="sticky top-0 z-10 bg-theme-surface">
              <tr className="border-b border-theme-border text-left text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted/65">
                <th className="px-4 py-2.5">Vendedor</th>
                <th className="px-3 py-2.5 text-right">Docs / pagadas</th>
                <th className="px-3 py-2.5">Perfil</th>
                <th className="px-3 py-2.5">Tipo</th>
                <th className="px-3 py-2.5 text-center">Comisionable</th>
                <th className="px-3 py-2.5 text-center">Activo</th>
                <th className="px-3 py-2.5">Notas</th>
                <th className="px-4 py-2.5 text-right">Acción</th>
              </tr>
            </thead>
            <tbody>
              {sellers.map(seller => {
                const draft = drafts[seller.seller_bsale_id] || initialDraft(seller)
                const isSaving = savingId === seller.seller_bsale_id
                return (
                  <tr key={seller.seller_bsale_id} className="border-b border-theme-border/60 hover:bg-theme-text/[0.025]">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-theme-text">{seller.seller_name || `Vendedor ${seller.seller_bsale_id}`}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-theme-text-muted/45">Bsale #{seller.seller_bsale_id}</div>
                    </td>
                    <td className="px-3 py-3 text-right whitespace-nowrap text-theme-text-muted">
                      <span className="font-semibold text-theme-text">{seller.docs_count.toLocaleString('es-CL')}</span>
                      <span className="mx-1 text-theme-text-muted/35">/</span>
                      {seller.paid_invoices_count.toLocaleString('es-CL')}
                    </td>
                    <td className="px-3 py-3"><span className={cn('inline-flex rounded-md border px-2 py-0.5 text-[10px] font-bold', statusClass(seller))}>{statusLabel(seller)}</span></td>
                    <td className="px-3 py-3">
                      <select value={draft.seller_type} onChange={event => updateDraft(seller.seller_bsale_id, { seller_type: event.target.value as CommissionSellerType })} className="h-8 rounded-lg border border-theme-border bg-theme-bg px-2 text-xs text-theme-text outline-none focus:border-theme-accent">
                        {sellerTypeOptions.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-3 text-center">
                      <input type="checkbox" checked={draft.is_commissionable} onChange={event => updateDraft(seller.seller_bsale_id, { is_commissionable: event.target.checked })} aria-label={`Marcar ${seller.seller_name || seller.seller_bsale_id} como comisionable`} className="h-4 w-4 accent-[var(--theme-accent)]" />
                    </td>
                    <td className="px-3 py-3 text-center">
                      <input type="checkbox" checked={draft.active} onChange={event => updateDraft(seller.seller_bsale_id, { active: event.target.checked })} aria-label={`Activar perfil de ${seller.seller_name || seller.seller_bsale_id}`} className="h-4 w-4 accent-[var(--theme-accent)]" />
                    </td>
                    <td className="px-3 py-3"><input value={draft.notes} onChange={event => updateDraft(seller.seller_bsale_id, { notes: event.target.value })} placeholder="Opcional" className="h-8 w-full min-w-[180px] rounded-lg border border-theme-border bg-theme-bg px-2 text-xs text-theme-text placeholder:text-theme-text-muted/40 outline-none focus:border-theme-accent" /></td>
                    <td className="px-4 py-3 text-right">
                      <button type="button" onClick={() => void save(seller)} disabled={savingId !== null} className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-theme-accent px-2.5 text-xs font-bold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-50">
                        {isSaving ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : savedId === seller.seller_bsale_id ? <Check className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                        {isSaving ? 'Guardando' : savedId === seller.seller_bsale_id ? 'Guardado' : 'Guardar'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {!loading && sellers.length > 0 && <footer className="shrink-0 border-t border-theme-border/60 px-4 py-2 text-[11px] text-theme-text-muted/55">{sellers.length} vendedores detectados desde Bsale. Un perfil pendiente no genera comisión.</footer>}
    </div>
  )
}
