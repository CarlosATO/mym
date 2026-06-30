import React from 'react'
import { RouteSettlement, RouteSettlementItem } from '../types'
import { formatCurrency, formatDate, formatSettlementItemStatus, formatExpectedPaymentMethod } from '../utils/route-settlement-formatters'
import { SettlementStatusBadge } from './route-settlement-badges'
import { ArrowLeft, Edit, AlertCircle } from 'lucide-react'

interface RouteSettlementDetailPanelProps {
  settlement: RouteSettlement
  items: RouteSettlementItem[]
  onClose: () => void
}

export function RouteSettlementDetailPanel({
  settlement,
  items,
  onClose
}: RouteSettlementDetailPanelProps) {
  
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-2 duration-300">
      
      {/* Header Actions */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-theme-border/60">
        <div className="flex items-center gap-4">
          <button
            onClick={onClose}
            className="p-2 -ml-2 rounded-xl hover:bg-theme-text/5 text-theme-text-muted transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h2 className="text-xl font-bold text-theme-text flex items-center gap-3">
              Rendición {settlement.settlement_number}
              <SettlementStatusBadge status={settlement.status} />
            </h2>
            <p className="text-xs text-theme-text-muted mt-1">
              Guía base: <span className="font-semibold text-theme-text">{settlement.guide_number}</span> ({formatDate(settlement.settlement_date)})
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <button
            disabled
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover disabled:opacity-50 text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20"
          >
            <Edit className="w-4 h-4" /> Próxima Fase (Editar)
          </button>
        </div>
      </div>

      {/* Cabecera Guía */}
      <div className="p-5 rounded-2xl border border-theme-border bg-theme-surface/50 grid grid-cols-2 md:grid-cols-4 gap-6">
        <div>
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Ruta</p>
          <p className="text-sm font-semibold text-theme-text">{settlement.route_name || '-'}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Conductor</p>
          <p className="text-sm font-semibold text-theme-text">{settlement.driver_name || '-'}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Vendedor</p>
          <p className="text-sm font-semibold text-theme-text">{settlement.seller_name || '-'}</p>
        </div>
        <div>
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Total Facturas</p>
          <p className="text-sm font-semibold text-theme-text">{settlement.total_invoices}</p>
        </div>
      </div>

      {/* Resumen Financiero */}
      <h3 className="text-sm font-bold text-theme-text mt-8 mb-4">Resumen Financiero</h3>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="p-4 rounded-xl border border-theme-border bg-theme-surface">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Monto Total Ruta</p>
          <p className="text-xl font-bold text-theme-text">{formatCurrency(settlement.total_route_amount)}</p>
        </div>
        <div className="p-4 rounded-xl border border-theme-border bg-theme-surface">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Efectivo Esperado</p>
          <p className="text-xl font-bold text-theme-text">{formatCurrency(settlement.total_cash_expected)}</p>
        </div>
        <div className="p-4 rounded-xl border border-theme-border bg-theme-surface">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Efectivo Recibido</p>
          <p className="text-xl font-bold text-green-600 dark:text-green-400">{formatCurrency(settlement.total_cash_received)}</p>
        </div>
        <div className="p-4 rounded-xl border border-theme-border bg-theme-surface">
          <p className="text-[10px] font-bold text-theme-text-muted uppercase mb-1">Diferencia Efectivo</p>
          <p className={`text-xl font-bold ${settlement.total_cash_difference > 0 ? 'text-red-500' : 'text-theme-text-muted'}`}>
            {formatCurrency(settlement.total_cash_difference)}
          </p>
        </div>
      </div>

      {/* Grid de Ítems */}
      <h3 className="text-sm font-bold text-theme-text mt-12 mb-4">Detalle de Facturas</h3>
      <div className="overflow-x-auto rounded-xl border border-theme-border bg-theme-surface">
        <table className="w-full text-left text-xs whitespace-nowrap">
          <thead>
            <tr className="border-b border-theme-border/50 bg-theme-text/5">
              <th className="px-4 py-3 font-bold text-theme-text-muted">Factura</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">Cliente</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-right">Monto Esp.</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">Forma Pago Esp.</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-right">Monto Recib.</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-right">Diferencia</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted text-center">Estado Inicial</th>
              <th className="px-4 py-3 font-bold text-theme-text-muted">Observación</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-theme-border/50">
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-theme-text/[0.02] transition-colors">
                <td className="px-4 py-3 font-bold text-theme-text">{item.invoice_number}</td>
                <td className="px-4 py-3 text-theme-text max-w-[200px] truncate" title={item.customer_name}>{item.customer_name}</td>
                <td className="px-4 py-3 text-theme-text text-right font-semibold">{formatCurrency(item.expected_amount)}</td>
                <td className="px-4 py-3 text-theme-text">{formatExpectedPaymentMethod(item.expected_payment_method)}</td>
                <td className="px-4 py-3 text-theme-text text-right font-semibold text-green-600 dark:text-green-400">{formatCurrency(item.received_amount)}</td>
                <td className="px-4 py-3 text-right">
                  <span className={`font-bold ${item.difference_amount > 0 ? 'text-red-500' : 'text-theme-text-muted'}`}>
                    {formatCurrency(item.difference_amount)}
                  </span>
                </td>
                <td className="px-4 py-3 text-center">
                  <span className={`px-2 py-1 rounded text-[10px] uppercase font-bold tracking-wider ${
                    item.status === 'REVIEW_REQUIRED' ? 'bg-orange-500/10 text-orange-600' : 'bg-theme-text/5 text-theme-text'
                  }`}>
                    {formatSettlementItemStatus(item.status)}
                  </span>
                </td>
                <td className="px-4 py-3 text-theme-text-muted max-w-[150px] truncate">
                  {item.notes || '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      
    </div>
  )
}
