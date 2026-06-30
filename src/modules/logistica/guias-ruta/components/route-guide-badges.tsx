import { RouteGuideStatus, PaymentMethodNormalized } from '../types';

export function RouteGuideStatusBadge({ status }: { status: RouteGuideStatus }) {
  let color = 'bg-theme-surface border-theme-border text-theme-text-muted';
  let label: string = status;

  switch (status) {
    case 'DRAFT':
      color = 'bg-yellow-500/10 text-yellow-600 border-yellow-500/20';
      label = 'Borrador';
      break;
    case 'DISPATCHED':
      color = 'bg-blue-500/10 text-blue-600 border-blue-500/20';
      label = 'Despachada';
      break;
    case 'CANCELLED':
      color = 'bg-red-500/10 text-red-600 border-red-500/20';
      label = 'Anulada';
      break;
  }

  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${color}`}>
      {label}
    </span>
  );
}

export function PaymentMethodBadge({ method }: { method: PaymentMethodNormalized }) {
  let color = 'bg-theme-surface border-theme-border text-theme-text-muted';
  let label: string = method;

  switch (method) {
    case 'CASH':
      color = 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20';
      label = 'Efectivo';
      break;
    case 'CHECK':
      color = 'bg-blue-500/10 text-blue-500 border-blue-500/20';
      label = 'Cheque';
      break;
    case 'TRANSFER':
      color = 'bg-purple-500/10 text-purple-500 border-purple-500/20';
      label = 'Transferencia';
      break;
    case 'CREDIT':
      color = 'bg-orange-500/10 text-orange-500 border-orange-500/20';
      label = 'Crédito';
      break;
    case 'UNKNOWN':
      color = 'bg-red-500/10 text-red-500 border-red-500/20 font-bold';
      label = 'No Reconocido';
      break;
  }

  return (
    <span className={`inline-flex px-2 py-0.5 rounded text-[10px] font-semibold border ${color}`}>
      {label}
    </span>
  );
}
