'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, RefreshCw, Save, Settings2, SlidersHorizontal, UsersRound, X } from 'lucide-react'
import {
  getCommissionGroups, getCommissionRules, getCommissionSettings, getCommissionSellers,
  previewCommissionSettlement, searchCommissionSuppliers, updateCommissionSettings,
  upsertCommissionSellerProfile,
  type CommissionGroup, type CommissionPreview, type CommissionPreviewLine, type CommissionRule,
  type CommissionSeller, type CommissionSellerProfileInput, type CommissionSellerType, type CommissionSettings,
} from '@/app/actions/comercial/commissions'
import { cn } from '@/lib/utils'
import { CommissionGroupsConfig } from './commission-groups-config'
import { CommissionRulesWizard } from './commission-rules-wizard'

type View = 'main' | 'configuration'
type ConfigTab = 'sellers' | 'general' | 'groups' | 'rules'
type SellerDraft = Omit<CommissionSellerProfileInput, 'seller_bsale_id'>

const sellerTypes: Array<{ value: CommissionSellerType; label: string }> = [
  { value: 'FIELD', label: 'Terreno' }, { value: 'ADMIN', label: 'Administración' }, { value: 'MANAGEMENT', label: 'Gerencia' }, { value: 'DISPATCH', label: 'Despacho' }, { value: 'OTHER', label: 'Otro' },
]

function today() { return new Date().toISOString().slice(0, 10) }
function money(value: number) { return `$${value.toLocaleString('es-CL', { maximumFractionDigits: 0 })}` }
function errorMessage(error: unknown) { return error instanceof Error ? error.message : 'No se pudo completar la operación' }
function sellerDraft(seller: CommissionSeller): SellerDraft { return { seller_name: seller.seller_name || '', is_commissionable: seller.is_commissionable, seller_type: seller.seller_type, active: seller.profile_active ?? true, notes: seller.notes || '' } }

export function CommissionsPanel() {
  const [view, setView] = useState<View>('main')
  const [tab, setTab] = useState<ConfigTab>('sellers')
  const [sellers, setSellers] = useState<CommissionSeller[]>([])
  const [drafts, setDrafts] = useState<Record<number, SellerDraft>>({})
  const [settings, setSettings] = useState<CommissionSettings | null>(null)
  const [groups, setGroups] = useState<CommissionGroup[]>([])
  const [rules, setRules] = useState<CommissionRule[]>([])
  const [sellerId, setSellerId] = useState('')
  const [periodFrom, setPeriodFrom] = useState('2026-06-26')
  const [periodTo, setPeriodTo] = useState(today)
  const [preview, setPreview] = useState<CommissionPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadSellers = async () => {
    setLoading(true); setError(null)
    try { const rows = await getCommissionSellers(); setSellers(rows); setDrafts(Object.fromEntries(rows.map(row => [row.seller_bsale_id, sellerDraft(row)]))) }
    catch (err) { setError(errorMessage(err)) } finally { setLoading(false) }
  }
  const loadConfig = async () => {
    setBusy(true); setError(null)
    try {
      const [nextSettings, nextGroups, nextRules] = await Promise.all([getCommissionSettings(), getCommissionGroups(), getCommissionRules(), searchCommissionSuppliers('')])
      setSettings(nextSettings); setGroups(nextGroups); setRules(nextRules)
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  useEffect(() => { const handle = setTimeout(() => { void loadSellers() }, 0); return () => clearTimeout(handle) }, [])

  const commissionable = sellers.filter(seller => seller.is_commissionable && seller.profile_active === true)
  const openConfig = () => { setView('configuration'); void loadConfig() }
  const simulate = async (id = sellerId) => {
    if (!id || id !== sellerId) return
    setBusy(true); setError(null)
    try { const result = await previewCommissionSettlement({ seller_bsale_id: Number(id), period_from: periodFrom, period_to: periodTo }); setPreview(result); if (result.summary.period_from) setPeriodFrom(result.summary.period_from) }
    catch (err) { setError(errorMessage(err)); setPreview(null) } finally { setBusy(false) }
  }
  const saveSeller = async (seller: CommissionSeller) => {
    const input = drafts[seller.seller_bsale_id]; if (!input) return
    setBusy(true); try { await upsertCommissionSellerProfile({ seller_bsale_id: seller.seller_bsale_id, ...input }); await loadSellers() } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  return <div className="commission-panel flex h-full min-h-0 flex-col overflow-hidden bg-theme-surface text-theme-text">
    <Header view={view} onConfig={openConfig} onBack={() => setView('main')} />
    {error && <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-theme-text"><AlertCircle className="h-4 w-4 text-red-600" />{error}</div>}
    {view === 'main' ? <main className="flex-1 overflow-auto px-4 py-4 md:px-6">{loading ? <Loading /> : commissionable.length === 0 ? <Empty onConfig={openConfig} /> : <div className="w-full space-y-4"><section className="rounded-xl border border-theme-border bg-theme-bg/35 p-4"><div className="grid gap-3 md:grid-cols-[1fr_150px_150px_auto]"><Field label="Vendedor"><select value={sellerId} onChange={event => { setSellerId(event.target.value); setPreview(null); if (event.target.value) void simulate(event.target.value) }}><option value="">Selecciona un vendedor</option>{commissionable.map(seller => <option key={seller.seller_bsale_id} value={seller.seller_bsale_id}>{seller.seller_name}</option>)}</select></Field><Field label="Desde"><input type="date" value={periodFrom} max={periodTo} onChange={event => { setPeriodFrom(event.target.value); setPreview(null) }} /></Field><Field label="Hasta"><input type="date" value={periodTo} min={periodFrom} max={today()} onChange={event => { setPeriodTo(event.target.value); setPreview(null) }} /></Field><button disabled={!sellerId || busy} onClick={() => void simulate()} className="btn-primary self-end">{busy ? 'Simulando...' : 'Simular'}</button></div></section>{preview && <PreviewReport preview={preview} />}</div>}</main> : <Configuration tab={tab} setTab={setTab} sellers={sellers} drafts={drafts} settings={settings} groups={groups} rules={rules} busy={busy} onSellerChange={(id, changes) => setDrafts(current => ({ ...current, [id]: { ...current[id], ...changes } }))} onSaveSeller={saveSeller} onSettingsChange={percent => setSettings(current => current ? { ...current, default_commission_percent: percent } : current)} onSaveSettings={async () => { if (!settings) return; setBusy(true); try { setSettings(await updateCommissionSettings({ default_commission_percent: settings.default_commission_percent })) } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) } }} onRefresh={loadConfig} setError={setError} />}
  </div>
}

function Header({ view, onConfig, onBack }: { view: View; onConfig: () => void; onBack: () => void }) { return <><header className="shrink-0 border-b border-theme-border px-4 py-3 md:px-5"><div className="flex items-center justify-between gap-3"><div><div className="flex items-center gap-2"><UsersRound className="h-4 w-4 text-theme-accent" /><h2 className="font-accent text-lg font-semibold">Comisiones de Vendedores</h2></div><p className="mt-1 text-sm text-theme-text-muted">{view === 'main' ? 'Simulación. No emite liquidación ni bloquea facturas.' : 'Configuración de vendedores, comisión general, grupos y reglas.'}</p></div>{view === 'main' ? <button onClick={onConfig} className="btn-secondary"><Settings2 className="h-3.5 w-3.5" />Configuración</button> : <button onClick={onBack} className="btn-secondary"><ArrowLeft className="h-3.5 w-3.5" />Volver a comisiones</button>}</div></header><CommissionStyles /></> }
function CommissionStyles() { return <style jsx global>{`.commission-panel .btn-primary,.commission-panel .btn-secondary{display:inline-flex;align-items:center;justify-content:center;gap:.375rem;min-height:2rem;border-radius:.5rem;padding:.35rem .7rem;font-size:.75rem;font-weight:700}.commission-panel .btn-primary{background:var(--theme-accent);color:#fff}.commission-panel .btn-secondary{border:1px solid var(--theme-border);background:var(--theme-surface);color:var(--theme-text)}.commission-panel input,.commission-panel select{width:100%;border:1px solid var(--theme-border);border-radius:.5rem;background:var(--theme-surface);color:var(--theme-text);padding:.45rem .6rem;font-size:.75rem}.commission-panel table,.commission-panel th,.commission-panel td{color:var(--theme-text)!important}.commission-panel th{background:var(--theme-bg);padding:.55rem .6rem;text-align:left}.commission-panel td{padding:.55rem .6rem;border-top:1px solid var(--theme-border)}.commission-panel tbody tr:hover{background:var(--theme-surface-hover)}`}</style> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">{label}<span className="mt-1 block">{children}</span></label> }
function Loading() { return <div className="flex h-40 items-center justify-center"><RefreshCw className="h-5 w-5 animate-spin text-theme-accent" /></div> }
function Empty({ onConfig }: { onConfig: () => void }) { return <section className="mx-auto mt-10 max-w-xl rounded-xl border border-theme-border bg-theme-bg/35 p-7 text-center"><UsersRound className="mx-auto h-8 w-8 text-theme-text-muted" /><h3 className="mt-4 font-semibold">No hay vendedores comisionables configurados.</h3><p className="mt-2 text-sm text-theme-text-muted">Configura vendedores para comenzar a simular comisiones.</p><button onClick={onConfig} className="btn-primary mt-5"><Settings2 className="h-3.5 w-3.5" />Configurar vendedores</button></section> }

function PreviewReport({ preview }: { preview: CommissionPreview }) {
  const [filters, setFilters] = useState({ invoice: '', supplier: '', product: '', rule: '', percent: '' })
  const filtered = preview.lines.filter(line => String(line.invoice_number || line.invoice_bsale_id).includes(filters.invoice.trim()) && `${line.supplier_name || ''} ${line.commission_group_name || ''}`.toLowerCase().includes(filters.supplier.trim().toLowerCase()) && `${line.sku || ''} ${line.product_name || ''}`.toLowerCase().includes(filters.product.trim().toLowerCase()) && line.applied_rule_label.toLowerCase().includes(filters.rule.trim().toLowerCase()) && (!filters.percent || String(line.commission_percent) === filters.percent))
  const net = filtered.reduce((sum, line) => sum + line.net_amount, 0)
  const commission = filtered.reduce((sum, line) => sum + line.commission_amount, 0)
  const invoices = new Set(filtered.map(line => line.invoice_bsale_id)).size
  const general = filtered.filter(line => line.warning_code === 'DEFAULT_RULE_USED').length
  const percentages = Array.from(new Set(preview.lines.map(line => line.commission_percent))).sort((a, b) => a - b)
  const ruleLabels = Array.from(new Set(preview.lines.map(line => line.applied_rule_label))).sort((a, b) => a.localeCompare(b, 'es'))
  return <section className="space-y-3"><div className="rounded-xl border border-theme-border bg-theme-bg/35 px-3 py-2"><div className="grid gap-x-5 gap-y-1 sm:grid-cols-2 lg:grid-cols-5"><Kpi label="Facturas" value={invoices.toLocaleString('es-CL')} /><Kpi label="Líneas" value={filtered.length.toLocaleString('es-CL')} /><Kpi label="Neto" value={money(net)} /><Kpi label="Comisión estimada" value={money(commission)} /><Kpi label="% efectivo" value={`${net ? (commission / net * 100).toFixed(2) : '0.00'}%`} /></div></div><div className="rounded-xl border border-theme-border bg-theme-surface p-3"><div className="mb-2 flex items-center gap-2 text-xs font-semibold text-theme-text"><SlidersHorizontal className="h-3.5 w-3.5 text-theme-accent" />Filtros de simulación</div><div className="grid gap-2 md:grid-cols-2 xl:grid-cols-[180px_1fr_1fr_1fr_140px_auto]"><input value={filters.invoice} onChange={e => setFilters(current => ({ ...current, invoice: e.target.value }))} placeholder="Factura" /><input value={filters.supplier} onChange={e => setFilters(current => ({ ...current, supplier: e.target.value }))} placeholder="Proveedor o grupo" /><input value={filters.product} onChange={e => setFilters(current => ({ ...current, product: e.target.value }))} placeholder="SKU o producto" /><select value={filters.rule} onChange={e => setFilters(current => ({ ...current, rule: e.target.value }))}><option value="">Todas las reglas</option>{ruleLabels.map(label => <option key={label} value={label}>{label}</option>)}</select><select value={filters.percent} onChange={e => setFilters(current => ({ ...current, percent: e.target.value }))}><option value="">Todos los %</option>{percentages.map(percent => <option key={percent} value={percent}>{percent}%</option>)}</select><button onClick={() => setFilters({ invoice: '', supplier: '', product: '', rule: '', percent: '' })} className="btn-secondary"><X className="h-3.5 w-3.5" />Limpiar</button></div></div>{general > 0 && <div className="rounded-lg border border-theme-border bg-theme-bg px-3 py-2 text-xs text-theme-text"><b>{general}</b> usando comisión general para línea sin regla específica.</div>}<PreviewTable lines={filtered} /></section>
}
function Kpi({ label, value }: { label: string; value: string }) { return <div className="flex items-baseline justify-between gap-2 border-b border-theme-border py-1.5 last:border-0 lg:block lg:border-0"><span className="text-[10px] font-semibold uppercase tracking-wide text-theme-text-muted">{label}</span><span className="text-base font-bold">{value}</span></div> }
function PreviewTable({ lines }: { lines: CommissionPreviewLine[] }) { return <div className="overflow-auto rounded-xl border border-theme-border"><table className="min-w-[1180px] w-full text-xs"><thead><tr><th>Factura</th><th>Cliente</th><th>Pago</th><th>SKU / Producto</th><th>Proveedor / Grupo</th><th className="text-right">Cant.</th><th className="text-right">Neto</th><th>Regla</th><th className="text-right">%</th><th className="text-right">Comisión</th></tr></thead><tbody>{lines.map(line => <tr key={line.invoice_line_id}><td>{line.invoice_number || line.invoice_bsale_id}</td><td className="max-w-[180px] truncate">{line.customer_name}</td><td>{line.payment_completed_at?.slice(0, 10)}</td><td><b>{line.sku}</b><div>{line.product_name}</div></td><td><div>{line.supplier_name}</div><div>{line.commission_group_name || 'Sin grupo'}</div></td><td className="text-right">{line.quantity}</td><td className="text-right">{money(line.net_amount)}</td><td><b>{line.applied_rule_label}</b>{line.rule_id && <div className="mt-0.5 text-[10px] text-theme-text-muted">{line.applied_rule_scope}</div>}</td><td className="text-right">{line.commission_percent}%</td><td className="text-right font-semibold">{money(line.commission_amount)}</td></tr>)}</tbody></table>{lines.length === 0 && <div className="p-6 text-center text-sm text-theme-text-muted">No hay líneas que coincidan con los filtros.</div>}</div> }

function Configuration({ tab, setTab, sellers, drafts, settings, groups, rules, busy, onSellerChange, onSaveSeller, onSettingsChange, onSaveSettings, onRefresh, setError }: { tab: ConfigTab; setTab: (tab: ConfigTab) => void; sellers: CommissionSeller[]; drafts: Record<number, SellerDraft>; settings: CommissionSettings | null; groups: CommissionGroup[]; rules: CommissionRule[]; busy: boolean; onSellerChange: (id: number, changes: Partial<SellerDraft>) => void; onSaveSeller: (seller: CommissionSeller) => void; onSettingsChange: (percent: number) => void; onSaveSettings: () => void; onRefresh: () => Promise<void>; setError: (message: string | null) => void }) { return <main className="min-h-0 flex-1 overflow-auto"><div className="flex gap-1 border-b border-theme-border px-4 pt-3">{(['sellers', 'general', 'groups', 'rules'] as ConfigTab[]).map(item => <button key={item} onClick={() => setTab(item)} className={cn('rounded-t-lg px-3 py-2 text-xs font-semibold', tab === item ? 'bg-theme-accent-muted text-theme-text' : 'text-theme-text-muted hover:bg-theme-surface-hover')}>{({ sellers: 'Vendedores', general: 'General', groups: 'Grupos', rules: 'Reglas' })[item]}</button>)}</div><div className="p-4">{tab === 'sellers' ? <SellerTable sellers={sellers} drafts={drafts} busy={busy} onSellerChange={onSellerChange} onSaveSeller={onSaveSeller} /> : tab === 'general' ? <General settings={settings} busy={busy} onSettingsChange={onSettingsChange} onSaveSettings={onSaveSettings} /> : tab === 'groups' ? <CommissionGroupsConfig groups={groups} onSaved={onRefresh} setError={message => setError(message)} /> : <CommissionRulesWizard sellers={sellers} groups={groups} rules={rules} onSaved={onRefresh} onError={message => setError(message)} />}</div></main> }
function SellerTable({ sellers, drafts, busy, onSellerChange, onSaveSeller }: { sellers: CommissionSeller[]; drafts: Record<number, SellerDraft>; busy: boolean; onSellerChange: (id: number, changes: Partial<SellerDraft>) => void; onSaveSeller: (seller: CommissionSeller) => void }) { return <div className="overflow-auto rounded-xl border border-theme-border"><table className="min-w-[900px] w-full text-xs"><thead><tr><th>Vendedor</th><th>Tipo</th><th>Comisionable</th><th>Activo</th><th>Notas</th><th /></tr></thead><tbody>{sellers.map(seller => { const row = drafts[seller.seller_bsale_id] || sellerDraft(seller); return <tr key={seller.seller_bsale_id}><td><b>{seller.seller_name}</b><div>{seller.paid_invoices_count} facturas pagadas</div></td><td><select value={row.seller_type} onChange={e => onSellerChange(seller.seller_bsale_id, { seller_type: e.target.value as CommissionSellerType })}>{sellerTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></td><td className="text-center"><input type="checkbox" checked={row.is_commissionable} onChange={e => onSellerChange(seller.seller_bsale_id, { is_commissionable: e.target.checked })} /></td><td className="text-center"><input type="checkbox" checked={row.active} onChange={e => onSellerChange(seller.seller_bsale_id, { active: e.target.checked })} /></td><td><input value={row.notes} onChange={e => onSellerChange(seller.seller_bsale_id, { notes: e.target.value })} /></td><td><button disabled={busy} onClick={() => onSaveSeller(seller)} className="btn-primary"><Save className="h-3.5 w-3.5" />Guardar</button></td></tr> })}</tbody></table></div> }
function General({ settings, busy, onSettingsChange, onSaveSettings }: { settings: CommissionSettings | null; busy: boolean; onSettingsChange: (percent: number) => void; onSaveSettings: () => void }) { if (!settings) return <Loading />; return <div className="w-full rounded-xl border border-theme-border bg-theme-bg/30 p-4"><div className="grid gap-3 md:grid-cols-4"><Field label="Comisión general (%)"><input type="number" min="0" max="100" step="0.01" value={settings.default_commission_percent} onChange={e => onSettingsChange(Number(e.target.value))} /></Field><div className="text-sm"><b>Base:</b> NET<br /><b>Pago completo:</b> Sí</div><div className="text-sm"><b>Cierre histórico:</b> {settings.historical_cutoff_date}<br /><b>Primer día elegible:</b> {settings.first_eligible_date}</div><button disabled={busy} onClick={onSaveSettings} className="btn-primary self-end"><Save className="h-3.5 w-3.5" />Guardar</button></div></div> }
