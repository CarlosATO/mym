'use client'

import { KpiCard } from '../kpi-card'
import type { SupplierPurchaseSales360 } from '@/app/actions/comercial/analysis/types'

function money(value: number | null) {
  if (value === null) return 'Sin datos'
  return '$' + Math.round(value).toLocaleString('es-CL')
}

function dateLabel(value: string | null) {
  if (!value) return 'Pendiente sync recepciones'
  const [y, m, d] = value.split('-')
  return `${d}/${m}/${y}`
}

export function SupplierKpis({ data, loading }: { data: SupplierPurchaseSales360 | null; loading: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
      <KpiCard title="Compras del período" value={data ? money(data.kpis.purchases_amount) : '—'} icon="ShoppingBasket" loading={loading} />
      <KpiCard title="Ventas del período" value={data ? money(data.kpis.sales_amount) : '—'} icon="TrendingUp" accent loading={loading} />
      <KpiCard title="Margen estimado" value={data ? money(data.kpis.estimated_margin) : '—'} icon="BadgeDollarSign" loading={loading} />
      <KpiCard title="Stock valorizado" value={data ? money(data.kpis.stock_value) : '—'} icon="Warehouse" loading={loading} />
      <KpiCard title="Última compra" value={data ? dateLabel(data.kpis.last_purchase_date) : '—'} icon="CalendarClock" loading={loading} />
    </div>
  )
}
