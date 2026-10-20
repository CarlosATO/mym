export const AUDIT_INCIDENT_TYPES = [
  'QUANTITY_LOWER_THAN_PREPARED',
  'QUANTITY_GREATER_THAN_PREPARED',
  'WRONG_PRODUCT',
  'DAMAGED_PRODUCT',
  'PRODUCT_NOT_FOUND',
  'OTHER',
] as const

export type AuditIncidentType = typeof AUDIT_INCIDENT_TYPES[number]
export type AuditLineStatus = 'PENDING' | 'CONFIRMED' | 'INCIDENT'

export const AUDIT_PHYSICAL_INCIDENT_TYPES = [
  'WRONG_PRODUCT',
  'DAMAGED_PRODUCT',
  'PRODUCT_NOT_FOUND',
  'OTHER',
] as const

export type AuditPhysicalIncidentType = typeof AUDIT_PHYSICAL_INCIDENT_TYPES[number]

const PHOTO_REQUIRED_TYPES: ReadonlySet<AuditIncidentType> = new Set([
  'WRONG_PRODUCT',
  'DAMAGED_PRODUCT',
])

export function isAuditIncidentType(value: unknown): value is AuditIncidentType {
  return typeof value === 'string'
    && (AUDIT_INCIDENT_TYPES as readonly string[]).includes(value)
}

export function incidentRequiresPhoto(type: AuditIncidentType | null | undefined): boolean {
  return Boolean(type && PHOTO_REQUIRED_TYPES.has(type))
}

export function incidentRequiresObservation(type: AuditIncidentType | null | undefined): boolean {
  return type === 'OTHER'
}

export function isAuditLockError(message: string | null | undefined): boolean {
  if (!message) return false
  return /auditoría está asignada a otro usuario|aún no tiene responsable|tomar la auditoría de otro usuario|No puedes auditar una preparación realizada por ti/i.test(message)
}

export function deriveQuantityIncidentType(
  auditQuantity: number | null | undefined,
  preparedQuantity: number,
): AuditIncidentType | null {
  if (auditQuantity == null) return null
  if (auditQuantity < preparedQuantity) return 'QUANTITY_LOWER_THAN_PREPARED'
  if (auditQuantity > preparedQuantity) return 'QUANTITY_GREATER_THAN_PREPARED'
  return null
}

export type AuditIncidentResolution = {
  incidentType: AuditIncidentType | null
  observation: string | null
  error: string | null
}

export function resolveAuditIncident(input: {
  auditQuantity: number
  preparedQuantity: number
  incidentType?: AuditIncidentType | string | null
  observation?: string | null
}): AuditIncidentResolution {
  const observation = input.observation?.trim() || null
  if (!Number.isFinite(input.auditQuantity) || input.auditQuantity < 0) {
    return {
      incidentType: null,
      observation,
      error: 'La cantidad auditada debe ser mayor o igual a 0.',
    }
  }

  const rawType = typeof input.incidentType === 'string'
    ? input.incidentType.trim().toUpperCase()
    : ''
  if (rawType && !isAuditIncidentType(rawType)) {
    return { incidentType: null, observation, error: 'Tipo de incidencia de auditoría inválido.' }
  }

  const manualType = rawType ? (rawType as AuditIncidentType) : null

  if (manualType === 'PRODUCT_NOT_FOUND' && input.auditQuantity > 0) {
    return {
      incidentType: null,
      observation,
      error: 'PRODUCT_NOT_FOUND sólo es válido con cantidad auditada 0.',
    }
  }
  if (manualType === 'OTHER' && !observation) {
    return {
      incidentType: null,
      observation,
      error: 'La observación es obligatoria para la incidencia OTRO.',
    }
  }
  if (manualType === 'QUANTITY_LOWER_THAN_PREPARED'
      && input.auditQuantity >= input.preparedQuantity) {
    return {
      incidentType: null,
      observation,
      error: 'La incidencia de cantidad menor no coincide con las cantidades.',
    }
  }
  if (manualType === 'QUANTITY_GREATER_THAN_PREPARED'
      && input.auditQuantity <= input.preparedQuantity) {
    return {
      incidentType: null,
      observation,
      error: 'La incidencia de cantidad mayor no coincide con las cantidades.',
    }
  }

  return {
    incidentType: manualType ?? deriveQuantityIncidentType(input.auditQuantity, input.preparedQuantity),
    observation,
    error: null,
  }
}

export function deriveAuditLineStatus(
  auditQuantity: number | null | undefined,
  preparedQuantity: number,
  incidentType: AuditIncidentType | null | undefined = null,
): AuditLineStatus {
  if (auditQuantity == null) return 'PENDING'
  if (incidentType) return 'INCIDENT'
  return auditQuantity === preparedQuantity ? 'CONFIRMED' : 'INCIDENT'
}

export type AuditTakeInput = {
  actorUserId: string | null
  preparerUserId: string | null
  isSuperUsuario?: boolean
  lockedByUserId: string | null
  canManage: boolean
  canAuthorizeException: boolean
  reason?: string | null
}

export type AuditTakeDecision = {
  ok: boolean
  error: string | null
  event: 'AUDIT_LOCK_CLAIM' | 'AUDIT_LOCK_TAKEOVER' | 'AUDIT_LOCK_ALREADY_OWNED' | null
}

export function evaluateAuditTake(input: AuditTakeInput): AuditTakeDecision {
  if (!input.actorUserId) {
    return { ok: false, error: 'No autorizado', event: null }
  }
  if (input.preparerUserId
      && input.actorUserId === input.preparerUserId
      && !input.isSuperUsuario) {
    return { ok: false, error: 'No puedes auditar una preparación realizada por ti.', event: null }
  }
  if (!input.canManage) {
    return { ok: false, error: 'No tienes permiso para tomar esta auditoría.', event: null }
  }
  if (input.lockedByUserId === input.actorUserId) {
    return { ok: true, error: null, event: 'AUDIT_LOCK_ALREADY_OWNED' }
  }
  if (input.lockedByUserId) {
    if (!input.canAuthorizeException) {
      return { ok: false, error: 'Esta auditoría está siendo realizada por otro usuario.', event: null }
    }
    if (!input.reason?.trim()) {
      return {
        ok: false,
        error: 'El motivo es obligatorio para tomar la auditoría de otro usuario.',
        event: null,
      }
    }
    return { ok: true, error: null, event: 'AUDIT_LOCK_TAKEOVER' }
  }
  return { ok: true, error: null, event: 'AUDIT_LOCK_CLAIM' }
}

export type AuditPreCloseBlockerCode =
  | 'AUDIT_NOT_FOUND'
  | 'AUDIT_NOT_OPEN'
  | 'CARD_NOT_IN_AUDIT'
  | 'LINES_PENDING'
  | 'OPEN_INCIDENTS'
  | 'PACKAGE_COUNT_REQUIRED'
  | 'MISSING_REQUIRED_EVIDENCE'

export type AuditPreCloseBlocker = {
  code: AuditPreCloseBlockerCode
  message: string
  count?: number
}

export type AuditPreCloseInput = {
  auditStatus?: 'OPEN' | 'CLOSED' | string | null
  cardStatus?: string | null
  lines: Array<{ line_status: AuditLineStatus | string }>
  incidents: Array<{
    status: 'OPEN' | 'RESOLVED' | 'SUPERSEDED' | string
    incident_type: AuditIncidentType | string
    evidence_count: number
  }>
  packageCount: number | null | undefined
}

export type AuditPreCloseResult = {
  canFinalize: boolean
  blockers: AuditPreCloseBlocker[]
}

export function validateAuditPreClose(input: AuditPreCloseInput): AuditPreCloseResult {
  const blockers: AuditPreCloseBlocker[] = []

  if (input.auditStatus != null && input.auditStatus !== 'OPEN') {
    blockers.push({ code: 'AUDIT_NOT_OPEN', message: 'La sesión de auditoría no está abierta.' })
  }
  if (input.cardStatus != null && input.cardStatus !== 'IN_AUDIT') {
    blockers.push({ code: 'CARD_NOT_IN_AUDIT', message: 'La tarjeta ya no está En auditoría.' })
  }

  const pending = input.lines.filter(line => line.line_status === 'PENDING').length
  if (pending > 0) {
    blockers.push({
      code: 'LINES_PENDING',
      message: `Faltan ${pending} líneas por auditar.`,
      count: pending,
    })
  }

  const openIncidents = input.incidents.filter(incident => incident.status === 'OPEN')
  if (openIncidents.length > 0) {
    blockers.push({
      code: 'OPEN_INCIDENTS',
      message: `Existen ${openIncidents.length} incidencias de auditoría abiertas.`,
      count: openIncidents.length,
    })
  }

  if (input.packageCount == null || input.packageCount < 1) {
    blockers.push({
      code: 'PACKAGE_COUNT_REQUIRED',
      message: 'La cantidad de bultos es obligatoria para finalizar Auditoría.',
    })
  }

  const missingEvidence = openIncidents.filter(incident => (
    incidentRequiresPhoto(incident.incident_type as AuditIncidentType)
    && incident.evidence_count < 1
  )).length
  if (missingEvidence > 0) {
    blockers.push({
      code: 'MISSING_REQUIRED_EVIDENCE',
      message: `Faltan fotografías obligatorias en ${missingEvidence} incidencias.`,
      count: missingEvidence,
    })
  }

  return { canFinalize: blockers.length === 0, blockers }
}
