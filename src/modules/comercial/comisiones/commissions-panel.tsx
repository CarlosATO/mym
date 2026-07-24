'use client'

import { useEffect, useState } from 'react'
import { AlertCircle, ArrowLeft, Ban, Check, Download, FileText, FileUp, RefreshCw, Save, Settings2, SlidersHorizontal, UsersRound, X } from 'lucide-react'
import {
  getCommissionGroups, getCommissionRules, getCommissionSettings, getCommissionSellers,
  getCommissionAnnulledSettlements, getCommissionSettlementById, getCommissionSettlementDrafts, getCommissionSettlements,
  previewCommissionSettlement, searchCommissionSuppliers, updateCommissionSettings,
  upsertCommissionSellerProfile, annulCommissionSettlement, cancelCommissionSettlementDraft, createCommissionSettlementDraft,
  issueCommissionSettlement,
  type CommissionGroup, type CommissionPreview, type CommissionPreviewLine, type CommissionRule,
  type CommissionSeller, type CommissionSellerProfileInput, type CommissionSellerType, type CommissionSettings,
  type CommissionSettlementHeader, type CommissionSettlementLine,
} from '@/app/actions/comercial/commissions'
import { cn, parsePercent, formatPercent } from '@/lib/utils'
import { CommissionGroupsConfig } from './commission-groups-config'
import { CommissionRulesWizard } from './commission-rules-wizard'

type View = 'main' | 'configuration'
type ConfigTab = 'sellers' | 'general' | 'groups' | 'rules'
type MainTab = 'simulate' | 'drafts' | 'issued' | 'annulled'
type SellerDraft = Omit<CommissionSellerProfileInput, 'seller_bsale_id'>
type SettlementDetail = { header: CommissionSettlementHeader; lines: CommissionSettlementLine[] }

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
  const [mainTab, setMainTab] = useState<MainTab>('simulate')
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
  const [draftList, setDraftList] = useState<CommissionSettlementHeader[]>([])
  const [issuedList, setIssuedList] = useState<CommissionSettlementHeader[]>([])
  const [annulledList, setAnnulledList] = useState<CommissionSettlementHeader[]>([])
  const [settlementDetail, setSettlementDetail] = useState<SettlementDetail | null>(null)
  const [confirmAction, setConfirmAction] = useState<{ type: 'create_draft' | 'cancel' | 'issue' | 'annul'; settlementId?: string } | null>(null)
  const [cancelReason, setCancelReason] = useState('')
  const [pdfPreview, setPdfPreview] = useState<{ base64: string; filename: string } | null>(null)
  const [busyPdf, setBusyPdf] = useState<string | null>(null)
  const [busyExcel, setBusyExcel] = useState<string | null>(null)

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
  const loadDraftList = async () => {
    setBusy(true); setError(null)
    try { setDraftList(await getCommissionSettlementDrafts()) }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  const loadIssuedList = async () => {
    setBusy(true); setError(null)
    try { setIssuedList(await getCommissionSettlements({ status: 'ISSUED' })) }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  const loadAnnulledList = async () => {
    setBusy(true); setError(null)
    try { setAnnulledList(await getCommissionAnnulledSettlements()) }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  useEffect(() => { const handle = setTimeout(() => { void loadSellers() }, 0); return () => clearTimeout(handle) }, [])
  useEffect(() => { if (!error) return; const t = setTimeout(() => setError(null), error.includes('éxito') || error.includes('exitosamente') ? 3000 : 7000); return () => clearTimeout(t) }, [error])

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

  const doCreateDraft = async () => {
    if (!sellerId) return
    setConfirmAction(null); setBusy(true); setError(null)
    try {
      await createCommissionSettlementDraft({ seller_bsale_id: Number(sellerId), period_from: periodFrom, period_to: periodTo })
      setPreview(null)
      await loadDraftList()
      setMainTab('drafts')
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  const doCancelDraft = async () => {
    if (!confirmAction?.settlementId || !cancelReason.trim()) return
    const sid = confirmAction.settlementId
    setConfirmAction(null); setCancelReason(''); setBusy(true); setError(null)
    try {
      await cancelCommissionSettlementDraft({ settlement_id: sid, reason: cancelReason })
      setSettlementDetail(null)
      await loadDraftList()
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  const doIssue = async () => {
    if (!confirmAction?.settlementId) return
    const sid = confirmAction.settlementId
    setConfirmAction(null); setBusy(true); setError(null)
    try {
      await issueCommissionSettlement({ settlement_id: sid })
      setSettlementDetail(null)
      await loadIssuedList()
      setMainTab('issued')
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }
  const doAnnul = async () => {
    if (!confirmAction?.settlementId || !cancelReason.trim()) return
    const sid = confirmAction.settlementId
    const reason = cancelReason
    setConfirmAction(null); setCancelReason(''); setBusy(true); setError(null)
    try {
      await annulCommissionSettlement({ settlement_id: sid, reason })
      setSettlementDetail(null)
      await loadIssuedList()
      await loadAnnulledList()
      setMainTab('annulled')
    } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  const openDetail = async (id: string) => {
    setBusy(true); setError(null)
    try { setSettlementDetail(await getCommissionSettlementById(id)) }
    catch (err) { setError(errorMessage(err)) } finally { setBusy(false) }
  }

  const doPdf = async (id: string) => {
    setBusyPdf(id); setError(null)
    try {
      const { exportCommissionSettlementPdf } = await import('@/app/actions/comercial/commissions')
      const result = await exportCommissionSettlementPdf(id)
      setPdfPreview(result)
    } catch (err) { setError(errorMessage(err)) } finally { setBusyPdf(null) }
  }

  const downloadPdf = () => {
    if (!pdfPreview) return
    const binary = atob(pdfPreview.base64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    const blob = new Blob([bytes], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = pdfPreview.filename; a.click()
    URL.revokeObjectURL(url)
  }

  const doExcel = async (id: string) => {
    setBusyExcel(id); setError(null)
    try {
      const { exportCommissionSettlementXlsx } = await import('@/app/actions/comercial/commissions')
      const result = await exportCommissionSettlementXlsx(id)
      const binary = atob(result.base64)
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      const blob = new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url; a.download = result.filename; a.click()
      URL.revokeObjectURL(url)
    } catch (err) { setError(errorMessage(err)) } finally { setBusyExcel(null) }
  }

  return <div className="commission-panel flex h-full min-h-0 flex-col overflow-hidden bg-theme-surface text-theme-text">
    <Header view={view} onConfig={openConfig} onBack={() => setView('main')} mainTab={mainTab} onMainTab={setMainTab} />
    {error && <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-theme-text"><AlertCircle className="h-4 w-4 text-red-600" />{error}</div>}
    {confirmAction && <ConfirmModal action={confirmAction} reason={cancelReason} onReason={setCancelReason} busy={busy} onConfirm={confirmAction.type === 'create_draft' ? doCreateDraft : confirmAction.type === 'cancel' ? doCancelDraft : confirmAction.type === 'issue' ? doIssue : doAnnul} onCancel={() => { setConfirmAction(null); setCancelReason('') }} />}
    {pdfPreview && <PdfPreviewModal base64={pdfPreview.base64} filename={pdfPreview.filename} onClose={() => setPdfPreview(null)} onDownload={downloadPdf} />}
    {view === 'main' ? <main className="flex-1 overflow-auto bg-theme-bg/50 px-4 py-4 md:px-6">
      {loading ? <Loading /> : commissionable.length === 0 ? <Empty onConfig={openConfig} /> : mainTab === 'simulate' ? <SimulateTab sellerId={sellerId} setSellerId={setSellerId} periodFrom={periodFrom} setPeriodFrom={setPeriodFrom} periodTo={periodTo} setPeriodTo={setPeriodTo} busy={busy} sellers={commissionable} preview={preview} onSimulate={simulate} onCreateDraft={() => setConfirmAction({ type: 'create_draft' })} /> : mainTab === 'drafts' ? <DraftsTab drafts={draftList} busy={busy} detail={settlementDetail} onLoad={loadDraftList} onDetail={openDetail} onCancel={id => { setConfirmAction({ type: 'cancel', settlementId: id }) }} onIssue={id => { setConfirmAction({ type: 'issue', settlementId: id }) }} onBack={() => setSettlementDetail(null)} onPdf={doPdf} onExcel={doExcel} busyPdf={busyPdf} busyExcel={busyExcel} /> : mainTab === 'annulled' ? <AnnulledTab annulled={annulledList} busy={busy} detail={settlementDetail} onLoad={loadAnnulledList} onDetail={openDetail} onBack={() => setSettlementDetail(null)} onPdf={doPdf} onExcel={doExcel} busyPdf={busyPdf} busyExcel={busyExcel} /> : <IssuedTab issued={issuedList} busy={busy} detail={settlementDetail} onLoad={loadIssuedList} onDetail={openDetail} onBack={() => setSettlementDetail(null)} onPdf={doPdf} onExcel={doExcel} busyPdf={busyPdf} busyExcel={busyExcel} onAnnul={id => { setCancelReason(''); setConfirmAction({ type: 'annul', settlementId: id }) }} />}
    </main> : <Configuration tab={tab} setTab={setTab} sellers={sellers} drafts={drafts} settings={settings} groups={groups} rules={rules} busy={busy} onSellerChange={(id, changes) => setDrafts(current => ({ ...current, [id]: { ...current[id], ...changes } }))} onSaveSeller={saveSeller} onSettingsChange={percent => setSettings(current => current ? { ...current, default_commission_percent: percent } : current)} onSaveSettings={async () => { if (!settings) return; setBusy(true); try { setSettings(await updateCommissionSettings({ default_commission_percent: settings.default_commission_percent })) } catch (err) { setError(errorMessage(err)) } finally { setBusy(false) } }} onRefresh={loadConfig} setError={setError} />}
  </div>
}

const mainTabs: Array<{ key: MainTab; label: string }> = [
  { key: 'simulate', label: 'Simulación' },
  { key: 'drafts', label: 'Borradores' },
  { key: 'issued', label: 'Emitidas' },
  { key: 'annulled', label: 'Anuladas' },
]

function Header({ view, onConfig, onBack, mainTab, onMainTab }: { view: View; onConfig: () => void; onBack: () => void; mainTab: MainTab; onMainTab: (t: MainTab) => void }) { return <><header className="shrink-0 border-b border-theme-border px-4 py-3 md:px-5"><div className="flex items-center justify-between gap-3"><div><div className="flex items-center gap-2"><UsersRound className="h-4 w-4 text-theme-accent" /><h2 className="font-accent text-lg font-semibold">Comisiones de Vendedores</h2></div><p className="mt-1 text-sm text-theme-text-muted">{view === 'main' ? 'Simulación. No emite liquidación ni bloquea facturas.' : 'Configuración de vendedores, comisión general, grupos y reglas.'}</p></div>{view === 'main' ? <button onClick={onConfig} className="btn-secondary"><Settings2 className="h-3.5 w-3.5" />Configuración</button> : <button onClick={onBack} className="btn-secondary"><ArrowLeft className="h-3.5 w-3.5" />Volver a comisiones</button>}</div>{view === 'main' && <div className="mt-2 flex gap-1">{(mainTabs).map(t => <button key={t.key} onClick={() => onMainTab(t.key)} className={cn('rounded-t px-3 py-1.5 text-xs font-semibold', mainTab === t.key ? 'bg-theme-accent-muted text-theme-text' : 'text-theme-text-muted hover:bg-theme-surface-hover')}>{t.label}</button>)}</div>}</header><CommissionStyles /></> }

function ConfirmModal({ action, reason, onReason, busy, onConfirm, onCancel }: { action: { type: 'create_draft' | 'cancel' | 'issue' | 'annul'; settlementId?: string }; reason: string; onReason: (v: string) => void; busy: boolean; onConfirm: () => void; onCancel: () => void }) {
  const messages = {
    create_draft: { title: 'Crear borrador', body: 'Se creará un borrador y las líneas quedarán reservadas. No aparecerán en nuevas simulaciones hasta cancelar el borrador.', needsReason: false, confirmLabel: 'Crear borrador' },
    cancel: { title: 'Cancelar borrador', body: 'Las líneas asociadas quedarán liberadas para futuras simulaciones.', needsReason: true, confirmLabel: 'Cancelar borrador' },
    issue: { title: 'Emitir liquidación', body: 'Al emitir, las líneas quedarán bloqueadas definitivamente. Esta acción no se puede deshacer automáticamente.', needsReason: false, confirmLabel: 'Emitir liquidación' },
    annul: { title: 'Anular liquidación emitida', body: 'Esta liquidación emitida será anulada. El correlativo se mantendrá consumido y las líneas volverán a estar disponibles para una nueva liquidación.', needsReason: true, confirmLabel: 'Anular liquidación' },
  }
  const msg = messages[action.type]
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"><div className="mx-4 w-full max-w-md rounded-xl border border-theme-border bg-theme-surface p-5 shadow-xl"><h3 className="font-semibold">{msg.title}</h3><p className="mt-2 text-sm text-theme-text-muted">{msg.body}</p>{msg.needsReason && <textarea value={reason} onChange={e => onReason(e.target.value)} placeholder="Motivo de cancelación *" className="mt-3 h-20 w-full resize-none rounded-lg border border-theme-border bg-theme-bg/50 p-2 text-xs" />}<div className="mt-4 flex justify-end gap-2"><button onClick={onCancel} className="btn-secondary" disabled={busy}>Volver</button><button onClick={onConfirm} className="btn-primary" disabled={busy || (msg.needsReason && !reason.trim())}>{busy ? 'Procesando...' : msg.confirmLabel}</button></div></div></div>
}

function PdfPreviewModal({ base64, filename, onClose, onDownload }: { base64: string; filename: string; onClose: () => void; onDownload: () => void }) {
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={onClose}>
    <div className="mx-4 flex h-[90vh] w-full max-w-5xl flex-col rounded-xl border border-theme-border bg-theme-surface shadow-xl" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between border-b border-theme-border px-4 py-2">
        <span className="text-sm font-semibold">{filename}</span>
        <div className="flex items-center gap-2">
          <button onClick={onDownload} className="btn-primary"><Download className="h-3.5 w-3.5" />Descargar</button>
          <button onClick={onClose} className="btn-secondary"><X className="h-3.5 w-3.5" />Cerrar</button>
        </div>
      </div>
      <div className="flex-1">
        <iframe src={`data:application/pdf;base64,${base64}`} className="h-full w-full" title="Vista previa PDF" />
      </div>
    </div>
  </div>
}

function CommissionStyles() { return <style jsx global>{`.commission-panel .btn-primary,.commission-panel .btn-secondary{display:inline-flex;align-items:center;justify-content:center;gap:.375rem;min-height:2rem;border-radius:.5rem;padding:.35rem .7rem;font-size:.75rem;font-weight:700;transition:opacity .15s,background .15s}.commission-panel .btn-primary{background:var(--theme-accent);color:#fff}.commission-panel .btn-primary:hover{opacity:.9}.commission-panel .btn-secondary{border:1px solid var(--theme-border);background:var(--theme-surface);color:var(--theme-text)}.commission-panel .btn-secondary:hover{background:var(--theme-surface-hover)}.commission-panel input,.commission-panel select,.commission-panel textarea{width:100%;border:1px solid var(--theme-border);border-radius:.5rem;background:var(--theme-surface);color:var(--theme-text);padding:.4rem .55rem;font-size:.75rem;transition:border-color .15s,box-shadow .15s}.commission-panel input:focus,.commission-panel select:focus,.commission-panel textarea:focus{outline:none;border-color:var(--theme-accent);box-shadow:0 0 0 2px color-mix(in srgb,var(--theme-accent) 20%,transparent)}.commission-panel .sim-card input,.commission-panel .sim-card select,.commission-panel .sim-card textarea{background:var(--theme-bg)}.commission-panel .sim-card input:focus,.commission-panel .sim-card select:focus,.commission-panel .sim-card textarea:focus{background:var(--theme-surface)}.commission-panel table,.commission-panel th,.commission-panel td{color:var(--theme-text)!important}.commission-panel th{background:var(--theme-bg);padding:.4rem .5rem;text-align:left;font-size:.65rem;font-weight:700;text-transform:uppercase;letter-spacing:.02em;color:var(--theme-text-muted)}.commission-panel td{padding:.35rem .5rem;border-top:1px solid var(--theme-border);font-size:.7rem}.commission-panel tbody tr{transition:background .1s}.commission-panel tbody tr:hover{background:var(--theme-surface-hover)}.commission-panel .sim-card{background:var(--theme-surface);border:1px solid var(--theme-border);border-radius:.75rem;box-shadow:0 1px 3px rgba(0,0,0,.06),0 1px 2px rgba(0,0,0,.04)}.commission-panel .sim-kpi{display:flex;flex-direction:column;padding:.35rem .6rem;border-radius:.5rem;background:var(--theme-bg);min-width:0}.commission-panel .sim-kpi-label{font-size:.6rem;font-weight:600;text-transform:uppercase;letter-spacing:.03em;color:var(--theme-text-muted);white-space:nowrap}.commission-panel .sim-kpi-value{font-size:.8rem;font-weight:700;color:var(--theme-text);line-height:1.3;white-space:nowrap}.commission-panel .overflow-auto.rounded-xl.border, .commission-panel .sim-card, .commission-panel .rounded-xl.border.bg-theme-bg{background:var(--theme-surface)}`}</style> }
function Field({ label, children }: { label: string; children: React.ReactNode }) { return <label className="block text-[11px] font-semibold uppercase tracking-wide text-theme-text-muted">{label}<span className="mt-1 block">{children}</span></label> }
function Loading() { return <div className="flex h-40 items-center justify-center"><RefreshCw className="h-5 w-5 animate-spin text-theme-accent" /></div> }
function Empty({ onConfig }: { onConfig: () => void }) { return <section className="mx-auto mt-10 max-w-xl rounded-xl border border-theme-border bg-theme-bg/35 p-7 text-center"><UsersRound className="mx-auto h-8 w-8 text-theme-text-muted" /><h3 className="mt-4 font-semibold">No hay vendedores comisionables configurados.</h3><p className="mt-2 text-sm text-theme-text-muted">Configura vendedores para comenzar a simular comisiones.</p><button onClick={onConfig} className="btn-primary mt-5"><Settings2 className="h-3.5 w-3.5" />Configurar vendedores</button></section> }

function SimulateTab({ sellerId, setSellerId, periodFrom, setPeriodFrom, periodTo, setPeriodTo, busy, sellers, preview, onSimulate, onCreateDraft }: {
  sellerId: string; setSellerId: (v: string) => void; periodFrom: string; setPeriodFrom: (v: string) => void; periodTo: string; setPeriodTo: (v: string) => void; busy: boolean; sellers: CommissionSeller[]; preview: CommissionPreview | null; onSimulate: (id?: string) => void; onCreateDraft: () => void
}) {
  const kpis = preview ? [
    { label: 'Facturas', value: preview.summary.invoices_count.toLocaleString('es-CL') },
    { label: 'Líneas', value: preview.summary.lines_count.toLocaleString('es-CL') },
    { label: 'Neto', value: money(preview.summary.total_net_amount) },
    { label: 'Comisión', value: money(preview.summary.total_commission_amount) },
    { label: '% efectivo', value: `${preview.summary.total_net_amount ? (preview.summary.total_commission_amount / preview.summary.total_net_amount * 100).toFixed(2) : '0.00'}%` },
  ] : []
  return <div className="w-full space-y-3">
    <section className="sim-card p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-[160px] flex-1">
          <Field label="Vendedor"><select value={sellerId} onChange={event => { setSellerId(event.target.value); if (event.target.value) onSimulate(event.target.value) }}><option value="">Selecciona vendedor</option>{sellers.map(seller => <option key={seller.seller_bsale_id} value={seller.seller_bsale_id}>{seller.seller_name?.toUpperCase()}</option>)}</select></Field>
        </div>
        <div className="w-[140px]">
          <Field label="Desde"><input type="date" value={periodFrom} max={periodTo} onChange={event => { setPeriodFrom(event.target.value) }} /></Field>
        </div>
        <div className="w-[140px]">
          <Field label="Hasta"><input type="date" value={periodTo} min={periodFrom} max={today()} onChange={event => { setPeriodTo(event.target.value) }} /></Field>
        </div>
        <button disabled={!sellerId || busy} onClick={() => onSimulate()} className="btn-primary h-[34px] self-end">{busy ? 'Simulando...' : 'Simular'}</button>
        {preview && preview.lines.length > 0 && <button disabled={busy} onClick={onCreateDraft} className="btn-primary h-[34px] self-end !bg-emerald-600 hover:!bg-emerald-700"><FileUp className="h-3.5 w-3.5" />Crear borrador</button>}
      </div>
      {kpis.length > 0 && <div className="mt-2.5 flex flex-wrap gap-1.5">
        {kpis.map(k => <div key={k.label} className="sim-kpi"><span className="sim-kpi-label">{k.label}</span><span className="sim-kpi-value">{k.value}</span></div>)}
      </div>}
    </section>
    {preview && <PreviewReport preview={preview} />}
  </div>
}

function DraftsTab({ drafts, busy, detail, onLoad, onDetail, onCancel, onIssue, onBack, onPdf, onExcel, busyPdf, busyExcel }: {
  drafts: CommissionSettlementHeader[]; busy: boolean; detail: SettlementDetail | null; onLoad: () => void; onDetail: (id: string) => void; onCancel: (id: string) => void; onIssue: (id: string) => void; onBack: () => void; onPdf?: (id: string) => void; onExcel?: (id: string) => void; busyPdf?: string | null; busyExcel?: string | null
}) {
  useEffect(() => { void onLoad() }, [])
  if (detail) return <SettlementDetailView detail={detail} onBack={onBack} onPdf={onPdf} onExcel={onExcel} busyPdf={busyPdf} busyExcel={busyExcel} />
  return <div className="space-y-3">
    <div className="flex items-center justify-between"><h3 className="font-semibold">Borradores de liquidación</h3><button disabled={busy} onClick={onLoad} className="btn-secondary"><RefreshCw className="h-3.5 w-3.5" />Actualizar</button></div>
    {drafts.length === 0 ? <div className="rounded-xl border border-theme-border p-8 text-center text-sm text-theme-text-muted">No hay borradores activos. Simula un vendedor y crea un borrador desde la pestaña Simulación.</div> :
    <div className="overflow-auto rounded-xl border border-theme-border"><table className="min-w-[900px] w-full text-xs"><thead><tr><th>Vendedor</th><th>Período</th><th>Líneas</th><th className="text-right">Neto</th><th className="text-right">Comisión</th><th>Creado</th><th /></tr></thead><tbody>{drafts.map(d => <tr key={d.id}><td><b>{d.seller_name}</b></td><td>{d.period_label}</td><td>{d.lines_count || 0}</td><td className="text-right">{money(d.total_net_amount)}</td><td className="text-right font-semibold">{money(d.total_commission_amount)}</td><td>{d.created_at?.slice(0, 10)}</td><td><div className="flex gap-1 flex-wrap"><button onClick={() => onDetail(d.id)} className="btn-secondary"><FileText className="h-3 w-3" />Ver</button>{onPdf && <button disabled={busyPdf === d.id} onClick={() => onPdf(d.id)} className="btn-secondary" title="PDF resumen ejecutivo">{busyPdf === d.id ? 'Generando PDF...' : <><FileText className="h-3 w-3" />PDF</>}</button>}{onExcel && <button disabled={busyExcel === d.id} onClick={() => onExcel(d.id)} className="btn-secondary" title="Excel detalle por línea">{busyExcel === d.id ? 'Descargando Excel...' : <><FileText className="h-3 w-3" />Excel</>}</button>}<button onClick={() => onCancel(d.id)} className="btn-secondary border-red-500/30 text-red-600"><Ban className="h-3 w-3" />Cancelar</button><button onClick={() => onIssue(d.id)} className="btn-primary bg-emerald-600"><Check className="h-3 w-3" />Emitir</button></div></td></tr>)}</tbody></table></div>}
  </div>
}

function AnnulledTab({ annulled, busy, detail, onLoad, onDetail, onBack, onPdf, onExcel, busyPdf, busyExcel }: {
  annulled: CommissionSettlementHeader[]; busy: boolean; detail: SettlementDetail | null; onLoad: () => void; onDetail: (id: string) => void; onBack: () => void; onPdf?: (id: string) => void; onExcel?: (id: string) => void; busyPdf?: string | null; busyExcel?: string | null
}) {
  useEffect(() => { void onLoad() }, [])
  if (detail) return <SettlementDetailView detail={detail} onBack={onBack} onPdf={onPdf} onExcel={onExcel} busyPdf={busyPdf} busyExcel={busyExcel} />
  return <div className="space-y-3">
    <div className="flex items-center justify-between"><h3 className="font-semibold">Liquidaciones anuladas</h3><button disabled={busy} onClick={onLoad} className="btn-secondary"><RefreshCw className="h-3.5 w-3.5" />Actualizar</button></div>
    {annulled.length === 0 ? <div className="rounded-xl border border-theme-border p-8 text-center text-sm text-theme-text-muted">No hay liquidaciones anuladas.</div> :
    <div className="overflow-auto rounded-xl border border-theme-border"><table className="min-w-[1000px] w-full text-xs"><thead><tr><th>Código</th><th>Vendedor</th><th>Período</th><th className="text-right">Neto</th><th className="text-right">Comisión</th><th>Emisión</th><th>Anulación</th><th>Motivo</th><th /></tr></thead><tbody>{annulled.map(d => <tr key={d.id}><td className="font-semibold">{d.settlement_code || d.settlement_number}</td><td>{d.seller_name}</td><td>{d.period_label}</td><td className="text-right">{money(d.total_net_amount)}</td><td className="text-right font-semibold">{money(d.total_commission_amount)}</td><td>{d.issued_at?.slice(0, 10)}</td><td>{(d as Record<string, unknown>).cancelled_at ? String((d as Record<string, unknown>).cancelled_at).slice(0, 10) : '-'}</td><td className="max-w-[200px] truncate">{(d as Record<string, unknown>).cancellation_reason as string || '-'}</td><td><div className="flex gap-1"><button onClick={() => onDetail(d.id)} className="btn-secondary"><FileText className="h-3 w-3" />Ver</button>{onPdf && <button disabled={busyPdf === d.id} onClick={() => onPdf(d.id)} className="btn-secondary">{busyPdf === d.id ? 'Generando PDF...' : <><FileText className="h-3 w-3" />PDF</>}</button>}{onExcel && <button disabled={busyExcel === d.id} onClick={() => onExcel(d.id)} className="btn-secondary">{busyExcel === d.id ? 'Descargando Excel...' : <><FileText className="h-3 w-3" />Excel</>}</button>}</div></td></tr>)}</tbody></table></div>}
  </div>
}

function IssuedTab({ issued, busy, detail, onLoad, onDetail, onBack, onPdf, onExcel, busyPdf, busyExcel, onAnnul }: {
  issued: CommissionSettlementHeader[]; busy: boolean; detail: SettlementDetail | null; onLoad: () => void; onDetail: (id: string) => void; onBack: () => void; onPdf?: (id: string) => void; onExcel?: (id: string) => void; busyPdf?: string | null; busyExcel?: string | null; onAnnul?: (id: string) => void
}) {
  useEffect(() => { void onLoad() }, [])
  if (detail) return <SettlementDetailView detail={detail} onBack={onBack} onPdf={onPdf} onExcel={onExcel} busyPdf={busyPdf} busyExcel={busyExcel} onAnnul={onAnnul} />
  return <div className="space-y-3">
    <div className="flex items-center justify-between"><h3 className="font-semibold">Liquidaciones emitidas</h3><button disabled={busy} onClick={onLoad} className="btn-secondary"><RefreshCw className="h-3.5 w-3.5" />Actualizar</button></div>
    {issued.length === 0 ? <div className="rounded-xl border border-theme-border p-8 text-center text-sm text-theme-text-muted">No hay liquidaciones emitidas.</div> :
    <div className="overflow-auto rounded-xl border border-theme-border"><table className="min-w-[900px] w-full text-xs"><thead><tr><th>#</th><th>Vendedor</th><th>Período</th><th>Líneas</th><th className="text-right">Neto</th><th className="text-right">Comisión</th><th>Emisión</th><th /></tr></thead><tbody>{issued.map(d => <tr key={d.id}><td className="font-semibold">{d.settlement_code || d.settlement_number}</td><td>{d.seller_name}</td><td>{d.period_label}</td><td>{d.lines_count || 0}</td><td className="text-right">{money(d.total_net_amount)}</td><td className="text-right font-semibold">{money(d.total_commission_amount)}</td><td>{d.issued_at?.slice(0, 10)}</td><td><div className="flex gap-1"><button onClick={() => onDetail(d.id)} className="btn-secondary"><FileText className="h-3 w-3" />Ver</button>{onPdf && <button disabled={busyPdf === d.id} onClick={() => onPdf(d.id)} className="btn-secondary" title="PDF resumen ejecutivo por factura">{busyPdf === d.id ? 'Generando PDF...' : <><FileText className="h-3 w-3" />PDF</>}</button>}{onExcel && <button disabled={busyExcel === d.id} onClick={() => onExcel(d.id)} className="btn-secondary" title="Excel detalle por línea">{busyExcel === d.id ? 'Descargando Excel...' : <><FileText className="h-3 w-3" />Excel</>}</button>}{onAnnul && <button onClick={() => onAnnul(d.id)} className="btn-secondary border-red-500/30 text-red-600"><Ban className="h-3 w-3" />Anular</button>}</div></td></tr>)}</tbody></table></div>}
  </div>
}

function SettlementDetailView({ detail, onBack, onPdf, onExcel, busyPdf, busyExcel, onAnnul }: { detail: SettlementDetail; onBack: () => void; onPdf?: (id: string) => void; onExcel?: (id: string) => void; busyPdf?: string | null; busyExcel?: string | null; onAnnul?: (id: string) => void }) {
  const { header, lines } = detail
  const sid = header.id
  const isDraft = header.status === 'DRAFT'
  const isIssued = header.status === 'ISSUED'
  const statusLabel = isDraft ? 'Borrador' : isIssued ? 'Emitida' : 'Anulada'
  const invoicesCount = new Set(lines.map(l => l.original_invoice_bsale_id || l.invoice_bsale_id)).size
  const linesCount = lines.length
  const ncLinesCount = lines.filter(l => l.line_type === 'CREDIT_NOTE').length
  const netoPositivo = lines.reduce((s, l) => s + (l.net_amount > 0 ? l.net_amount : 0), 0)
  const netoNc = lines.reduce((s, l) => s + (l.line_type === 'CREDIT_NOTE' ? l.net_amount : 0), 0)
  const netoFinal = lines.reduce((s, l) => s + l.net_amount, 0)
  const comisionFinal = lines.reduce((s, l) => s + (l.commission_amount || 0), 0)
  const fmt = (iso: string | null | undefined) => iso ? iso.slice(0, 10).split('-').reverse().join('/') : '-'

  return <div>
    <div className="sticky top-0 z-10 -mx-4 border-b border-theme-border bg-theme-surface/95 px-4 pb-2 pt-0 backdrop-blur-sm md:-mx-6 md:px-6">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button onClick={onBack} className="btn-secondary shrink-0"><ArrowLeft className="h-3.5 w-3.5" />Volver</button>
        <span className="font-semibold">{header.settlement_code || 'Borrador'}</span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold ${isDraft ? 'bg-amber-500/20 text-amber-700' : isIssued ? 'bg-emerald-500/20 text-emerald-700' : 'bg-red-500/20 text-red-700'}`}>{statusLabel}</span>
        <span className="text-xs text-theme-text-muted">{header.seller_name}</span>
        <span className="text-xs text-theme-text-muted">{header.period_label}</span>
        <div className="ml-auto flex gap-1">
          {onPdf && <button disabled={busyPdf === sid} onClick={() => onPdf(sid)} className="btn-secondary">{busyPdf === sid ? 'Generando PDF...' : <><FileText className="h-3 w-3" />PDF</>}</button>}
          {onExcel && <button disabled={busyExcel === sid} onClick={() => onExcel(sid)} className="btn-secondary">{busyExcel === sid ? 'Descargando Excel...' : <><FileText className="h-3 w-3" />Excel</>}</button>}
          {onAnnul && isIssued && <button onClick={() => onAnnul(sid)} className="btn-secondary border-red-500/30 text-red-600"><Ban className="h-3 w-3" />Anular</button>}
        </div>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[11px]">
        <span><b>Facturas:</b> {invoicesCount}</span>
        <span><b>Líneas:</b> {linesCount}</span>
        <span><b>Líneas NC:</b> {ncLinesCount}</span>
        <span><b>Neto +:</b> {money(netoPositivo)}</span>
        <span className="text-amber-700"><b>Neto NC:</b> {money(netoNc)}</span>
        <span><b>Neto final:</b> {money(netoFinal)}</span>
        <span><b>Comisión:</b> {money(comisionFinal)}</span>
        <span><b>% efectivo:</b> {netoFinal ? `${(comisionFinal / netoFinal * 100).toFixed(2)}%` : '0.00%'}</span>
        <span className="text-theme-text-muted">Creado {fmt(header.created_at || null)}</span>
      </div>
    </div>


    <div className="mt-3 overflow-auto rounded-xl border border-theme-border"><table className="min-w-[1200px] w-full text-xs"><thead><tr><th>Tipo</th><th>Factura</th><th>SKU / Producto</th><th className="text-right">Cant.</th><th className="text-right">Neto</th><th className="text-right">%</th><th className="text-right">Comisión</th></tr></thead><tbody>{lines.map(line => {
      const isNC = line.line_type === 'CREDIT_NOTE'
      return <tr key={line.id} className={isNC ? 'opacity-85' : ''}>
        <td>{isNC ? `NC ${line.source_document_number || ''}` : 'Factura'}</td>
        <td>{isNC ? `${line.original_invoice_number || ''} (NC ${line.source_document_number || ''})` : line.invoice_number || line.invoice_bsale_id}</td>
        <td><b>{line.sku}</b><div>{line.product_name}{isNC && line.metadata && (line.metadata as Record<string, unknown>)?.adjustment_reason ? <div className="mt-0.5 text-[10px] text-amber-600">{(line.metadata as Record<string, unknown>)?.adjustment_reason as string}</div> : null}</div></td>
        <td className="text-right">{isNC ? `(${Math.abs(line.quantity)})` : line.quantity}</td>
        <td className={`text-right ${isNC ? 'text-amber-700' : ''}`}>{isNC ? `(${money(Math.abs(line.net_amount))})` : money(line.net_amount)}</td>
        <td className="text-right">{line.commission_percent != null ? formatPercent(Number(line.commission_percent)) : '-'}</td>
        <td className={`text-right font-semibold ${isNC ? 'text-amber-700' : ''}`}>{line.commission_amount != null ? (isNC ? `(${money(Math.abs(line.commission_amount))})` : money(line.commission_amount)) : '-'}</td>
      </tr>
    })}</tbody></table></div>
  </div>
}

function PreviewReport({ preview }: { preview: CommissionPreview }) {
  const [filters, setFilters] = useState({ invoice: '', supplier: '', product: '', rule: '', percent: '' })
  const filtered = preview.lines.filter(line => String(line.invoice_number || line.invoice_bsale_id).includes(filters.invoice.trim()) && `${line.supplier_name || ''} ${line.commission_group_name || ''}`.toLowerCase().includes(filters.supplier.trim().toLowerCase()) && `${line.sku || ''} ${line.product_name || ''}`.toLowerCase().includes(filters.product.trim().toLowerCase()) && line.applied_rule_label.toLowerCase().includes(filters.rule.trim().toLowerCase()) && (!filters.percent || Number(line.commission_percent) === Number(filters.percent)))
  const general = filtered.filter(line => line.warning_code === 'DEFAULT_RULE_USED').length
  const ncCount = filtered.filter(line => line.commission_line_type === 'CREDIT_NOTE_LINE').length
  const percentages = Array.from(new Set(preview.lines.map(line => Number(line.commission_percent)))).sort((a, b) => a - b)
  const ruleLabels = Array.from(new Set(preview.lines.map(line => line.applied_rule_label))).sort((a, b) => a.localeCompare(b, 'es'))
  return <section className="space-y-2.5">
    <div className="sim-card overflow-hidden">
      <div className="border-b border-theme-border bg-theme-bg/40 px-3 py-1.5 text-[11px] font-semibold text-theme-text-muted flex items-center gap-1.5"><SlidersHorizontal className="h-3 w-3 text-theme-accent" />Filtros de simulación</div>
      <div className="grid gap-2 p-3 md:grid-cols-2 xl:grid-cols-[170px_1fr_1fr_1fr_130px_auto]">
        <input value={filters.invoice} onChange={e => setFilters(current => ({ ...current, invoice: e.target.value }))} placeholder="Factura" className="h-7 text-[11px]" />
        <input value={filters.supplier} onChange={e => setFilters(current => ({ ...current, supplier: e.target.value }))} placeholder="Proveedor o grupo" className="h-7 text-[11px]" />
        <input value={filters.product} onChange={e => setFilters(current => ({ ...current, product: e.target.value }))} placeholder="SKU o producto" className="h-7 text-[11px]" />
        <select value={filters.rule} onChange={e => setFilters(current => ({ ...current, rule: e.target.value }))} className="h-7 text-[11px]"><option value="">Todas las reglas</option>{ruleLabels.map(label => <option key={label} value={label}>{label}</option>)}</select>
        <select value={filters.percent} onChange={e => setFilters(current => ({ ...current, percent: e.target.value }))} className="h-7 text-[11px]"><option value="">Todos los %</option>{percentages.map(percent => <option key={percent} value={percent}>{percent}%</option>)}</select>
        <button onClick={() => setFilters({ invoice: '', supplier: '', product: '', rule: '', percent: '' })} className="btn-secondary h-7 text-[11px]"><X className="h-3 w-3" />Limpiar</button>
      </div>
    </div>
    {general > 0 && <div className={`rounded-lg border px-3 py-1.5 text-[11px] ${ncCount > 0 ? 'border-amber-500/30 bg-amber-500/8 text-amber-700' : 'border-amber-500/30 bg-amber-500/8 text-amber-700'}`}><span className="font-semibold">{general} {general === 1 ? 'línea de venta usa' : 'líneas de venta usan'} la comisión general.</span>{ncCount > 0 ? <> {ncCount} {ncCount === 1 ? 'línea corresponde' : 'líneas corresponden'} a notas de crédito aplicadas como descuento.</> : ' Configura reglas específicas para personalizar.'}</div>}
    <PreviewTable lines={filtered} />
  </section>
}
function PreviewTable({ lines }: { lines: CommissionPreviewLine[] }) {
  const ncCount = lines.filter(line => line.commission_line_type === 'CREDIT_NOTE_LINE').length
  return <div className="overflow-auto rounded-xl border border-theme-border sim-card">
    {ncCount > 0 && <div className="flex items-center gap-2 border-b border-theme-border bg-amber-500/8 px-2.5 py-1.5 text-[11px] text-amber-700"><span className="font-semibold">{ncCount} {ncCount === 1 ? 'línea es' : 'líneas son'} de nota de crédito.</span><span>Descuentan línea por línea (matching por SKU).</span></div>}
    <table className="min-w-[1260px] w-full"><thead><tr><th className="w-[70px]">Factura</th><th className="w-[130px]">Cliente</th><th className="w-[60px]">Pago</th><th className="w-[200px]">SKU / Producto</th><th className="w-[140px]">Proveedor / Grupo</th><th className="w-[40px] text-right">Cant.</th><th className="w-[70px] text-right">Neto</th><th className="w-[140px]">Regla</th><th className="w-[30px] text-right">%</th><th className="w-[75px] text-right">Comisión</th><th className="w-[50px]">Origen</th></tr></thead><tbody>{lines.map(line => {
      const isNC = line.commission_line_type === 'CREDIT_NOTE_LINE'
      return <tr key={line.invoice_line_id} className={isNC ? 'opacity-80' : ''}>
        <td className="font-medium">{isNC ? `${line.original_invoice_number || line.invoice_number}` : line.invoice_number || line.invoice_bsale_id}</td>
        <td className="truncate max-w-[130px]" title={line.customer_name || ''}>{line.customer_name}</td>
        <td>{line.payment_completed_at?.slice(0, 10)}</td>
        <td><span className="font-medium">{line.sku}</span><span className="ml-1 text-theme-text-muted">{(line.product_name || '').substring(0, 40)}{(line.product_name || '').length > 40 ? '…' : ''}</span></td>
        <td><div className="truncate">{line.supplier_name}</div>{line.commission_group_name && <div className="text-[10px] text-theme-text-muted truncate">{line.commission_group_name}</div>}</td>
        <td className="text-right">{isNC ? `(${Math.abs(line.quantity)})` : line.quantity}</td>
        <td className={`text-right ${isNC ? 'text-amber-700' : ''}`}>{isNC ? `(${money(Math.abs(line.net_amount))})` : money(line.net_amount)}</td>
        <td><span className={isNC ? 'text-amber-700 font-medium' : 'font-medium'}>{isNC ? 'Nota de crédito' : line.applied_rule_label}</span>{line.rule_id && !isNC && <div className="text-[10px] text-theme-text-muted">{line.applied_rule_scope}</div>}</td>
        <td className="text-right">{formatPercent(Number(line.commission_percent))}</td>
        <td className={`text-right font-semibold ${isNC ? 'text-amber-700' : ''}`}>{isNC ? `(${money(Math.abs(line.commission_amount))})` : money(line.commission_amount)}</td>
        <td className="text-[10px] text-theme-text-muted">{isNC ? `NC ${line.source_document_number || ''}` : 'Factura'}</td>
      </tr>
    })}</tbody></table>{lines.length === 0 && <div className="p-6 text-center text-sm text-theme-text-muted">No hay líneas que coincidan con los filtros.</div>}</div>
}

function Configuration({ tab, setTab, sellers, drafts, settings, groups, rules, busy, onSellerChange, onSaveSeller, onSettingsChange, onSaveSettings, onRefresh, setError }: { tab: ConfigTab; setTab: (tab: ConfigTab) => void; sellers: CommissionSeller[]; drafts: Record<number, SellerDraft>; settings: CommissionSettings | null; groups: CommissionGroup[]; rules: CommissionRule[]; busy: boolean; onSellerChange: (id: number, changes: Partial<SellerDraft>) => void; onSaveSeller: (seller: CommissionSeller) => void; onSettingsChange: (percent: number) => void; onSaveSettings: () => void; onRefresh: () => Promise<void>; setError: (message: string | null) => void }) { return <main className="min-h-0 flex-1 overflow-auto bg-theme-bg/50"><div className="flex gap-1 border-b border-theme-border bg-theme-surface px-4 pt-3 sticky top-0 z-10">{(['sellers', 'general', 'groups', 'rules'] as ConfigTab[]).map(item => <button key={item} onClick={() => setTab(item)} className={cn('rounded-t-lg px-3 py-2 text-xs font-semibold', tab === item ? 'bg-theme-accent-muted text-theme-text' : 'text-theme-text-muted hover:bg-theme-surface-hover')}>{({ sellers: 'Vendedores', general: 'General', groups: 'Grupos', rules: 'Reglas' })[item]}</button>)}</div><div className="p-4">{tab === 'sellers' ? <SellerTable sellers={sellers} drafts={drafts} busy={busy} onSellerChange={onSellerChange} onSaveSeller={onSaveSeller} /> : tab === 'general' ? <General settings={settings} busy={busy} onSettingsChange={onSettingsChange} onSaveSettings={onSaveSettings} /> : tab === 'groups' ? <CommissionGroupsConfig groups={groups} onSaved={onRefresh} setError={message => setError(message)} /> : <CommissionRulesWizard sellers={sellers} groups={groups} rules={rules} onSaved={onRefresh} onError={message => setError(message)} />}</div></main> }
function SellerTable({ sellers, drafts, busy, onSellerChange, onSaveSeller }: { sellers: CommissionSeller[]; drafts: Record<number, SellerDraft>; busy: boolean; onSellerChange: (id: number, changes: Partial<SellerDraft>) => void; onSaveSeller: (seller: CommissionSeller) => void }) { return <div className="overflow-auto rounded-xl border border-theme-border"><table className="min-w-[900px] w-full text-xs"><thead><tr><th>Vendedor</th><th>Tipo</th><th>Comisionable</th><th>Activo</th><th>Notas</th><th /></tr></thead><tbody>{sellers.map(seller => { const row = drafts[seller.seller_bsale_id] || sellerDraft(seller); return <tr key={seller.seller_bsale_id}><td><b>{seller.seller_name}</b><div>{seller.paid_invoices_count} facturas pagadas</div></td><td><select value={row.seller_type} onChange={e => onSellerChange(seller.seller_bsale_id, { seller_type: e.target.value as CommissionSellerType })}>{sellerTypes.map(type => <option key={type.value} value={type.value}>{type.label}</option>)}</select></td><td className="text-center"><input type="checkbox" checked={row.is_commissionable} onChange={e => onSellerChange(seller.seller_bsale_id, { is_commissionable: e.target.checked })} /></td><td className="text-center"><input type="checkbox" checked={row.active} onChange={e => onSellerChange(seller.seller_bsale_id, { active: e.target.checked })} /></td><td><input value={row.notes} onChange={e => onSellerChange(seller.seller_bsale_id, { notes: e.target.value })} /></td><td><button disabled={busy} onClick={() => onSaveSeller(seller)} className="btn-primary"><Save className="h-3.5 w-3.5" />Guardar</button></td></tr> })}</tbody></table></div> }
function General({ settings, busy, onSettingsChange, onSaveSettings }: { settings: CommissionSettings | null; busy: boolean; onSettingsChange: (percent: number) => void; onSaveSettings: () => void }) {
  const initVal = String(settings?.default_commission_percent ?? '')
  const [raw, setRaw] = useState(initVal)
  const [localSettings, setLocalSettings] = useState(settings)
  if (localSettings !== settings) { setLocalSettings(settings); if (raw !== String(settings?.default_commission_percent ?? '')) setRaw(String(settings?.default_commission_percent ?? '')) }
  if (!settings) return <Loading />
  const parsed = parsePercent(raw)
  return <div className="w-full rounded-xl border border-theme-border bg-theme-bg/30 p-4"><div className="grid gap-3 md:grid-cols-4"><Field label="Comisión general (%)"><input type="text" inputMode="decimal" value={raw} onChange={e => { setRaw(e.target.value); onSettingsChange(parsePercent(e.target.value)) }} placeholder="Ej: 1,5" /></Field><div className="text-sm"><b>Valor:</b> {formatPercent(parsed)}<br /><b>Base:</b> NET<br /><b>Pago completo:</b> Sí</div><div className="text-sm"><b>Cierre histórico:</b> {settings.historical_cutoff_date}<br /><b>Primer día elegible:</b> {settings.first_eligible_date}</div><button disabled={busy} onClick={onSaveSettings} className="btn-primary self-end"><Save className="h-3.5 w-3.5" />Guardar</button></div></div> }
