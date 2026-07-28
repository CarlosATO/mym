'use client'

import { KpiCard } from '../kpi-card'
import type { SupplierPurchaseSales360 } from '@/app/actions/comercial/analysis/types'

function money(value: number | null) {
  if (value === null) return 'Sin datos'
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function marginMoney(value: number | null): string {
  if (value === null) return 'Sin costo'
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function pct(value: number | null) {
  if (value === null) return '—'
  return `${value}%`
}

function marginPctDisplay(data: { estimated_margin_pct: number | null; estimated_margin: number | null } | null | undefined): string {
  if (!data) return '—'
  if (data.estimated_margin_pct === null) {
    return (data.estimated_margin !== null && data.estimated_margin > 0) ? 'Sin costo' : '—'
  }
  return `${data.estimated_margin_pct}%`
}

export function SupplierKpis({ data, loading }: { data: SupplierPurchaseSales360 | null; loading: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <KpiCard title="Compras recepcionadas netas" value={data ? money(data.kpis.purchases_amount) : '—'} icon="ShoppingBasket" loading={loading} />
      <KpiCard title="Ventas netas del período" value={data ? money(data.kpis.sales_amount) : '—'} icon="TrendingUp" accent loading={loading} />
      <KpiCard title="Margen bruto estimado" value={data ? marginMoney(data.kpis.estimated_margin) : '—'} icon="BadgeDollarSign" tooltip="Margen bruto estimado. No incluye gastos operacionales, fletes, sueldos, arriendo, mermas, comisiones ni costos financieros." loading={loading} />
      <KpiCard title="Margen bruto %" value={data ? marginPctDisplay(data.kpis) : '—'} icon="Percent" tooltip="Margen bruto / Ventas netas. Si no hay costo de ventas disponible, muestra Sin costo." loading={loading} />
      <KpiCard title="Stock valorizado" value={data ? money(data.kpis.stock_value) : '—'} icon="Warehouse" tooltip="Stock actual × costo unitario (Bsale o último conocido)." loading={loading} />
    </div>
  )
}
