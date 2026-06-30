import { RouteGuide } from '../types';
import { formatCurrency, formatDate } from '../utils/route-guide-formatters';
import { CompanyLogo } from '@/components/company-logo';

interface RouteGuidePrintViewProps {
  guide: RouteGuide;
}

export function RouteGuidePrintView({ guide }: RouteGuidePrintViewProps) {
  // Solo imprimir las que tienen datos
  const validItems = guide.items?.filter(i => i.invoice_number || i.customer_name || i.amount) || [];

  return (
    <div className="bg-white p-8 print:p-0 text-sm max-w-[800px] mx-auto text-black print-document">
      
      {/* Cabecera */}
      {guide.status === 'DRAFT' && !guide.id && (
        <div className="text-center mb-8 border-2 border-dashed border-gray-400 p-4 font-bold text-xl text-gray-500">
          BORRADOR NO GUARDADO
          <div className="text-sm font-normal mt-1">El número de guía se generará al guardar</div>
        </div>
      )}
      
      <div className="flex justify-between items-start border-b-2 border-black pb-4 mb-6">
        <div>
          <CompanyLogo className="h-12 w-auto mb-2 grayscale" />
          <h1 className="text-2xl font-bold uppercase">
            {guide.status === 'DISPATCHED' ? 'Guía Despachada' : 'Guía de Ruta'}
            {guide.status === 'DRAFT' && guide.id && ' (BORRADOR)'}
          </h1>
        </div>
        <div className="text-right">
          <p className="text-lg font-bold">N° {guide.guide_number || '---'}</p>
          <p>Fecha: {formatDate(guide.guide_date)}</p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-x-8 gap-y-4 mb-8">
        <div>
          <p className="font-semibold text-gray-600 uppercase text-xs">Ruta</p>
          <p className="border-b border-gray-300 pb-1">{guide.route_name_snapshot}</p>
        </div>
        <div>
          <p className="font-semibold text-gray-600 uppercase text-xs">Vehículo</p>
          <p className="border-b border-gray-300 pb-1">{guide.vehicle_name_snapshot}</p>
        </div>
        <div>
          <p className="font-semibold text-gray-600 uppercase text-xs">Vendedor</p>
          <p className="border-b border-gray-300 pb-1">{guide.seller_name_snapshot || '-'}</p>
        </div>
        <div>
          <p className="font-semibold text-gray-600 uppercase text-xs">Conductor</p>
          <p className="border-b border-gray-300 pb-1">{guide.driver_name_snapshot || '-'}</p>
        </div>
        <div>
          <p className="font-semibold text-gray-600 uppercase text-xs">Despachador / Armador</p>
          <p className="border-b border-gray-300 pb-1">{guide.dispatcher_name_snapshot || '-'}</p>
        </div>
        
        {guide.notes && (
          <div className="col-span-2 mt-2">
            <p className="font-semibold text-gray-600 uppercase text-xs">Observaciones Generales</p>
            <p className="border-b border-gray-300 pb-1 italic">{guide.notes}</p>
          </div>
        )}
      </div>

      {/* Tabla Detalle */}
      <table className="w-full text-left mb-8 border-collapse">
        <thead>
          <tr className="border-y-2 border-black">
            <th className="py-2 px-1 text-center w-8">#</th>
            <th className="py-2 px-1 w-24">Factura</th>
            <th className="py-2 px-1">Cliente</th>
            <th className="py-2 px-1 w-32">Comuna</th>
            <th className="py-2 px-1 w-28 text-right">Monto</th>
            <th className="py-2 px-1 w-32 text-center">Forma Pago</th>
            <th className="py-2 px-1">Obs.</th>
          </tr>
        </thead>
        <tbody>
          {validItems.map((item, idx) => (
            <tr key={idx} className="border-b border-gray-200">
              <td className="py-1 px-1 text-center text-gray-500">{item.line_number}</td>
              <td className="py-1 px-1 font-medium">{item.invoice_number}</td>
              <td className="py-1 px-1 text-xs truncate max-w-[200px]">{item.customer_name}</td>
              <td className="py-1 px-1 text-xs">{item.commune}</td>
              <td className="py-1 px-1 text-right">{formatCurrency(item.amount)}</td>
              <td className="py-1 px-1 text-center text-xs uppercase">{item.payment_method_normalized === 'UNKNOWN' ? item.payment_method_original : item.payment_method_normalized}</td>
              <td className="py-1 px-1 text-xs truncate max-w-[150px]">{item.notes}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Resumen Totales */}
      <div className="flex justify-end mb-16">
        <div className="w-64 border border-black p-4 rounded-sm">
          <p className="font-bold text-center border-b border-black pb-2 mb-2 uppercase">Resumen Rendición</p>
          <div className="flex justify-between py-1">
            <span>Efectivo:</span>
            <span className="font-bold">{formatCurrency(guide.total_cash_expected)}</span>
          </div>
          <div className="flex justify-between py-1">
            <span>Cheque:</span>
            <span className="font-bold">{formatCurrency(guide.total_check_expected)}</span>
          </div>
          <div className="flex justify-between py-1 border-t border-dashed border-gray-400 mt-1">
            <span className="font-bold">Total a Rendir:</span>
            <span className="font-bold">{formatCurrency(guide.total_cash_expected + guide.total_check_expected)}</span>
          </div>
          
          <div className="mt-4 pt-2 border-t border-black text-xs text-gray-600">
            <div className="flex justify-between py-0.5"><span>Crédito:</span><span>{formatCurrency(guide.total_credit)}</span></div>
            <div className="flex justify-between py-0.5"><span>Transf.:</span><span>{formatCurrency(guide.total_transfer)}</span></div>
            <div className="flex justify-between py-0.5 font-bold border-t mt-1 pt-1">
              <span>Total Ruta:</span><span>{formatCurrency(guide.total_amount)}</span>
            </div>
            <div className="text-center mt-2 pt-2 border-t">
              Total Facturas: <span className="font-bold">{guide.total_invoices}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Firmas */}
      <div className="grid grid-cols-3 gap-8 mt-16 text-center text-xs pt-16">
        <div>
          <div className="border-t border-black mx-4 pt-2">Firma Despachador</div>
          <div className="mt-1">{guide.dispatcher_name_snapshot}</div>
        </div>
        <div>
          <div className="border-t border-black mx-4 pt-2">Firma Chofer/Vendedor</div>
          <div className="mt-1">{guide.driver_name_snapshot}</div>
        </div>
        <div>
          <div className="border-t border-black mx-4 pt-2">Firma Rendición / Caja</div>
        </div>
      </div>

      {/* Footer Info */}
      <div className="mt-16 text-center text-[10px] text-gray-500 border-t pt-4">
        Generado en MYM ERP • Guía N° {guide.guide_number || '---'} • Impreso: {new Date().toLocaleString('es-CL')}
      </div>
    </div>
  );
}
