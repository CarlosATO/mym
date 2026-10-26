import type { SalesOrderPreparationLine } from '@/app/actions/logistica/sales-order-preparation'

export function getPreparationLineValidation(lines: SalesOrderPreparationLine[]) {
  return {
    pendingLines: lines.filter(line => line.prepared_quantity === null || line.line_status === 'PENDING'),
    incidentLines: lines.filter(line => line.line_status === 'INCIDENT'),
  }
}
