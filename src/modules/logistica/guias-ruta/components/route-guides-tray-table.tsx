import { RouteGuideStatusBadge } from './route-guide-badges';
import { formatCurrency, formatDate } from '../utils/route-guide-formatters';
import { Trash2 } from 'lucide-react';

interface RouteGuidesTrayTableProps {
  guides: any[];
  onSelectGuide: (id: string) => void;
  onDeleteGuide: (id: string, guideNumber: string) => void;
}

export function RouteGuidesTrayTable({ guides, onSelectGuide, onDeleteGuide }: RouteGuidesTrayTableProps) {
  if (guides.length === 0) {
    return (
      <div className="bg-theme-surface border border-theme-border rounded-2xl p-12 text-center shadow-sm">
        <p className="text-theme-text-muted mb-2">No se encontraron guías de ruta</p>
        <p className="text-sm text-theme-text-muted/70">Crea una nueva guía para comenzar.</p>
      </div>
    );
  }

  return (
    <div className="rounded-2xl border border-theme-border bg-theme-surface shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm text-left border-collapse">
          <thead className="sticky top-0 z-10 bg-theme-surface border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
            <tr>
              <th className="px-6 py-4 font-medium">N° Guía</th>
              <th className="px-6 py-4 font-medium">Fecha</th>
              <th className="px-6 py-4 font-medium">Ruta / Vehículo</th>
              <th className="px-6 py-4 font-medium">Conductor</th>
              <th className="px-6 py-4 font-medium text-right">Facturas</th>
              <th className="px-6 py-4 font-medium text-right">Monto Total</th>
              <th className="px-4 py-3 font-medium text-center">Estado</th>
              <th className="px-4 py-3 font-medium text-center w-12"></th>
            </tr>
          </thead>
          <tbody>
            {guides.map(guide => (
              <tr 
                key={guide.id} 
                onClick={() => onSelectGuide(guide.id)}
                className="border-b border-theme-border transition-colors hover:bg-theme-text/5 cursor-pointer text-xs"
              >
                <td className="py-3 px-4 font-mono font-semibold text-theme-accent whitespace-nowrap">
                  {guide.guide_number}
                </td>
                <td className="py-3 px-4 font-medium text-theme-text whitespace-nowrap">
                  {formatDate(guide.guide_date)}
                </td>
                <td className="py-3 px-4">
                  <p className="text-theme-text">{guide.route_name_snapshot}</p>
                  <p className="text-theme-text-muted/70 text-xs">{guide.vehicle_name_snapshot}</p>
                </td>
                <td className="py-3 px-4 text-theme-text">
                  {guide.driver_name_snapshot}
                </td>
                <td className="py-3 px-4 text-right text-theme-text">
                  {guide.total_invoices}
                </td>
                <td className="py-3 px-4 text-right font-medium text-theme-text">
                  {formatCurrency(guide.total_amount)}
                </td>
                <td className="py-3 px-4 text-center">
                  <RouteGuideStatusBadge status={guide.status} />
                  {(guide.error_count > 0 || guide.duplicate_count > 0) && guide.status === 'DRAFT' && (
                    <div className="text-[9px] text-red-500 mt-1 font-bold">Con errores</div>
                  )}
                </td>
                <td className="py-3 px-4 text-center">
                  {guide.status === 'DRAFT' && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteGuide(guide.id, guide.guide_number);
                      }}
                      className="p-2 text-theme-text-muted hover:text-red-500 rounded-lg hover:bg-red-500/10 transition-colors"
                      title="Eliminar borrador"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
