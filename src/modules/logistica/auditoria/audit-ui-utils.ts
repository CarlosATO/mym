import type {
  SalesOrderAuditAttachment,
  SalesOrderAuditDetail,
  SalesOrderAuditFinalizationBlocker,
  SalesOrderAuditIncident,
  SalesOrderAuditLine,
} from '@/app/actions/logistica/sales-order-audit'
import type { AuditIncidentType } from './audit-policy'

export const AUDIT_EVIDENCE_BUCKET = 'audit-evidence'
export const AUDIT_EVIDENCE_MAX_BYTES = 10 * 1024 * 1024
export const AUDIT_EVIDENCE_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
] as const
export const AUDIT_EVIDENCE_ACCEPT = '.jpg,.jpeg,.png,.webp,.heic,image/jpeg,image/png,image/webp,image/heic'

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
}

const MIME_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
}

export const AUDIT_INCIDENT_LABELS: Record<AuditIncidentType, string> = {
  QUANTITY_LOWER_THAN_PREPARED: 'Cantidad menor a la preparada',
  QUANTITY_GREATER_THAN_PREPARED: 'Cantidad mayor a la preparada',
  WRONG_PRODUCT: 'Producto incorrecto',
  DAMAGED_PRODUCT: 'Producto dañado',
  PRODUCT_NOT_FOUND: 'Producto no encontrado',
  OTHER: 'Otro',
}

export const AUDIT_MANUAL_INCIDENT_OPTIONS: Array<{ value: AuditIncidentType; label: string }> = [
  { value: 'WRONG_PRODUCT', label: 'Producto incorrecto' },
  { value: 'DAMAGED_PRODUCT', label: 'Producto dañado' },
  { value: 'PRODUCT_NOT_FOUND', label: 'Producto no encontrado' },
  { value: 'OTHER', label: 'Otro' },
]

export function resolveAuditEvidenceMime(fileMimeType: string | null | undefined, fileName: string): string | null {
  if (fileMimeType && (AUDIT_EVIDENCE_MIME_TYPES as readonly string[]).includes(fileMimeType)) {
    return fileMimeType
  }
  const extension = fileName.split('.').pop()?.toLowerCase() ?? ''
  return MIME_BY_EXTENSION[extension] ?? null
}

export function auditEvidenceExtension(mimeType: string): string | null {
  return EXTENSION_BY_MIME[mimeType] ?? null
}

export function validateAuditEvidenceFile(file: File): { ok: boolean; mimeType?: string; error?: string } {
  const mimeType = resolveAuditEvidenceMime(file.type, file.name)
  if (!mimeType) return { ok: false, error: 'La fotografía debe ser JPEG, PNG, WEBP o HEIC.' }
  if (!Number.isInteger(file.size) || file.size <= 0 || file.size > AUDIT_EVIDENCE_MAX_BYTES) {
    return { ok: false, error: 'La fotografía debe pesar entre 1 byte y 10 MB.' }
  }
  return { ok: true, mimeType }
}

export function formatAuditQuantity(value: number | null | undefined): string {
  if (value == null) return '—'
  return String(value)
}

export function formatPreparedTotal(hasSnapshot: boolean, total: number): string {
  return hasSnapshot ? String(total) : '—'
}

export function formatAuditedTotal(hasSnapshot: boolean, hasAnyAudited: boolean, total: number): string {
  return hasSnapshot && hasAnyAudited ? String(total) : '—'
}

export function formatSnapshotLines(hasSnapshot: boolean, auditedLines: number, totalLines: number): string {
  return hasSnapshot ? `${auditedLines} / ${totalLines}` : '—'
}

export function getAuditOpenIncident(incidents: SalesOrderAuditIncident[], lineId: string): SalesOrderAuditIncident | null {
  return incidents.find(incident => incident.audit_line_id === lineId && incident.status === 'OPEN') ?? null
}

export function getAuditLineResultLabel(
  line: SalesOrderAuditLine,
  openIncident: SalesOrderAuditIncident | null,
): string {
  if (line.line_status === 'PENDING') return 'Pendiente'
  if (line.line_status === 'CONFIRMED') {
    return line.requested_quantity_snapshot !== line.prepared_quantity_snapshot
      ? 'Conforme con preparación'
      : 'Conforme'
  }
  if (openIncident) return AUDIT_INCIDENT_LABELS[openIncident.incident_type]
  return 'Incidencia'
}

export function getAuditLineResultTone(line: SalesOrderAuditLine): 'pending' | 'ok' | 'incident' {
  if (line.line_status === 'PENDING') return 'pending'
  return line.line_status === 'CONFIRMED' ? 'ok' : 'incident'
}

export function summarizeAuditDetail(detail: SalesOrderAuditDetail | null): {
  totalLines: number
  auditedLines: number
  conformingLines: number
  incidentLines: number
  openIncidents: number
  requested: number
  prepared: number
  audited: number
} {
  const lines = detail?.lines ?? []
  const incidents = detail?.incidents ?? []
  const auditedLines = lines.filter(line => line.audit_quantity != null).length
  return {
    totalLines: lines.length,
    auditedLines,
    conformingLines: lines.filter(line => line.line_status === 'CONFIRMED').length,
    incidentLines: lines.filter(line => line.line_status === 'INCIDENT').length,
    openIncidents: incidents.filter(incident => incident.status === 'OPEN').length,
    requested: lines.reduce((total, line) => total + Number(line.requested_quantity_snapshot), 0),
    prepared: lines.reduce((total, line) => total + Number(line.prepared_quantity_snapshot), 0),
    audited: lines.reduce((total, line) => total + Number(line.audit_quantity ?? 0), 0),
  }
}

export function auditBlockerMessages(blockers: SalesOrderAuditFinalizationBlocker[]): string[] {
  return blockers.map(blocker => {
    switch (blocker.code) {
      case 'LINES_PENDING':
        return `Faltan ${blocker.count ?? 0} productos por auditar.`
      case 'OPEN_INCIDENTS':
        return 'Existen incidencias pendientes de resolver.'
      case 'PACKAGE_COUNT_REQUIRED':
        return 'Debes informar la cantidad final de bultos.'
      case 'MISSING_REQUIRED_EVIDENCE':
        return 'Falta evidencia fotográfica obligatoria.'
      case 'AUDIT_NOT_OPEN':
        return 'La sesión de auditoría no está abierta.'
      case 'CARD_NOT_IN_AUDIT':
        return 'La Nota de Venta ya no está En auditoría.'
      case 'AUDIT_NOT_FOUND':
        return 'No se encontró la sesión de auditoría.'
      default:
        return blocker.message || 'Existe un requisito pendiente para cerrar la Auditoría.'
    }
  })
}

export function isAuditGlobalPhoto(attachment: SalesOrderAuditAttachment): boolean {
  return attachment.attachment_type === 'GLOBAL_DISPATCH_PHOTO'
}
