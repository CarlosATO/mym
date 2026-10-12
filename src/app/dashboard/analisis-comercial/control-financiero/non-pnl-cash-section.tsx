'use client'

import { useState } from 'react'
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import type { NonPnlCashData, NonPnlCashMovement } from '@/app/actions/control-financiero/non-pnl-cash'
import type { FinancialAccountBalance } from '@/app/actions/control-financiero/bank-statements'
import type { ResultVsCashReport } from '@/lib/control-financiero/result-vs-cash'

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic']
const MONTHS_FULL = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const DETAIL_DRAWER_CLASS = 'w-full gap-2 overflow-y-auto border-[#D1C7BD] bg-[#FCFBF9] sm:!w-[620px] sm:!max-w-[620px]'

function money(value: number) {
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(value)}`
}

function signedMoney(value: number) {
  return `${value < 0 ? '-' : ''}${money(Math.abs(value))}`
}

function date(value: string) {
  const [year, month, day] = value.split('-')
  return `${day}-${month}-${year}`
}

export function ResultVsCashSection({ report }: { report: ResultVsCashReport }) {
  const [detailOpen, setDetailOpen] = useState(false)
  const show = (value: string | number | null) => value === null ? '—' : signedMoney(Number(value))
  const pendingCollections = report.receivables ? report.receivables.amount : null
  const retiros = Math.abs(report.factors.find(factor => factor.label === 'Retiros de socios')?.amount ?? 0)

  return <Dialog open={detailOpen} onOpenChange={setDetailOpen}>
    <DialogTrigger className="border border-[#72383D]/40 bg-white px-3 py-1.5 text-xs font-semibold text-[#72383D] hover:bg-[#F1E4DE] focus-visible:outline-2 focus-visible:outline-[#72383D]">Análisis resultado vs caja</DialogTrigger>
    <DialogContent className="flex max-h-[calc(100dvh-1rem)] w-[calc(100vw-1rem)] max-w-[1200px] flex-col gap-0 overflow-hidden border border-[#D1C7BD] bg-[#FCFBF9] p-0 text-[#322D29] shadow-2xl sm:max-h-[96dvh] sm:w-[94vw] lg:w-[92vw] sm:max-w-[1200px]">
      <DialogHeader className="shrink-0 border-b border-[#D1C7BD] bg-[#F8F4EF] px-5 py-3 pr-12 text-left sm:px-6 sm:pr-12">
        <DialogTitle className="text-sm font-bold uppercase leading-6 tracking-[0.08em] text-[#72383D]">Resultado vs caja</DialogTitle>
        <DialogDescription className="text-xs text-[#322D29]/65">Referencia gerencial simple · resultado del período vs caja</DialogDescription>
      </DialogHeader>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain px-5 py-4 text-sm sm:px-6">
        <section className="rounded-lg border border-[#72383D]/30 bg-[#F1E4DE] px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#72383D]">Resultado gerencial del período</p>
          <strong className="mt-0.5 block break-words text-2xl font-semibold tabular-nums text-[#322D29]">{show(report.resultYtd)}{report.resultEstimated && report.resultYtd !== null && <span className="ml-1 text-xs text-[#1453A0]">EST.</span>}</strong>
          <p className="mt-0.5 text-[11px] text-[#322D29]/60">Utilidad económica estimada del período; no representa efectivo disponible.{report.resultCoverage ? ` ${report.resultCoverage}${report.resultAsOfDate ? ` · al ${date(report.resultAsOfDate)}` : ''}.` : ''}</p>
        </section>

        <div className="grid min-w-0 items-start gap-3 sm:grid-cols-2">
          <section className="rounded-lg border border-[#D1C7BD] bg-white px-4 py-3">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#72383D]">Pendientes de ingreso a caja (cobranzas)</h4>
            <strong className="mt-1 block text-xl font-semibold tabular-nums text-[#322D29]">{show(pendingCollections)}</strong>
            <p className="mt-0.5 text-[11px] leading-4 text-[#322D29]/60">Cartera vigente total pendiente de recaudar.</p>
          </section>
          <section className="rounded-lg border border-[#D1C7BD] bg-white px-4 py-3">
            <h4 className="text-[10px] font-bold uppercase tracking-wider text-[#72383D]">Retiros de socios</h4>
            <strong className="mt-1 block text-xl font-semibold tabular-nums text-[#322D29]">{show(retiros)}</strong>
            <p className="mt-0.5 text-[11px] leading-4 text-[#322D29]/60">Retiros acumulados del período.</p>
          </section>
        </div>

        <section className="rounded-lg border border-[#72383D]/30 bg-[#F1E4DE] px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#72383D]">Saldo efectivo en cuentas corrientes</p>
          <strong className="mt-0.5 block break-words text-2xl font-semibold tabular-nums text-[#322D29]">{show(report.bankBalance)}</strong>
          <p className="mt-0.5 text-[11px] text-[#322D29]/60">Saldo disponible en bancos.</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">{report.accounts.map((account, index) => <div key={`${account.name}-${account.maskedAccount}-${index}`} className="rounded-md border border-[#72383D]/20 bg-white/80 px-3 py-2"><p className="text-[11px] font-semibold text-[#322D29]">{account.name} {account.maskedAccount}</p><strong className="mt-0.5 block text-lg font-semibold tabular-nums">{show(account.balance)}</strong><p className="text-[10px] text-[#322D29]/55">{account.date ? date(account.date) : 'sin fecha'}</p></div>)}</div>
          {!report.accounts.length && <p className="mt-2 text-xs text-[#322D29]/60">Sin saldos bancarios observados.</p>}
          <p className="mt-2 text-[11px] leading-4 text-[#322D29]/70">El saldo bancario no se reconcilia directamente con el resultado del período. La conciliación completa requerirá incorporar cuentas por pagar, obligaciones y otros componentes del capital de trabajo.</p>
        </section>

        <section className="rounded-lg border border-dashed border-[#AC9C8D] bg-[#FAF7F3] px-4 py-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h4 className="text-xs font-bold uppercase tracking-wider text-[#72383D]">Cuentas por pagar y obligaciones</h4>
            <span className="rounded-full border border-[#AC9C8D] bg-white px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-[#AC9C8D]">Próximamente</span>
          </div>
          <p className="mt-1.5 text-[11px] leading-4 text-[#322D29]/70">Esta sección se ampliará cuando estén disponibles las cuentas por pagar, obligaciones y otros componentes del capital de trabajo.</p>
        </section>
      </div>
    </DialogContent>
  </Dialog>
}

function MovementDetail({ movement }: { movement: NonPnlCashMovement }) {
  return (
    <div className="grid gap-2 text-xs sm:grid-cols-2">
      <div><p className="text-[9px] uppercase tracking-wider text-[#322D29]/50">Fecha</p><p className="mt-0.5 font-semibold">{date(movement.date)}</p></div>
      <div><p className="text-[9px] uppercase tracking-wider text-[#322D29]/50">Monto</p><p className="mt-0.5 font-semibold">{money(movement.amount)}</p></div>
      <div><p className="text-[9px] uppercase tracking-wider text-[#322D29]/50">Banco</p><p className="mt-0.5 font-semibold">{movement.bankName} · {movement.maskedAccountNumber}</p></div>
      <div><p className="text-[9px] uppercase tracking-wider text-[#322D29]/50">Categoría</p><p className="mt-0.5 font-semibold">{movement.categoryName}</p></div>
      <div><p className="text-[9px] uppercase tracking-wider text-[#322D29]/50">Clasificación</p><p className="mt-0.5 font-semibold">{movement.classificationSource ?? '—'}</p></div>
      <div><p className="text-[9px] uppercase tracking-wider text-[#322D29]/50">Revisión</p><p className="mt-0.5 font-semibold">{movement.reviewStatus ?? '—'}</p></div>
      <div className="sm:col-span-2"><p className="text-[9px] uppercase tracking-wider text-[#322D29]/50">Descripción bancaria</p><p className="mt-0.5 font-semibold">{movement.description}</p></div>
    </div>
  )
}

function movementForCode(data: NonPnlCashData | null, code: string) {
  return (data?.movements ?? []).filter(movement => {
    if (code === 'INTERCOMPANY') return movement.categoryCode === 'INCOME_INTERNAL_TRANSFER' || movement.categoryCode === 'EXPENSE_INTERNAL_TRANSFER' || movement.categoryCode === 'INCOME_INTERCOMPANY' || movement.categoryCode === 'EXPENSE_INTERCOMPANY'
    if (code === 'CREDIT_LINE_NET' || code === 'CREDIT_LINE_AVAILABLE') return movement.subtype === 'CREDIT_LINE_DRAW' || movement.subtype === 'CREDIT_LINE_PAYMENT'
    if (code === 'LOAN_RECEIPT' || code === 'CREDIT_LINE_DRAW' || code === 'LOAN_PAYMENT' || code === 'CREDIT_LINE_PAYMENT') return movement.subtype === code
    return movement.categoryCode === code
  })
}

function movementForPeriod(data: NonPnlCashData | null, code: string, month: number | null) {
  return movementForCode(data, code).filter(movement => month === null || Number(movement.date.slice(5, 7)) === month)
}

function creditLineSummary(movements: NonPnlCashMovement[]) {
  const usage = movements.filter(movement => movement.subtype === 'CREDIT_LINE_DRAW').reduce((total, movement) => total + movement.amount, 0)
  const payment = movements.filter(movement => movement.subtype === 'CREDIT_LINE_PAYMENT').reduce((total, movement) => total + movement.amount, 0)
  return { usage, payment, net: usage - payment }
}

type CreditLineBalanceSummary = {
  opening: number
  usage: number
  payment: number
  closing: number
}

type CreditLineAvailabilitySummary = {
  total: number
  used: number
  available: number
}

function MovementDrawer({ title, year, month, movements, total, netSummary, balanceSummary, availabilitySummary, onClose }: { title: string; year: number; month: number | null; movements: NonPnlCashMovement[]; total?: number; netSummary?: ReturnType<typeof creditLineSummary>; balanceSummary?: CreditLineBalanceSummary; availabilitySummary?: CreditLineAvailabilitySummary; onClose: () => void }) {
  const [selectedMovement, setSelectedMovement] = useState<NonPnlCashMovement | null>(null)
  const period = month === null ? String(year) : `${MONTHS_FULL[month - 1]} ${year}`
  return (
    <Sheet open onOpenChange={open => { if (!open) onClose() }}>
      <SheetContent className={DETAIL_DRAWER_CLASS}>
        <SheetHeader className="gap-0.5 p-4 pb-2"><SheetTitle>{title} · {period}</SheetTitle><SheetDescription><span className="mr-4"><strong>TOTAL</strong> {money(total ?? movements.reduce((total, movement) => total + movement.amount, 0))}</span><span className="mr-4"><strong>REGISTROS</strong> {movements.length}</span><span><strong>BANCOS</strong> {new Set(movements.map(movement => movement.bankName)).size}</span></SheetDescription></SheetHeader>
        {netSummary && <div className="mx-4 border border-[#D1C7BD] bg-white p-2 text-xs"><div className="flex justify-between gap-3"><span>Uso del período</span><strong className="tabular-nums">{money(netSummary.usage)}</strong></div><div className="mt-1 flex justify-between gap-3"><span>Pago/restitución del período</span><strong className="tabular-nums">{money(netSummary.payment)}</strong></div><div className="mt-1 flex justify-between gap-3 border-t border-[#D1C7BD] pt-1"><span>Saldo neto del período</span><strong className="tabular-nums">{signedMoney(netSummary.net)}</strong></div></div>}
        {balanceSummary && <div className="mx-4 border border-[#D1C7BD] bg-white p-2 text-xs"><div className="flex justify-between gap-3"><span>Saldo inicial del período</span><strong className="tabular-nums">{signedMoney(balanceSummary.opening)}</strong></div><div className="mt-1 flex justify-between gap-3"><span>Nuevos usos</span><strong className="tabular-nums">+{money(balanceSummary.usage)}</strong></div><div className="mt-1 flex justify-between gap-3"><span>Pagos/restituciones</span><strong className="tabular-nums">-{money(balanceSummary.payment)}</strong></div><div className="mt-1 flex justify-between gap-3 border-t border-[#D1C7BD] pt-1"><span>Saldo final usado</span><strong className="tabular-nums">{signedMoney(balanceSummary.closing)}</strong></div></div>}
        {availabilitySummary && <div className="mx-4 border border-[#D1C7BD] bg-white p-2 text-xs"><div className="flex justify-between gap-3"><span>Línea total</span><strong className="tabular-nums">{money(availabilitySummary.total)}</strong></div><div className="mt-1 flex justify-between gap-3"><span>Saldo usado final</span><strong className="tabular-nums">-{money(availabilitySummary.used)}</strong></div><div className="mt-1 flex justify-between gap-3 border-t border-[#D1C7BD] pt-1"><span>Disponible final</span><strong className="tabular-nums">{money(availabilitySummary.available)}</strong></div></div>}
        <div className="mt-1 space-y-1">{movements.map(movement => <button type="button" key={movement.id} onClick={() => setSelectedMovement(movement)} className="block w-full border border-[#D1C7BD] bg-white p-2 text-left text-xs hover:bg-[#F8F4EF]"><span className="font-semibold">{date(movement.date)} · {movement.bankName} · {movement.maskedAccountNumber}</span><span className="mt-0.5 block">{movement.description}</span><span className="mt-0.5 block font-semibold tabular-nums">{money(movement.amount)} · {movement.categoryName}</span></button>)}{!movements.length && <p className="text-xs text-[#322D29]/60">No hay movimientos para este indicador.</p>}</div>
        {selectedMovement && <div className="mt-2 border-t border-[#D1C7BD] px-4 pb-4 pt-2"><MovementDetail movement={selectedMovement} /></div>}
      </SheetContent>
    </Sheet>
  )
}

export function ManagerialLiquidityCards({ resultYtd, marginYtd, estimated = false, confirmedYtd = null, confirmedMarginYtd = null, confirmedCoverage = '', managerialCoverage = '', estimatedMonths = [], data, currentBalance, accountBalances, year }: { resultYtd: string | null; marginYtd: number | null; estimated?: boolean; confirmedYtd?: string | null; confirmedMarginYtd?: number | null; confirmedCoverage?: string; managerialCoverage?: string; estimatedMonths?: string[]; data: NonPnlCashData | null; currentBalance: number | null; accountBalances: FinancialAccountBalance[]; year: number }) {
  const [movementDetail, setMovementDetail] = useState<{ title: string; code: string } | null>(null)
  const [bankDetail, setBankDetail] = useState(false)
  const movementCards = [
    { label: 'Retiros de socios', value: data?.ownerWithdrawalsYtd ?? 0, code: 'EXPENSE_OWNER_WITHDRAWAL', title: 'Retiros de socio / propietario' },
    { label: 'Pago de préstamos', value: data?.loanPaymentsYtd ?? 0, code: 'LOAN_PAYMENT', title: 'Pago de préstamos bancarios' },
    { label: 'Pago línea de crédito', value: data?.creditLinePaymentsYtd ?? 0, code: 'CREDIT_LINE_PAYMENT', title: 'Pago línea de crédito' },
  ].filter(card => card.value > 0)
  const cards = [
    { label: 'Resultado final YTD', value: resultYtd !== null ? money(Number(resultYtd)) : '—', detail: estimated ? `${managerialCoverage} · incluye remuneraciones estimadas ${estimatedMonths.join('–')} · Confirmado: ${confirmedCoverage} ${confirmedYtd !== null ? money(Number(confirmedYtd)) : '—'}${confirmedMarginYtd !== null ? ` · ${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(confirmedMarginYtd)}%` : ''}` : 'Resultado final del EERR', estimated, onClick: undefined },
    { label: 'Margen final', value: marginYtd === null ? '—' : `${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 1 }).format(marginYtd)}%`, detail: estimated ? `Sobre ventas ${managerialCoverage}` : 'Resultado final sobre ventas', estimated, onClick: undefined },
    ...movementCards.map(card => ({ label: card.label, value: money(card.value), detail: 'Abrir movimientos', estimated: false, onClick: () => setMovementDetail({ title: card.title, code: card.code }) })),
    { label: 'Saldo bancos', value: currentBalance === null ? '—' : money(currentBalance), detail: 'Abrir saldos por cuenta', estimated: false, onClick: currentBalance === null ? undefined : () => setBankDetail(true) },
  ]
  return <>
    <section className="mb-4 border border-[#D1C7BD] bg-[#F8F4EF] p-2.5 sm:p-3">
      <div className="border-b border-[#D1C7BD] pb-1.5"><p className="text-[9px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Gestión de liquidez</p><h3 className="mt-0.5 text-xs font-semibold">INDICADORES GERENCIALES</h3></div>
      <div className="mt-2 grid min-w-0 grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {cards.map(card => <button key={card.label} type="button" disabled={!card.onClick} onClick={card.onClick} className={`min-h-[68px] min-w-0 border px-3 py-2 text-left [overflow-wrap:anywhere] ${card.onClick ? 'cursor-pointer border-[#AC9C8D] bg-white hover:border-[#72383D]' : 'cursor-default border-[#D1C7BD] bg-white'}`}><p className="text-[10px] font-bold uppercase leading-4 tracking-[0.06em] text-[#72383D]">{card.label}</p><p className={`mt-1 text-base font-semibold leading-5 tabular-nums ${card.estimated ? 'text-[#1453A0]' : 'text-[#322D29]'}`}>{card.value}{card.estimated && <span className="ml-1 text-[10px]">EST.</span>}</p><p className="mt-1 text-[11px] leading-4 text-[#322D29]/65">{card.detail}</p></button>)}
      </div>
      <p className="mt-2 text-[9px] leading-3.5 text-[#322D29]/60">El resultado del negocio no equivale al efectivo disponible. Retiros, financiamiento, inversiones y movimientos de capital pueden afectar la caja sin modificar el resultado.</p>
    </section>
    {movementDetail && <MovementDrawer title={movementDetail.title} year={year} month={null} movements={movementForCode(data, movementDetail.code)} onClose={() => setMovementDetail(null)} />}
    <Sheet open={bankDetail} onOpenChange={setBankDetail}>
       <SheetContent className="w-full gap-2 overflow-y-auto border-[#D1C7BD] bg-[#FCFBF9] sm:!w-[620px] sm:!max-w-[620px]"><SheetHeader className="gap-0.5 p-4 pb-2"><SheetTitle>Saldo bancario actual · {year}</SheetTitle><SheetDescription>Saldos consolidados por cuenta, sin línea de crédito disponible.</SheetDescription></SheetHeader><div className="mt-1 space-y-1">{accountBalances.map(account => <div key={account.accountId} className="border border-[#D1C7BD] bg-white p-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-semibold">{account.bankName} · {account.maskedAccountNumber}</span><strong className="tabular-nums">{account.balance === null ? '—' : money(account.balance)}</strong></div><p className="mt-0.5 text-[#322D29]/55">Actualizado: {account.balanceDate ?? '—'}</p></div>)}</div></SheetContent>
    </Sheet>
  </>
}

const CREDIT_LINE_CODES = ['CREDIT_LINE_DRAW', 'CREDIT_LINE_PAYMENT', 'CREDIT_LINE_NET', 'CREDIT_LINE_AVAILABLE'] as const

function creditLineRows(data: NonPnlCashData) {
  return {
    usage: data.rows.find(row => row.code === 'CREDIT_LINE_DRAW'),
    payment: data.rows.find(row => row.code === 'CREDIT_LINE_PAYMENT'),
    closing: data.rows.find(row => row.code === 'CREDIT_LINE_NET'),
  }
}

function creditLineClosingBalances(usage: number[], payment: number[]) {
  let balance = 0
  return usage.map((value, index) => {
    balance += value + payment[index]
    return balance
  })
}

export function CreditLineControlSection({ data, accountBalances, year }: { data: NonPnlCashData; accountBalances: FinancialAccountBalance[]; year: number }) {
  const rows = creditLineRows(data)
  const account = accountBalances.find(item => item.creditLineTotal !== null || item.creditLineUsed !== null || item.creditLineAvailable !== null)
  const usage = rows.usage?.monthly ?? Array(12).fill(0)
  const payment = (rows.payment?.monthly ?? Array(12).fill(0)).map(value => -Math.abs(value))
  const closing = creditLineClosingBalances(usage, payment)
  const coverageMonth = account?.balanceDate?.startsWith(`${year}-`) ? Number(account.balanceDate.slice(5, 7)) : null
  const coveredClosing = closing.map((value, index) => coverageMonth !== null && index + 1 <= coverageMonth ? value : null)
  const currentClosing = account?.creditLineUsed ?? closing[11]
  const available = coveredClosing.map(value => value === null || account?.creditLineTotal === null || account?.creditLineTotal === undefined ? null : account.creditLineTotal - value)
  const currentAvailable = account?.creditLineAvailable ?? (account?.creditLineTotal !== null && account?.creditLineTotal !== undefined ? account.creditLineTotal - currentClosing : null)
  const [selection, setSelection] = useState<{ code: typeof CREDIT_LINE_CODES[number]; month: number | null } | null>(null)
  const selectedMovements = selection ? movementForPeriod(data, selection.code, selection.month) : []
  const selectedMonthIndex = selection?.month === null || selection?.month === undefined ? null : selection.month - 1
  const selectedOpening = selectedMonthIndex === null ? 0 : selectedMonthIndex === 0 ? 0 : closing[selectedMonthIndex - 1]
  const selectedUsage = selectedMonthIndex === null ? rows.usage?.ytd ?? 0 : usage[selectedMonthIndex]
  const selectedPayment = selectedMonthIndex === null ? Math.abs(rows.payment?.ytd ?? 0) : Math.abs(payment[selectedMonthIndex])
  const selectedClosing = selectedMonthIndex === null ? currentClosing : coveredClosing[selectedMonthIndex]
  const selectedAvailable = selectedMonthIndex === null ? currentAvailable : available[selectedMonthIndex]
  const balanceSummary = selection && selectedClosing !== null ? { opening: selectedOpening, usage: selectedUsage, payment: selectedPayment, closing: selectedClosing } : undefined
  const value = (amount: number | null | undefined) => amount === null || amount === undefined ? '—' : money(amount)

  return <section className="mt-5 border border-[#D1C7BD] bg-[#F8F4EF] p-3 sm:p-4">
    <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[#D1C7BD] pb-2">
      <div><p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Financiamiento</p><h3 className="mt-1 text-sm font-semibold">CONTROL DE LÍNEA DE CRÉDITO</h3></div>
      <p className="text-[10px] text-[#322D29]/55">Año {year} · clic para detalle</p>
    </div>
    <div className="mt-2 grid gap-1.5 sm:grid-cols-2 lg:grid-cols-5">
      {[
        ['LÍNEA TOTAL', value(account?.creditLineTotal)],
        ['UTILIZADO ACTUAL', value(account?.creditLineUsed)],
        ['DISPONIBLE ACTUAL', value(account?.creditLineAvailable)],
        ['USO ACUMULADO YTD', value(rows.usage?.ytd)],
        ['PAGO / RESTITUCIÓN YTD', value(Math.abs(rows.payment?.ytd ?? 0))],
      ].map(([label, amount]) => <div key={label} className="min-h-[58px] border border-[#D1C7BD] bg-white px-2.5 py-1.5"><p className="text-[8px] font-bold uppercase leading-3 tracking-[0.06em] text-[#72383D]">{label}</p><p className="mt-1 text-base font-semibold leading-5 tabular-nums">{amount}</p></div>)}
    </div>
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[760px] text-left text-xs">
        <thead className="text-[10px] uppercase tracking-[0.1em] text-[#322D29]/55"><tr><th className="px-2 py-2">Concepto</th>{MONTHS.map(month => <th key={month} className="px-2 py-2 text-right">{month}</th>)}<th className="px-2 py-2 text-right">YTD/ACTUAL</th></tr></thead>
        <tbody>
          <CreditLineRow year={year} label="Uso de línea de crédito" code="CREDIT_LINE_DRAW" values={usage} ytd={rows.usage?.ytd ?? 0} onSelect={month => setSelection({ code: 'CREDIT_LINE_DRAW', month })} />
          <CreditLineRow year={year} label="Pago / restitución línea de crédito" code="CREDIT_LINE_PAYMENT" values={payment} ytd={payment.reduce((sum, amount) => sum + amount, 0)} onSelect={month => setSelection({ code: 'CREDIT_LINE_PAYMENT', month })} />
          <CreditLineRow year={year} label="Saldo usado al cierre" code="CREDIT_LINE_NET" values={coveredClosing} ytd={currentClosing} onSelect={month => setSelection({ code: 'CREDIT_LINE_NET', month })} />
          <CreditLineRow year={year} label="Disponible al cierre" code="CREDIT_LINE_AVAILABLE" values={available} ytd={currentAvailable} onSelect={month => setSelection({ code: 'CREDIT_LINE_AVAILABLE', month })} />
        </tbody>
      </table>
    </div>
    <p className="mt-2 text-[9px] text-[#322D29]/60">Estado actual tomado de la última metadata bancaria válida. Saldo final acumulado: {value(currentClosing)}.</p>
    {selection && <MovementDrawer title={selection.code === 'CREDIT_LINE_DRAW' ? 'Uso de línea de crédito' : selection.code === 'CREDIT_LINE_PAYMENT' ? 'Pago / restitución línea de crédito' : selection.code === 'CREDIT_LINE_NET' ? 'Saldo usado al cierre' : 'Disponible al cierre'} year={year} month={selection.month} movements={selectedMovements} total={selection.code === 'CREDIT_LINE_NET' ? selectedClosing ?? undefined : selection.code === 'CREDIT_LINE_AVAILABLE' ? selectedAvailable ?? undefined : selection.code === 'CREDIT_LINE_DRAW' ? selectedUsage : -selectedPayment} balanceSummary={selection.code === 'CREDIT_LINE_NET' ? balanceSummary : undefined} availabilitySummary={selection.code === 'CREDIT_LINE_AVAILABLE' && account?.creditLineTotal !== null && account?.creditLineTotal !== undefined && selectedClosing !== null && selectedAvailable !== null ? { total: account.creditLineTotal, used: selectedClosing, available: selectedAvailable } : undefined} onClose={() => setSelection(null)} />}
  </section>
}

function CreditLineRow({ year, label, code, values, ytd, onSelect }: { year: number; label: string; code: typeof CREDIT_LINE_CODES[number]; values: Array<number | null>; ytd: number | null; onSelect: (month: number | null) => void }) {
  return <tr className="border-t border-[#E4DCD3] bg-white hover:bg-[#FCFBF9]"><td className="px-2 py-2"><button type="button" className="text-left font-semibold text-[#72383D] underline-offset-2 hover:underline" onClick={() => onSelect(null)}>{label}</button></td>{values.map((value, index) => <td key={`${code}-${index}`} className="px-2 py-2 text-right tabular-nums"><button type="button" disabled={value === null || value === 0} aria-label={`${label} ${MONTHS[index]} ${year}. Abrir detalle`} onClick={() => onSelect(index + 1)} className={`w-full rounded px-1 text-right tabular-nums hover:text-[#72383D] hover:underline disabled:cursor-default ${value !== null && value < 0 ? 'text-[#A23E48]' : ''}`}>{value === null || value === 0 ? '—' : signedMoney(value)}</button></td>)}<td className={`px-2 py-2 text-right font-semibold tabular-nums ${ytd !== null && ytd < 0 ? 'text-[#A23E48]' : ''}`}><button type="button" disabled={ytd === null || ytd === 0} onClick={() => onSelect(null)} className="w-full rounded px-1 text-right tabular-nums hover:text-[#72383D] hover:underline disabled:cursor-default">{ytd === null || ytd === 0 ? '—' : signedMoney(ytd)}</button></td></tr>
}

export function NonPnlCashSection({ data, currentBalance, year }: { data: NonPnlCashData; currentBalance: number | null; year: number }) {
  const [selection, setSelection] = useState<{ code: string; month: number | null } | null>(null)
  const selectedRow = data.rows.find(row => row.code === selection?.code)
  const selectedMovements = selection ? movementForPeriod(data, selection.code, selection.month) : []
  const selectedTotal = selectedRow && selection ? (selection.month === null ? selectedRow.ytd : selectedRow.monthly[selection.month - 1]) : undefined
  const selectedNetSummary = selection?.code === 'CREDIT_LINE_NET' ? creditLineSummary(selectedMovements) : undefined
  const visibleRows = data.rows.filter(row => !CREDIT_LINE_CODES.includes(row.code as typeof CREDIT_LINE_CODES[number]))
  return (
    <section className="mt-5 border border-[#D1C7BD] bg-[#F8F4EF] p-3 sm:p-4">
      <div className="flex flex-wrap items-end justify-between gap-2 border-b border-[#D1C7BD] pb-2">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-[#72383D]">Caja gerencial</p>
          <h3 className="mt-1 text-sm font-semibold">MOVIMIENTOS DE CAJA FUERA DEL RESULTADO</h3>
        </div>
        <p className="text-[10px] text-[#322D29]/55">Año {year} · clic para detalle</p>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[760px] text-left text-xs">
          <thead className="text-[10px] uppercase tracking-[0.1em] text-[#322D29]/55"><tr><th className="px-2 py-2">Movimiento</th>{MONTHS.map(month => <th key={month} className="px-2 py-2 text-right">{month}</th>)}<th className="px-2 py-2 text-right">YTD</th></tr></thead>
          <tbody>
            {visibleRows.map(row => <tr key={row.code} className="border-t border-[#E4DCD3] bg-white hover:bg-[#FCFBF9]">
              <td className="px-2 py-2"><button type="button" className="text-left font-semibold text-[#72383D] underline-offset-2 hover:underline" onClick={() => setSelection({ code: row.code, month: null })}>{row.label}{row.informational && <span className="ml-1 text-[9px] font-normal text-[#322D29]/50">(informativo, impacto $0)</span>}</button><span className="ml-1 text-[10px] text-[#322D29]/45">· {row.movementCount}</span></td>
              {row.monthly.map((value, index) => <td key={`${row.code}-${index}`} className="px-2 py-2 text-right tabular-nums"><button type="button" disabled={!value} aria-label={`${row.label} ${MONTHS[index]} ${year}. Abrir detalle`} onClick={() => setSelection({ code: row.code, month: index + 1 })} className="w-full rounded px-1 text-right tabular-nums hover:text-[#72383D] hover:underline disabled:cursor-default">{value ? signedMoney(value) : '—'}</button></td>)}
              <td className={`px-2 py-2 text-right font-semibold tabular-nums ${row.ytd < 0 ? 'text-[#A23E48]' : 'text-[#322D29]'}`}><button type="button" disabled={!row.ytd} aria-label={`${row.label} YTD ${year}. Abrir detalle`} onClick={() => setSelection({ code: row.code, month: null })} className="w-full rounded px-1 text-right tabular-nums hover:text-[#72383D] hover:underline disabled:cursor-default">{row.ytd ? signedMoney(row.ytd) : '—'}</button></td>
            </tr>)}
          </tbody>
        </table>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-[#D1C7BD] pt-3 text-xs"><span className="font-semibold uppercase tracking-[0.1em] text-[#72383D]">SALDO BANCARIO ACTUAL</span><strong className="text-base tabular-nums">{currentBalance === null ? '—' : money(currentBalance)}</strong></div>
       {selectedRow && selection && <MovementDrawer title={selectedRow.label} year={year} month={selection.month} movements={selectedMovements} total={selectedTotal} netSummary={selectedNetSummary} onClose={() => setSelection(null)} />}
    </section>
  )
}
