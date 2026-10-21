'use client'

import { X } from 'lucide-react'
import type { SalesOrderPreparationCommercialIncident } from '@/app/actions/logistica/sales-order-preparation'

function formatQuantity(value: number | null): string {
  return value == null ? '—' : Number(value).toLocaleString('es-CL')
}

function actionLabel(incident: SalesOrderPreparationCommercialIncident): string {
  if (incident.required_bsale_action === 'REMOVE_LINE') {
    return 'Eliminar producto de la Nota de Venta'
  }
  return `Cambiar cantidad en Bsale de ${formatQuantity(incident.bsale_observed_quantity)} a ${formatQuantity(incident.expected_bsale_quantity)}`
}

export function PreparationCommercialIncidentsDialog({
  open,
  loading,
  error,
  nvFolio,
  incidents,
  onClose,
}: {
  open: boolean
  loading: boolean
  error: string | null
  nvFolio: string | null
  incidents: SalesOrderPreparationCommercialIncident[]
  onClose: () => void
}) {
  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/25 p-4" role="presentation" onMouseDown={event => {
      if (event.target === event.currentTarget) onClose()
    }}>
      <section
        role="dialog"
        aria-modal="true"
        aria-labelledby="commercial-incidents-title"
        className="w-full max-w-lg rounded-xl border border-[#D1C7BD] bg-[#FCFBF9] p-4 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase tracking-wider text-[#72383D]">NV #{nvFolio ?? '—'}</p>
            <h2 id="commercial-incidents-title" className="mt-0.5 text-sm font-bold text-[#322D29]">Tareas por corregir en Bsale</h2>
          </div>
          <button type="button" onClick={onClose} aria-label="Cerrar tareas comerciales" className="rounded-md p-1 text-[#322D29]/55 hover:bg-[#F1EAE2] hover:text-[#322D29]">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <p className="mt-4 text-xs font-medium text-[#322D29]/60">Cargando tareas…</p>
        ) : error ? (
          <p className="mt-4 rounded-md border border-[#8A4B4B]/25 bg-[#8A4B4B]/10 px-2.5 py-2 text-xs font-medium text-[#8A4B4B]">{error}</p>
        ) : incidents.length === 0 ? (
          <p className="mt-4 text-xs font-medium text-[#322D29]/60">No hay tareas comerciales abiertas.</p>
        ) : (
          <div className="mt-4 max-h-[min(55vh,420px)] space-y-2 overflow-y-auto pr-1">
            {incidents.map(incident => (
              <article key={incident.id} className="rounded-lg border border-[#DDD4CA] bg-white px-3 py-2.5">
                <div className="flex items-baseline justify-between gap-3">
                  <p className="min-w-0 truncate text-xs font-bold text-[#322D29]" title={incident.product_name}>
                    {incident.sku ? `SKU ${incident.sku}` : 'Producto'} · {incident.product_name}
                  </p>
                  <span className="shrink-0 text-[10px] font-semibold text-[#322D29]/55">NV #{incident.nv_folio ?? nvFolio ?? '—'}</span>
                </div>
                <p className="mt-1 text-xs font-semibold text-[#72383D]">{actionLabel(incident)}</p>
                {(incident.observation || incident.reason_code) && (
                  <p className="mt-1 text-[10px] text-[#322D29]/55">{incident.observation ?? incident.reason_code}</p>
                )}
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
