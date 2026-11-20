import type { SalesOrderPreparationLine } from '@/app/actions/logistica/sales-order-preparation'
import type { PreparationDetectorStatus } from '@/lib/logistica/preparation-commercial-detector'

export const PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE =
  'Preparación con incidencias. La nota permanecerá En preparación mientras se regularizan las diferencias en Bsale. Puedes continuar preparando los demás productos. Una vez reconciliados todos los cambios y confirmadas las líneas, se habilitará el envío a Auditoría.'

export const PREPARATION_COMMERCIAL_CHANGE_AUDIT_BLOCK_MESSAGE =
  'La Nota de Venta fue modificada en Bsale y todavía tiene cambios comerciales sin aceptar. Acepta y reconcilia los cambios antes de enviar a Auditoría.'

export const PREPARATION_COMMERCIAL_UNAVAILABLE_AUDIT_BLOCK_MESSAGE =
  'No se pudo verificar la vigencia comercial en Bsale. La nota permanecerá En preparación hasta confirmar que no existen cambios pendientes.'

export type PreparationAuditBlockReason =
  | 'NO_LINES'
  | 'PENDING_LINES'
  | 'INCIDENT_LINES'
  | 'OPEN_INCIDENTS'
  | 'COMMERCIAL_CHANGE_UNACCEPTED'
  | 'COMMERCIAL_UNVERIFIED'

export type PreparationAuditEligibility = {
  canSendToAudit: boolean
  reason: PreparationAuditBlockReason | null
  message: string | null
  pendingCount: number
  incidentCount: number
  openCommercialIncidentCount: number
}

export function isPreparationLinePending(line: SalesOrderPreparationLine): boolean {
  return line.prepared_quantity === null || line.line_status === 'PENDING'
}

export function isPreparationLineWithIncident(line: SalesOrderPreparationLine): boolean {
  if (isPreparationLinePending(line)) return false
  if (
    Boolean(line.excluded_from_dispatch)
    || line.prepared_quantity === null
    || line.prepared_quantity <= 0
    || line.prepared_quantity !== line.requested_quantity
  ) {
    return true
  }
  // Tras aceptar una reducción parcial comercial (20261104140000), la línea
  // reconciliada conserva line_status = 'INCIDENT' pero con requested_quantity
  // igualado a prepared_quantity > 0 y sin incidencias OPEN.
  return line.line_status !== 'CONFIRMED' && line.line_status !== 'INCIDENT'
}

export function getPreparationLineValidation(lines: SalesOrderPreparationLine[]) {
  return {
    pendingLines: lines.filter(isPreparationLinePending),
    incidentLines: lines.filter(isPreparationLineWithIncident),
  }
}

export function evaluatePreparationAuditEligibility(params: {
  lines: SalesOrderPreparationLine[]
  openCommercialIncidentCount?: number
  commercialAlertStatus?: PreparationDetectorStatus | null
}): PreparationAuditEligibility {
  const { pendingLines, incidentLines } = getPreparationLineValidation(params.lines)
  const openCommercialIncidentCount = Math.max(0, Number(params.openCommercialIncidentCount ?? 0))

  if (params.lines.length === 0) {
    return {
      canSendToAudit: false,
      reason: 'NO_LINES',
      message: 'La Nota de Venta no tiene líneas activas confirmadas para enviar a Auditoría.',
      pendingCount: 0,
      incidentCount: 0,
      openCommercialIncidentCount,
    }
  }

  if (pendingLines.length > 0) {
    return {
      canSendToAudit: false,
      reason: 'PENDING_LINES',
      message: `Faltan ${pendingLines.length} producto${pendingLines.length === 1 ? '' : 's'} por confirmar.`,
      pendingCount: pendingLines.length,
      incidentCount: incidentLines.length,
      openCommercialIncidentCount,
    }
  }

  if (incidentLines.length > 0) {
    return {
      canSendToAudit: false,
      reason: 'INCIDENT_LINES',
      message: PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE,
      pendingCount: 0,
      incidentCount: incidentLines.length,
      openCommercialIncidentCount,
    }
  }

  if (openCommercialIncidentCount > 0) {
    return {
      canSendToAudit: false,
      reason: 'OPEN_INCIDENTS',
      message: PREPARATION_INCIDENTS_AUDIT_BLOCK_MESSAGE,
      pendingCount: 0,
      incidentCount: 0,
      openCommercialIncidentCount,
    }
  }

  if (params.commercialAlertStatus === 'CHANGED') {
    return {
      canSendToAudit: false,
      reason: 'COMMERCIAL_CHANGE_UNACCEPTED',
      message: PREPARATION_COMMERCIAL_CHANGE_AUDIT_BLOCK_MESSAGE,
      pendingCount: 0,
      incidentCount: 0,
      openCommercialIncidentCount: 0,
    }
  }

  if (
    params.commercialAlertStatus === 'UNAVAILABLE'
    || params.commercialAlertStatus === 'AMBIGUOUS'
    || params.commercialAlertStatus === 'INCOMPLETE'
  ) {
    return {
      canSendToAudit: false,
      reason: 'COMMERCIAL_UNVERIFIED',
      message: PREPARATION_COMMERCIAL_UNAVAILABLE_AUDIT_BLOCK_MESSAGE,
      pendingCount: 0,
      incidentCount: 0,
      openCommercialIncidentCount: 0,
    }
  }

  return {
    canSendToAudit: true,
    reason: null,
    message: null,
    pendingCount: 0,
    incidentCount: 0,
    openCommercialIncidentCount: 0,
  }
}

export function isPreparationCardBlockedForSync(params: {
  cardStatus: string
  openCommercialIncidentCount?: number
  commercialAlertStatus?: PreparationDetectorStatus | null
  lines?: SalesOrderPreparationLine[]
}): boolean {
  if (params.cardStatus !== 'IN_PREPARATION') return false
  if (Math.max(0, Number(params.openCommercialIncidentCount ?? 0)) > 0) return true
  if (
    params.commercialAlertStatus === 'CHANGED'
    || params.commercialAlertStatus === 'UNAVAILABLE'
    || params.commercialAlertStatus === 'AMBIGUOUS'
    || params.commercialAlertStatus === 'INCOMPLETE'
  ) {
    return true
  }
  if (Array.isArray(params.lines) && params.lines.length > 0) {
    return params.lines.some(isPreparationLineWithIncident)
  }
  return false
}

export type PostSyncAuditTransitionDecision = {
  shouldAdvanceToAudit: boolean
  reason: PreparationAuditBlockReason | 'INVALID_CARD_STATUS' | null
  message: string | null
}

export function evaluatePostSyncAuditTransition(params: {
  cardStatus: string
  lines: SalesOrderPreparationLine[]
  openCommercialIncidentCount: number
  commercialAlertStatus: PreparationDetectorStatus | null | undefined
  commercialVerificationSource: 'LIVE_BSALE' | 'CACHE' | 'NONE' | null | undefined
  commercialDetail?: string | null
}): PostSyncAuditTransitionDecision {
  if (params.cardStatus !== 'IN_PREPARATION') {
    return {
      shouldAdvanceToAudit: false,
      reason: 'INVALID_CARD_STATUS',
      message: 'La tarjeta ya no se encuentra En preparación y no puede avanzar automáticamente.',
    }
  }

  const eligibility = evaluatePreparationAuditEligibility({
    lines: params.lines,
    openCommercialIncidentCount: params.openCommercialIncidentCount,
    commercialAlertStatus: params.commercialAlertStatus ?? null,
  })

  if (!eligibility.canSendToAudit) {
    return {
      shouldAdvanceToAudit: false,
      reason: eligibility.reason,
      message: eligibility.message,
    }
  }

  if (params.commercialAlertStatus !== 'UNCHANGED' || params.commercialVerificationSource !== 'LIVE_BSALE') {
    return {
      shouldAdvanceToAudit: false,
      reason: 'COMMERCIAL_UNVERIFIED',
      message: params.commercialDetail || PREPARATION_COMMERCIAL_UNAVAILABLE_AUDIT_BLOCK_MESSAGE,
    }
  }

  return {
    shouldAdvanceToAudit: true,
    reason: null,
    message: null,
  }
}
