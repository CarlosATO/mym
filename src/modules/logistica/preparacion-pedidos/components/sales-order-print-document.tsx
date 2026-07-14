import type { SalesOrderPreparationCardInfo, SalesOrderPreparationItem, SalesOrderClientData } from '@/app/actions/logistica/sales-order-preparation'

function formatDate(dateStr: string | null) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleDateString('es-CL')
}

function formatTime(dateStr: string | null) {
  if (!dateStr) return '—'
  return new Date(dateStr).toLocaleTimeString('es-CL', { hour: '2-digit', minute: '2-digit' })
}

function formatMoney(amount: number | null) {
  if (amount === null) return '—'
  return amount.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

function statusToLegible(status: string) {
  const map: Record<string, string> = {
    'PENDING_ROUTE_PREP': 'Pendiente de preparación',
    'IN_PREPARATION': 'En preparación',
    'IN_AUDIT': 'En auditoría',
    'INVOICED_READY_FOR_ROUTE': 'Facturada / Lista para ruta',
    'CANCELLED': 'Cancelada'
  }
  return map[status] || status
}

export function SalesOrderPrintDocument({
  card,
  items,
  clientData,
  printedBy = 'Usuario en sesión'
}: {
  card: SalesOrderPreparationCardInfo
  items: SalesOrderPreparationItem[]
  clientData?: SalesOrderClientData | null
  printedBy?: string
}) {
  const printDate = new Date().toISOString()

  return (
    <div className="bg-white text-black text-[10px] font-sans leading-tight sales-order-print-document">
      <style>{`
        @media print {
          @page {
            size: A4;
            margin: 0;
          }
          body {
            -webkit-print-color-adjust: exact;
            print-color-adjust: exact;
          }
          .sales-order-print-document {
            padding: 1cm !important;
            width: 100%;
          }
          table { page-break-inside: auto; }
          tr { page-break-inside: avoid; page-break-after: auto; }
          thead { display: table-header-group; }
        }
      `}</style>
      
      {/* Header */}
      <div className="flex justify-between items-start mb-6">
        <div className="flex gap-4">
          <div className="w-24 h-24 shrink-0 flex items-center justify-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.png" alt="Logo" className="max-w-full max-h-full object-contain" />
          </div>
          <div>
            <h1 className="text-xl font-bold uppercase tracking-tight text-red-800 border-b border-black pb-1 mb-1">DISTRIBUIDORA MYM / PetGroup</h1>
            <p className="font-semibold text-sm">PREPARACIÓN DE BODEGA</p>
            <p className="mt-2 w-64 text-[10px]">VENTA DE ALIMENTOS Y ACCESORIOS PARA MASCOTAS, TRANSPORTE</p>
            <p className="text-[10px]">FUNDO EL TRAPICHE, PARCELA 15, 500 MT DE PASARELA</p>
            <p className="text-[10px]">MAULE - MAULE</p>
            <p className="text-[10px]">Teléfono: +56 9 48618906</p>
          </div>
        </div>

        <div className="border-2 border-red-600 p-4 text-center min-w-[240px] ml-4">
          <p className="font-bold text-red-600 text-sm mb-1 uppercase tracking-widest">RUT: 77.196.005-7</p>
          <p className="font-bold text-red-600 text-lg mb-1 uppercase tracking-widest">Nota Venta</p>
          <p className="text-2xl font-bold text-red-600 tracking-wider">Nº {card.nv_folio}</p>
        </div>
      </div>

      {/* Info Grid (No borders container, just border grid lines) */}
      <div className="grid grid-cols-[60%_40%] border border-black mb-6">
        {/* Customer Column */}
        <div className="p-3 border-r border-black">
          <div className="grid grid-cols-[80px_1fr] gap-y-1">
            <span className="font-bold">SEÑOR:</span>
            <span>{card.client_name || '—'}</span>
            <span className="font-bold">RUT:</span>
            <span>{clientData?.rut || 'No disponible'}</span>
            <span className="font-bold">GIRO:</span>
            <span>Venta de alimentos y accesorios para mascotas</span>
            <span className="font-bold">DIRECCIÓN:</span>
            <span className="truncate">{card.address_raw || '—'}</span>
            <span className="font-bold">COMUNA:</span>
            <span>{card.normalized_city || card.city_raw || '—'}</span>
            <span className="font-bold">CONTACTO:</span>
            <span className="truncate">Tel: {clientData?.phone || 'No disponible'} / Mail: {clientData?.email || 'No disponible'}</span>
          </div>
        </div>

        {/* Commercial Column */}
        <div className="p-3">
          <div className="grid grid-cols-[100px_1fr] gap-y-1">
            <span className="font-bold">FECHA EMISIÓN:</span>
            <span>{formatDate(card.nv_emission_date)}</span>
            <span className="font-bold">FECHA RUTA:</span>
            <span className="font-bold text-[11px]">{formatDate(card.route_date)}</span>
            <span className="font-bold">VENDEDOR:</span>
            <span className="truncate">{card.seller_name || '—'}</span>
            <span className="font-bold mt-2">ESTADO DOC:</span>
            <span className="font-bold text-blue-700 mt-2 whitespace-normal break-words leading-tight">{statusToLegible(card.status)}</span>
          </div>
        </div>
      </div>

      {/* Table */}
      <table className="w-full text-left mb-6 relative">
        <thead>
          <tr className="border-y border-black">
            <th className="py-2 px-1 font-bold w-[15%]">SKU</th>
            <th className="py-2 px-1 font-bold w-[45%]">ITEM</th>
            <th className="py-2 px-1 font-bold w-[20%]">UBICACIÓN</th>
            <th className="py-2 px-1 font-bold text-center w-[10%]">CANT.</th>
            <th className="py-2 px-1 font-bold text-right w-[10%]">SUBTOTAL NETO</th>
          </tr>
        </thead>
        <tbody>
          {items.map((it, idx) => (
            <tr key={it.detail_id || idx} className="h-8 align-top border-b border-gray-100">
              <td className="py-2 px-1 font-mono text-[9px]">{it.sku || '—'}</td>
              <td className="py-2 px-1 pr-2 font-medium">{it.product_name || '—'}</td>
              <td className="py-2 px-1 text-[9px] text-gray-500 italic">Sin ubicación asignada</td>
              <td className="py-2 px-1 text-center font-bold text-[11px]">{it.quantity}</td>
              <td className="py-2 px-1 text-right">{it.line_net_amount != null ? formatMoney(it.line_net_amount) : 'Sin dato neto'}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Footer Block */}
      <div className="mt-6 pt-4 border-t border-black page-break-inside-avoid">
        <div className="grid grid-cols-[1fr_300px] gap-8">
          <div>
            <p className="font-bold mb-1 border-b border-black pb-1 inline-block">Notas de Bodega:</p>
            <p className="mt-1">Líneas de Producto: {items.length}</p>
            <p>Unidades Físicas: {card.total_quantity}</p>
            <div className="grid grid-cols-2 gap-12 mt-12 text-center max-w-[400px]">
               <div className="border-t border-black pt-1 font-bold">Preparado por</div>
               <div className="border-t border-black pt-1 font-bold">Revisado por</div>
            </div>
          </div>

          <div className="border border-black p-4 h-fit">
            <div className="grid grid-cols-2 gap-2 text-right">
               <span className="font-bold">NETO ($)</span>
               <span className="font-bold text-[11px]">{card.net_amount != null ? formatMoney(card.net_amount) : '—'}</span>
            </div>
            <div className="mt-8 text-[8px] text-gray-500 text-right">
              <p>Impreso el: {formatDate(printDate)} a las {formatTime(printDate)}</p>
              <p>Usuario: {printedBy}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
