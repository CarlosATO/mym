export function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('es-CL', {
    style: 'currency',
    currency: 'CLP',
  }).format(amount)
}

export function formatDate(dateString: string): string {
  return formatCivilDate(dateString, 'short') || '-'
}

export { formatInstantInSantiago }

export function formatExpectedPaymentMethod(method: string): string {
  switch (method) {
    case 'AL_DIA': return 'Al día'
    case 'CREDIT': return 'Crédito'
    case 'CASH': return 'Efectivo'
    case 'CHECK': return 'Cheque'
    case 'TRANSFER': return 'Transferencia'
    case 'UNKNOWN': return 'No reconocido'
    default: return method
  }
}

export function formatSettlementItemStatus(status: string): string {
  switch (status) {
    case 'PENDING_PAYMENT': return 'Pendiente'
    case 'PAID_CASH': return 'Pagado efectivo'
    case 'TRANSFER_CONFIRMED': return 'Transf. confirmada'
    case 'TRANSFER_PENDING': return 'Transf. pendiente'
    case 'CHECK_RECEIVED': return 'Cheque recibido'
    case 'CREDIT_REGISTERED': return 'Crédito pendiente'
    case 'PARTIAL_PAYMENT': return 'Pago parcial'
    case 'DIFFERENCE': return 'Diferencia'
    case 'NOT_DELIVERED': return 'No entregada'
    case 'REVIEW_REQUIRED': return 'Requiere revisión'
    default: return status
  }
}

export function formatSettlementStatus(status: string): string {
  switch (status) {
    case 'IN_REVIEW': return 'En revisión'
    case 'SETTLED': return 'Rendida'
    case 'SETTLED_WITH_DIFFERENCE': return 'Con diferencias'
    case 'CLOSED': return 'Cerrada'
    case 'CANCELLED': return 'Anulada'
    default: return status
  }
}
import { formatCivilDate, formatInstantInSantiago } from '@/lib/datetime'
