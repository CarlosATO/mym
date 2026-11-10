import {
  fingerprintCommercialVersion,
  type CommercialComparisonResult,
  type CommercialLineDifference,
  type PreparationCommercialIdentity,
  type PreparationCommercialLineInput,
  type PreparationCommercialVersion,
// @ts-expect-error The local strip-types test runner resolves the source extension directly.
} from './preparation-commercial-version.ts'

export type PreparationReconciliationLine = {
  id: string
  company_id?: string | null
  card_id?: string | null
  bsale_detail_id: number
  bsale_variant_id: number | null
  sku: string | null
  product_name: string
  requested_quantity: number
  prepared_quantity: number | null
  line_status: 'PENDING' | 'CONFIRMED' | 'INCIDENT' | string
  excluded_from_dispatch: boolean
  retired_at?: string | null
}

export const PREPARATION_RECONCILIATION_INCIDENT_SELECT =
  'id, company_id, card_id, preparation_line_id, status, incident_type, required_bsale_action, requested_quantity, prepared_quantity, expected_bsale_quantity, verification_status, bsale_observed_quantity, bsale_variant_id, sku, bsale_observed_snapshot' as const

export type PreparationReconciliationIncident = {
  id: string
  company_id: string | null
  card_id: string | null
  preparation_line_id: string
  status: 'OPEN' | 'RESOLVED' | 'SUPERSEDED' | string
  incident_type: 'QUANTITY_REDUCTION' | 'LINE_EXCLUDED' | string | null
  required_bsale_action: 'SET_QUANTITY' | 'REMOVE_LINE' | string | null
  requested_quantity: number | string | null
  prepared_quantity: number | string | null
  expected_bsale_quantity: number | string | null
  verification_status: 'MATCHED' | 'MISMATCHED' | 'NOT_FOUND' | 'NV_CANCELLED' | 'ERROR' | string | null
  bsale_observed_quantity: number | string | null
  bsale_variant_id: number | string | null
  sku: string | null
  bsale_observed_snapshot: Record<string, unknown> | null
}

export type PreparationCommercialReconciliationCard = {
  cardId: string
  companyId: string
  status: string
}

export type PreparationCommercialReconciliationActionKind =
  | 'KEEP'
  | 'ADD'
  | 'REMOVE'
  | 'UPDATE_QUANTITY'
  | 'CONFLICT'

export type PreparationCommercialReconciliationConflictReason =
  | 'IDENTITY_NOT_VERIFIED'
  | 'SNAPSHOT_INCOMPLETE'
  | 'CURRENT_VERSION_CHANGED'
  | 'COMPARISON_AMBIGUOUS'
  | 'PREPARATION_LINE_NOT_FOUND'
  | 'PREPARATION_LINE_AMBIGUOUS'
  | 'PREPARATION_WORK_EXISTS'
  | 'PREPARATION_LINE_EXCLUDED'
  | 'OPERATIONAL_INCIDENT_EXISTS'
  | 'REMOVAL_WOULD_DISCARD_WORK'
  | 'QUANTITY_BELOW_PREPARED'
  | 'COMMERCIAL_VALUE_CHANGED'
  | 'COMMERCIAL_SUBSTITUTION'
  | 'UNKEYED_COMMERCIAL_LINE'

export type PreparationCommercialReconciliationConflict = {
  reason: PreparationCommercialReconciliationConflictReason
  message: string
  preparationLineId: string | null
  previous: PreparationCommercialLineInput | null
  current: PreparationCommercialLineInput | null
  incidentIds: string[]
}

export type PreparationCommercialReconciliationAction = {
  kind: PreparationCommercialReconciliationActionKind
  preparationLineId: string | null
  previous: PreparationCommercialLineInput | null
  current: PreparationCommercialLineInput | null
  previousRequestedQuantity: number | null
  newRequestedQuantity: number | null
  preparedQuantity: number | null
  quantityDelta: number | null
  incidentIds: string[]
  conflict: PreparationCommercialReconciliationConflict | null
}

export type PreparationCommercialReconciliationPlanStatus = 'READY' | 'REQUIRES_RESOLUTION' | 'UNAVAILABLE' | 'AMBIGUOUS' | 'NOT_APPLICABLE'

export type PreparationCommercialReconciliationPlan = {
  status: PreparationCommercialReconciliationPlanStatus
  canAcceptCompletely: boolean
  card: PreparationCommercialReconciliationCard
  identity: PreparationCommercialIdentity | null
  acceptedFingerprint: string | null
  currentFingerprint: string | null
  currentPhysicalId: number | null
  differences: CommercialLineDifference[]
  actions: PreparationCommercialReconciliationAction[]
  conflicts: PreparationCommercialReconciliationConflict[]
  impact: {
    added: number
    removed: number
    quantityUpdates: number
    conflicts: number
    totalDelta: number | null
  }
}

export type BuildPreparationCommercialReconciliationPlanInput = {
  card: PreparationCommercialReconciliationCard
  identity: PreparationCommercialIdentity | null
  acceptedVersion: PreparationCommercialVersion | null
  currentVersion: PreparationCommercialVersion | null
  preparationLines: PreparationReconciliationLine[]
  incidents: PreparationReconciliationIncident[]
  comparison: CommercialComparisonResult | null
  snapshotComplete?: boolean
}

type LineRef = PreparationCommercialLineInput | null

const COMMERCIAL_VALUE_FIELDS = new Set(['unitNetValue', 'lineNetAmount', 'lineTaxAmount', 'lineGrossAmount'])

function normalizeSku(sku: string | null | undefined): string | null {
  const normalized = (sku ?? '').trim().replace(/\s+/g, ' ').toLocaleUpperCase('es-CL')
  return normalized.length > 0 ? normalized : null
}

function normalizeVariantId(variantId: number | string | null | undefined): number | null {
  if (variantId == null || variantId === '') return null
  const parsed = Number(variantId)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parseOptionalNumber(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

function parseOptionalSafeInt(value: unknown): number | null {
  if (value == null || value === '' || typeof value === 'boolean') return null
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) ? parsed : null
}

function parseOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

export function mapPersistedIncidentToReconciliationIncident(row: Record<string, unknown>): PreparationReconciliationIncident {
  const rawSnapshot = row.bsale_observed_snapshot
  const snapshot = rawSnapshot != null && typeof rawSnapshot === 'object' && !Array.isArray(rawSnapshot)
    ? rawSnapshot as Record<string, unknown>
    : null
  return {
    id: parseOptionalString(row.id) ?? '',
    company_id: parseOptionalString(row.company_id),
    card_id: parseOptionalString(row.card_id),
    preparation_line_id: parseOptionalString(row.preparation_line_id) ?? '',
    status: parseOptionalString(row.status) ?? '',
    incident_type: parseOptionalString(row.incident_type),
    required_bsale_action: parseOptionalString(row.required_bsale_action),
    requested_quantity: parseOptionalNumber(row.requested_quantity),
    prepared_quantity: parseOptionalNumber(row.prepared_quantity),
    expected_bsale_quantity: parseOptionalNumber(row.expected_bsale_quantity),
    verification_status: parseOptionalString(row.verification_status),
    bsale_observed_quantity: parseOptionalNumber(row.bsale_observed_quantity),
    bsale_variant_id: parseOptionalSafeInt(row.bsale_variant_id),
    sku: parseOptionalString(row.sku),
    bsale_observed_snapshot: snapshot,
  }
}

function hasCanonicalProductIdentity(line: LineRef): boolean {
  if (!line || line.special === true) return false
  return normalizeVariantId(line.variantId) != null || normalizeSku(line.sku) != null
}

function hasConfirmedCommercialProductIdentity(previous: LineRef, current: LineRef): boolean {
  if (!hasCanonicalProductIdentity(previous) || !hasCanonicalProductIdentity(current)) return false
  const previousVariantId = normalizeVariantId(previous?.variantId)
  const currentVariantId = normalizeVariantId(current?.variantId)
  const previousSku = normalizeSku(previous?.sku)
  const currentSku = normalizeSku(current?.sku)
  return previousVariantId === currentVariantId && previousSku === currentSku
}

function hasConfirmedPersistedLineIdentity(line: LineRef, persistedLine: PreparationReconciliationLine | null): boolean {
  if (!hasCanonicalProductIdentity(line) || !persistedLine) return false
  const lineVariantId = normalizeVariantId(line?.variantId)
  const persistedVariantId = normalizeVariantId(persistedLine.bsale_variant_id)
  const lineSku = normalizeSku(line?.sku)
  const persistedSku = normalizeSku(persistedLine.sku)
  return lineVariantId === persistedVariantId && lineSku === persistedSku
}

function isConfirmedCommercialValueDifference(difference: CommercialLineDifference): boolean {
  if (difference.kind !== 'VALUE_CHANGED' || difference.confidence !== 'CERTAIN') return false
  if (!hasConfirmedCommercialProductIdentity(difference.previous, difference.current)) return false
  if (difference.changedFields.some(field => !COMMERCIAL_VALUE_FIELDS.has(field) && field !== 'quantity')) return false
  return difference.changedFields.some(field => COMMERCIAL_VALUE_FIELDS.has(field))
}

function scopedPreparationLines(
  preparationLines: PreparationReconciliationLine[],
  card?: PreparationCommercialReconciliationCard,
  includeRetired = false,
): PreparationReconciliationLine[] {
  return preparationLines.filter(item => (
    (includeRetired || (item.retired_at ?? null) == null)
    && (!card || (
      (item.company_id == null || item.company_id === card.companyId)
      && (item.card_id == null || item.card_id === card.cardId)
    ))
  ))
}

function persistedCandidates(
  line: LineRef,
  preparationLines: PreparationReconciliationLine[],
  card?: PreparationCommercialReconciliationCard,
): PreparationReconciliationLine[] {
  if (!line) return []
  const scopedLines = scopedPreparationLines(preparationLines, card, false)
  const byDetail = line.detailId == null ? [] : scopedLines.filter(item => item.bsale_detail_id === Number(line.detailId))
  if (byDetail.length > 0) return byDetail
  const byVariant = line.variantId == null ? [] : scopedLines.filter(item => item.bsale_variant_id === Number(line.variantId))
  if (byVariant.length > 0) return byVariant
  return line.sku?.trim()
    ? scopedLines.filter(item => item.sku?.trim().toLocaleUpperCase('es-CL') === line.sku?.trim().toLocaleUpperCase('es-CL'))
    : []
}

function isCommercialLineMatchingPersistedIdentity(
  commercialLine: PreparationCommercialLineInput,
  persistedLine: PreparationReconciliationLine,
): boolean {
  if (commercialLine.detailId != null && Number(commercialLine.detailId) === Number(persistedLine.bsale_detail_id)) return true
  const commercialVariantId = normalizeVariantId(commercialLine.variantId)
  const persistedVariantId = normalizeVariantId(persistedLine.bsale_variant_id)
  if (commercialVariantId != null && persistedVariantId != null && commercialVariantId === persistedVariantId) return true
  const commercialSku = normalizeSku(commercialLine.sku)
  const persistedSku = normalizeSku(persistedLine.sku)
  return commercialSku != null && persistedSku != null && commercialSku === persistedSku
}

function hasAddedLineCollision(
  line: LineRef,
  preparationLines: PreparationReconciliationLine[],
  currentVersion: PreparationCommercialVersion,
  card?: PreparationCommercialReconciliationCard,
): boolean {
  if (!line) return true
  const allScoped = scopedPreparationLines(preparationLines, card, true)
  const activeScoped = scopedPreparationLines(preparationLines, card, false)
  const detailId = parseOptionalSafeInt(line.detailId)
  if (detailId != null && allScoped.some(item => item.bsale_detail_id === detailId)) return true
  if (activeScoped.some(item => isCommercialLineMatchingPersistedIdentity(line, item))) return true
  const lineVariantId = normalizeVariantId(line.variantId)
  const lineSku = normalizeSku(line.sku)
  const matchingCurrentLines = (currentVersion.lines ?? []).filter(candidate => (
    (detailId != null && parseOptionalSafeInt(candidate.detailId) === detailId)
    || (lineVariantId != null && normalizeVariantId(candidate.variantId) === lineVariantId)
    || (lineSku != null && normalizeSku(candidate.sku) === lineSku)
  ))
  return matchingCurrentLines.length > 1
}

function incidentsFor(lineId: string | null, incidents: PreparationReconciliationIncident[]): PreparationReconciliationIncident[] {
  return lineId == null ? [] : incidents.filter(incident => incident.preparation_line_id === lineId)
}

function isUntouched(line: PreparationReconciliationLine): boolean {
  return (line.retired_at ?? null) == null
    && line.line_status === 'PENDING'
    && line.prepared_quantity == null
    && line.excluded_from_dispatch === false
}

const REQUIRED_INCIDENT_VERIFICATION_BASIS = 'FULL_CARD_AND_INCIDENT_ACTION_WITH_PHYSICAL_LINE'
const EXTRA_SNAPSHOT_PHYSICAL_ID_KEYS = ['physical_id', 'physicalId', 'documentId', 'currentNvId', 'nv_id', 'nvId'] as const

function parseStrictFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function parseStrictSafeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function hasCompatibleObservedSnapshot(params: {
  snapshot: Record<string, unknown> | null | undefined
  currentPhysicalId: number
  persistedLineId: string
  preparedQuantity: number
  expectedBsaleQuantity: number
  requiredBsaleAction: 'SET_QUANTITY' | 'REMOVE_LINE'
}): boolean {
  const { snapshot, currentPhysicalId, persistedLineId, preparedQuantity, expectedBsaleQuantity, requiredBsaleAction } = params
  if (!snapshot || Array.isArray(snapshot) || !Number.isSafeInteger(currentPhysicalId) || currentPhysicalId <= 0) return false
  if (snapshot.verification_basis !== REQUIRED_INCIDENT_VERIFICATION_BASIS) return false
  if (snapshot.verification_error != null && snapshot.verification_error !== '') return false
  if (parseStrictSafeInt(snapshot.document_state) !== 0) return false
  if (snapshot.canonical_identity_matched !== true || snapshot.sync_proven !== true || snapshot.line_link_valid !== true) return false
  if (snapshot.full_card_matched !== true || snapshot.incident_action_matched !== true) return false
  if (snapshot.required_bsale_action !== requiredBsaleAction) return false
  if (snapshot.preparation_line_id !== persistedLineId || snapshot.matched_preparation_line_id !== persistedLineId) return false
  if (parseStrictFiniteNumber(snapshot.expected_bsale_quantity) !== expectedBsaleQuantity) return false
  if (parseStrictFiniteNumber(snapshot.bsale_observed_quantity) !== expectedBsaleQuantity) return false
  if (parseStrictFiniteNumber(snapshot.physically_prepared_quantity) !== preparedQuantity) return false
  if (parseStrictSafeInt(snapshot.document_id) !== currentPhysicalId || parseStrictSafeInt(snapshot.current_nv_id) !== currentPhysicalId) return false
  for (const key of EXTRA_SNAPSHOT_PHYSICAL_ID_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(snapshot, key) || snapshot[key] === undefined) continue
    if (parseStrictSafeInt(snapshot[key]) !== currentPhysicalId) return false
  }
  return true
}

function isResolvedQuantityReductionIncident(params: {
  card: PreparationCommercialReconciliationCard
  currentVersion: PreparationCommercialVersion
  difference: CommercialLineDifference
  persistedLine: PreparationReconciliationLine
  relatedIncidents: PreparationReconciliationIncident[]
}): boolean {
  const { card, currentVersion, difference, persistedLine, relatedIncidents } = params
  if (difference.kind !== 'QUANTITY_DECREASED' || difference.confidence !== 'CERTAIN') return false
  if (!difference.previous || !difference.current) return false
  if ((persistedLine.retired_at ?? null) != null) return false
  if (persistedLine.line_status !== 'INCIDENT' || persistedLine.excluded_from_dispatch) return false
  if (persistedLine.company_id != null && persistedLine.company_id !== card.companyId) return false
  if (persistedLine.card_id != null && persistedLine.card_id !== card.cardId) return false

  const preparedQuantity = persistedLine.prepared_quantity
  const requestedQuantity = persistedLine.requested_quantity
  const newQuantity = difference.current.quantity
  if (preparedQuantity == null || !Number.isFinite(preparedQuantity) || preparedQuantity <= 0) return false
  if (!Number.isFinite(requestedQuantity) || requestedQuantity <= preparedQuantity) return false
  if (difference.previous.quantity !== requestedQuantity) return false
  if (newQuantity !== preparedQuantity) return false

  const persistedVariantId = normalizeVariantId(persistedLine.bsale_variant_id)
  const persistedSku = normalizeSku(persistedLine.sku)
  if (persistedVariantId == null && persistedSku == null) return false
  if (relatedIncidents.length === 0) return false
  if (relatedIncidents.some(incident => (
    !incident.id
    || incident.preparation_line_id !== persistedLine.id
    || !incident.company_id
    || incident.company_id !== card.companyId
    || !incident.card_id
    || incident.card_id !== card.cardId
    || (incident.status !== 'RESOLVED' && incident.status !== 'SUPERSEDED')
  ))) {
    return false
  }

  const resolvedIncidents = relatedIncidents.filter(incident => incident.status === 'RESOLVED')
  if (resolvedIncidents.length === 0) return false

  return resolvedIncidents.every(incident => {
    if (incident.preparation_line_id !== persistedLine.id) return false
    if (!incident.company_id || incident.company_id !== card.companyId) return false
    if (!incident.card_id || incident.card_id !== card.cardId) return false
    if (incident.status !== 'RESOLVED' || incident.verification_status !== 'MATCHED') return false
    if (incident.incident_type !== 'QUANTITY_REDUCTION' || incident.required_bsale_action !== 'SET_QUANTITY') return false
    if (parseOptionalNumber(incident.requested_quantity) !== requestedQuantity) return false
    if (parseOptionalNumber(incident.prepared_quantity) !== preparedQuantity) return false
    if (parseOptionalNumber(incident.expected_bsale_quantity) !== newQuantity) return false
    if (parseOptionalNumber(incident.bsale_observed_quantity) !== newQuantity) return false
    const incidentVariantId = normalizeVariantId(incident.bsale_variant_id)
    const incidentSku = normalizeSku(incident.sku)
    if (incidentVariantId == null && incidentSku == null) return false
    if (incidentVariantId !== persistedVariantId || incidentSku !== persistedSku) return false
    return hasCompatibleObservedSnapshot({
      snapshot: incident.bsale_observed_snapshot,
      currentPhysicalId: currentVersion.physicalId,
      persistedLineId: persistedLine.id,
      preparedQuantity,
      expectedBsaleQuantity: newQuantity,
      requiredBsaleAction: 'SET_QUANTITY',
    })
  })
}

function isResolvedLineExclusionIncident(params: {
  card: PreparationCommercialReconciliationCard
  currentVersion: PreparationCommercialVersion
  difference: CommercialLineDifference
  persistedLine: PreparationReconciliationLine
  relatedIncidents: PreparationReconciliationIncident[]
}): boolean {
  const { card, currentVersion, difference, persistedLine, relatedIncidents } = params
  if (difference.kind !== 'REMOVED' || difference.confidence !== 'CERTAIN' || !difference.previous || difference.current != null) return false
  if ((persistedLine.retired_at ?? null) != null || persistedLine.line_status !== 'INCIDENT' || !persistedLine.excluded_from_dispatch) return false
  if (persistedLine.company_id != null && persistedLine.company_id !== card.companyId) return false
  if (persistedLine.card_id != null && persistedLine.card_id !== card.cardId) return false
  const preparedQuantity = persistedLine.prepared_quantity
  const requestedQuantity = persistedLine.requested_quantity
  if (preparedQuantity !== 0 || !Number.isFinite(requestedQuantity) || requestedQuantity <= 0) return false
  if (difference.previous.quantity !== requestedQuantity || !hasConfirmedPersistedLineIdentity(difference.previous, persistedLine)) return false
  const persistedVariantId = normalizeVariantId(persistedLine.bsale_variant_id)
  const persistedSku = normalizeSku(persistedLine.sku)
  if (persistedVariantId == null && persistedSku == null) return false
  if (!Array.isArray(currentVersion.lines) || currentVersion.lines.length === 0) return false
  if (currentVersion.lines.some(line => isCommercialLineMatchingPersistedIdentity(line, persistedLine))) return false
  if (relatedIncidents.length === 0 || relatedIncidents.some(incident => (
    !incident.id || incident.preparation_line_id !== persistedLine.id || !incident.company_id || incident.company_id !== card.companyId
    || !incident.card_id || incident.card_id !== card.cardId || (incident.status !== 'RESOLVED' && incident.status !== 'SUPERSEDED')
  ))) return false
  const resolvedIncidents = relatedIncidents.filter(incident => incident.status === 'RESOLVED')
  if (resolvedIncidents.length === 0) return false
  return resolvedIncidents.every(incident => {
    if (!incident.company_id || incident.company_id !== card.companyId || !incident.card_id || incident.card_id !== card.cardId) return false
    if (incident.status !== 'RESOLVED' || incident.verification_status !== 'MATCHED') return false
    if (incident.incident_type !== 'LINE_EXCLUDED' || incident.required_bsale_action !== 'REMOVE_LINE') return false
    if (parseOptionalNumber(incident.requested_quantity) !== requestedQuantity) return false
    if (parseOptionalNumber(incident.prepared_quantity) !== 0 || parseOptionalNumber(incident.expected_bsale_quantity) !== 0 || parseOptionalNumber(incident.bsale_observed_quantity) !== 0) return false
    const incidentVariantId = normalizeVariantId(incident.bsale_variant_id)
    const incidentSku = normalizeSku(incident.sku)
    if (incidentVariantId == null && incidentSku == null) return false
    if (incidentVariantId !== persistedVariantId || incidentSku !== persistedSku) return false
    return hasCompatibleObservedSnapshot({
      snapshot: incident.bsale_observed_snapshot,
      currentPhysicalId: currentVersion.physicalId,
      persistedLineId: persistedLine.id,
      preparedQuantity: 0,
      expectedBsaleQuantity: 0,
      requiredBsaleAction: 'REMOVE_LINE',
    })
  })
}

function emptyPlan(input: BuildPreparationCommercialReconciliationPlanInput, status: PreparationCommercialReconciliationPlanStatus, conflicts: PreparationCommercialReconciliationConflict[] = []): PreparationCommercialReconciliationPlan {
  return {
    status,
    canAcceptCompletely: false,
    card: input.card,
    identity: input.identity,
    acceptedFingerprint: input.acceptedVersion ? fingerprintCommercialVersion(input.acceptedVersion).value : null,
    currentFingerprint: input.currentVersion ? fingerprintCommercialVersion(input.currentVersion).value : null,
    currentPhysicalId: input.currentVersion?.physicalId ?? null,
    differences: input.comparison?.differences ?? [],
    actions: [],
    conflicts,
    impact: { added: 0, removed: 0, quantityUpdates: 0, conflicts: conflicts.length, totalDelta: input.comparison?.totals.totalDelta ?? null },
  }
}

function conflictAction(
  reason: PreparationCommercialReconciliationConflictReason,
  message: string,
  previous: LineRef,
  current: LineRef,
  preparationLine: PreparationReconciliationLine | null,
  incidents: PreparationReconciliationIncident[],
): PreparationCommercialReconciliationAction {
  const relatedIncidents = incidentsFor(preparationLine?.id ?? null, incidents)
  const conflict: PreparationCommercialReconciliationConflict = {
    reason,
    message,
    preparationLineId: preparationLine?.id ?? null,
    previous,
    current,
    incidentIds: relatedIncidents.map(incident => incident.id),
  }
  return {
    kind: 'CONFLICT',
    preparationLineId: preparationLine?.id ?? null,
    previous,
    current,
    previousRequestedQuantity: preparationLine?.requested_quantity ?? null,
    newRequestedQuantity: current?.quantity ?? null,
    preparedQuantity: preparationLine?.prepared_quantity ?? null,
    quantityDelta: current && previous ? current.quantity - previous.quantity : null,
    incidentIds: relatedIncidents.map(incident => incident.id),
    conflict,
  }
}

function findSinglePersistedLine(
  line: LineRef,
  preparationLines: PreparationReconciliationLine[],
  card: PreparationCommercialReconciliationCard,
): { line: PreparationReconciliationLine | null; ambiguous: boolean } {
  const candidates = persistedCandidates(line, preparationLines, card)
  return { line: candidates.length === 1 ? candidates[0] : null, ambiguous: candidates.length > 1 }
}

function actionForDifference(
  difference: CommercialLineDifference,
  preparationLines: PreparationReconciliationLine[],
  incidents: PreparationReconciliationIncident[],
  card: PreparationCommercialReconciliationCard,
  currentVersion: PreparationCommercialVersion,
): PreparationCommercialReconciliationAction {
  const match = findSinglePersistedLine(difference.previous, preparationLines, card)
  if (difference.confidence === 'AMBIGUOUS') {
    return conflictAction('COMPARISON_AMBIGUOUS', 'El comparador no pudo emparejar la línea de forma inequívoca.', difference.previous, difference.current, match.line, incidents)
  }
  if (match.ambiguous) {
    return conflictAction('PREPARATION_LINE_AMBIGUOUS', 'Existen varias líneas operativas posibles para la misma identidad comercial.', difference.previous, difference.current, null, incidents)
  }
  if (difference.kind === 'ADDED') {
    if (!hasCanonicalProductIdentity(difference.current)) return conflictAction('UNKEYED_COMMERCIAL_LINE', 'La línea nueva no tiene una variante o SKU identificable.', difference.previous, difference.current, null, incidents)
    if (!difference.current || !Number.isFinite(difference.current.quantity) || difference.current.quantity <= 0) {
      return conflictAction('QUANTITY_BELOW_PREPARED', 'La línea nueva debe tener una cantidad comercial mayor que cero.', difference.previous, difference.current, null, incidents)
    }
    if (hasAddedLineCollision(difference.current, preparationLines, currentVersion, card)) {
      return conflictAction('PREPARATION_LINE_AMBIGUOUS', 'La línea comercial agregada colisiona con una línea de preparación existente.', difference.previous, difference.current, null, incidents)
    }
    return {
      kind: 'ADD', preparationLineId: null, previous: null, current: difference.current,
      previousRequestedQuantity: null, newRequestedQuantity: difference.current?.quantity ?? null,
      preparedQuantity: null, quantityDelta: null, incidentIds: [], conflict: null,
    }
  }
  if (!match.line) {
    return conflictAction('PREPARATION_LINE_NOT_FOUND', 'No existe una línea persistida que pueda conservarse para este cambio.', difference.previous, difference.current, null, incidents)
  }
  const relatedIncidents = incidentsFor(match.line.id, incidents)
  if (difference.kind === 'REMOVED') {
    if (!hasCanonicalProductIdentity(difference.previous)) return conflictAction('UNKEYED_COMMERCIAL_LINE', 'La línea eliminada no tiene una variante o SKU identificable.', difference.previous, difference.current, match.line, incidents)
    if (!hasConfirmedPersistedLineIdentity(difference.previous, match.line)) {
      return conflictAction('COMMERCIAL_SUBSTITUTION', 'La línea eliminada no coincide con la identidad canónica de la línea operativa.', difference.previous, difference.current, match.line, incidents)
    }
    if (match.line.excluded_from_dispatch) {
      if (isResolvedLineExclusionIncident({ card, currentVersion, difference, persistedLine: match.line, relatedIncidents })) {
        return {
          kind: 'REMOVE', preparationLineId: match.line.id, previous: difference.previous, current: null,
          previousRequestedQuantity: match.line.requested_quantity, newRequestedQuantity: 0,
          preparedQuantity: match.line.prepared_quantity, quantityDelta: -(difference.previous?.quantity ?? match.line.requested_quantity),
          incidentIds: relatedIncidents.map(incident => incident.id), conflict: null,
        }
      }
      return conflictAction('PREPARATION_LINE_EXCLUDED', 'La línea está excluida y su referencia operativa debe preservarse.', difference.previous, difference.current, match.line, incidents)
    }
    if (!isUntouched(match.line) || difference.previous?.quantity !== match.line.requested_quantity) return conflictAction('REMOVAL_WOULD_DISCARD_WORK', 'La línea eliminada ya tiene trabajo operativo o un estado distinto de pendiente.', difference.previous, difference.current, match.line, incidents)
    if (relatedIncidents.length > 0) return conflictAction('OPERATIONAL_INCIDENT_EXISTS', 'La línea eliminada tiene referencias de incidencia que deben preservarse.', difference.previous, difference.current, match.line, incidents)
    return {
      kind: 'REMOVE', preparationLineId: match.line.id, previous: difference.previous, current: null,
      previousRequestedQuantity: match.line.requested_quantity, newRequestedQuantity: 0,
      preparedQuantity: match.line.prepared_quantity, quantityDelta: -(difference.previous?.quantity ?? match.line.requested_quantity), incidentIds: [], conflict: null,
    }
  }
  if (difference.kind === 'SUBSTITUTION') {
    return conflictAction(
      'COMMERCIAL_SUBSTITUTION',
      'El cambio comercial no puede aplicarse automáticamente sin una decisión explícita.',
      difference.previous,
      difference.current,
      match.line,
      incidents,
    )
  }
  if (!hasCanonicalProductIdentity(difference.previous) || !hasCanonicalProductIdentity(difference.current)) {
    return conflictAction('UNKEYED_COMMERCIAL_LINE', 'La línea comercial no tiene una variante o SKU identificable.', difference.previous, difference.current, match.line, incidents)
  }
  if (
    !hasConfirmedCommercialProductIdentity(difference.previous, difference.current)
    || !hasConfirmedPersistedLineIdentity(difference.previous, match.line)
    || !hasConfirmedPersistedLineIdentity(difference.current, match.line)
  ) {
    return conflictAction(
      'COMMERCIAL_SUBSTITUTION',
      'La identidad canónica del producto cambió o no coincide con la línea operativa.',
      difference.previous,
      difference.current,
      match.line,
      incidents,
    )
  }
  if (difference.kind === 'QUANTITY_INCREASED' || difference.kind === 'QUANTITY_DECREASED') {
    if (match.line.excluded_from_dispatch) return conflictAction('PREPARATION_LINE_EXCLUDED', 'La línea está excluida y su referencia operativa debe preservarse.', difference.previous, difference.current, match.line, incidents)
    const newQuantity = difference.current?.quantity ?? 0
    const preparedQuantity = match.line.prepared_quantity ?? 0
    if (!Number.isFinite(newQuantity) || newQuantity <= 0 || newQuantity < preparedQuantity) return conflictAction('QUANTITY_BELOW_PREPARED', 'La nueva cantidad solicitada es inferior a la cantidad ya preparada.', difference.previous, difference.current, match.line, incidents)
    if (
      (relatedIncidents.length > 0 || match.line.line_status === 'INCIDENT')
      && !isResolvedQuantityReductionIncident({
        card,
        currentVersion,
        difference,
        persistedLine: match.line,
        relatedIncidents,
      })
    ) {
      return conflictAction('OPERATIONAL_INCIDENT_EXISTS', 'La línea con cantidad modificada tiene una incidencia operativa.', difference.previous, difference.current, match.line, incidents)
    }
    return {
      kind: 'UPDATE_QUANTITY', preparationLineId: match.line.id, previous: difference.previous, current: difference.current,
      previousRequestedQuantity: match.line.requested_quantity, newRequestedQuantity: newQuantity,
      preparedQuantity: match.line.prepared_quantity, quantityDelta: difference.quantityDelta,
      incidentIds: relatedIncidents.map(incident => incident.id), conflict: null,
    }
  }
  if (
    difference.kind === 'VALUE_CHANGED'
    && isConfirmedCommercialValueDifference(difference)
    && difference.previous?.quantity === difference.current?.quantity
    && match.line.requested_quantity === difference.current?.quantity
  ) {
    if (match.line.excluded_from_dispatch) return conflictAction('PREPARATION_LINE_EXCLUDED', 'La línea está excluida y su referencia operativa debe preservarse.', difference.previous, difference.current, match.line, incidents)
    return {
      kind: 'KEEP',
      preparationLineId: match.line.id,
      previous: difference.previous,
      current: difference.current,
      previousRequestedQuantity: match.line.requested_quantity,
      newRequestedQuantity: match.line.requested_quantity,
      preparedQuantity: match.line.prepared_quantity,
      quantityDelta: 0,
      incidentIds: relatedIncidents.map(incident => incident.id),
      conflict: null,
    }
  }
  return conflictAction(
    'COMMERCIAL_VALUE_CHANGED',
    'El cambio comercial no puede aplicarse automáticamente sin una decisión explícita.',
    difference.previous,
    difference.current,
    match.line,
    incidents,
  )
}

function keepActions(input: BuildPreparationCommercialReconciliationPlanInput): PreparationCommercialReconciliationAction[] {
  const planningDifferences = input.comparison?.differences ?? []
  return scopedPreparationLines(input.preparationLines, input.card, false)
    .filter(line => !planningDifferences.some(difference => difference.previous && persistedCandidates(difference.previous, [line], input.card).length > 0))
    .map(line => ({
      kind: 'KEEP' as const,
      preparationLineId: line.id,
      previous: null,
      current: null,
      previousRequestedQuantity: line.requested_quantity,
      newRequestedQuantity: line.requested_quantity,
      preparedQuantity: line.prepared_quantity,
      quantityDelta: 0,
      incidentIds: input.incidents.filter(incident => incident.preparation_line_id === line.id).map(incident => incident.id),
      conflict: null,
    }))
}

function isQuantityValueCompanion(difference: CommercialLineDifference, differences: CommercialLineDifference[]): boolean {
  if (!isConfirmedCommercialValueDifference(difference) || !difference.previous || !difference.current) return false
  if (difference.previous.quantity === difference.current.quantity) return false
  return differences.some(candidate => (
    (candidate.kind === 'QUANTITY_INCREASED' || candidate.kind === 'QUANTITY_DECREASED')
      && candidate.confidence === 'CERTAIN'
      && hasConfirmedCommercialProductIdentity(candidate.previous, candidate.current)
      && hasConfirmedCommercialProductIdentity(candidate.previous, difference.previous)
      && hasConfirmedCommercialProductIdentity(candidate.current, difference.current)
  ))
}

export function buildPreparationCommercialReconciliationPlan(input: BuildPreparationCommercialReconciliationPlanInput): PreparationCommercialReconciliationPlan {
  if (input.card.status !== 'IN_PREPARATION') return emptyPlan(input, 'NOT_APPLICABLE')
  if (!input.identity || !input.acceptedVersion || !input.currentVersion) return emptyPlan(input, input.acceptedVersion ? 'UNAVAILABLE' : 'AMBIGUOUS', [{
    reason: input.snapshotComplete === false ? 'SNAPSHOT_INCOMPLETE' : 'IDENTITY_NOT_VERIFIED',
    message: input.snapshotComplete === false ? 'La fotografía persistida está incompleta.' : 'No existe una identidad comercial verificable para ambas versiones.',
    preparationLineId: null, previous: null, current: null, incidentIds: [],
  }])
  if (!input.comparison) return emptyPlan(input, 'AMBIGUOUS', [{
    reason: 'COMPARISON_AMBIGUOUS', message: 'No existe un resultado de comparación verificable.', preparationLineId: null, previous: null, current: null, incidentIds: [],
  }])

  const acceptedFingerprint = fingerprintCommercialVersion(input.acceptedVersion).value
  const currentFingerprint = fingerprintCommercialVersion(input.currentVersion).value
  if (input.acceptedVersion.identity.canonicalToken !== input.identity.canonicalToken || input.currentVersion.identity.canonicalToken !== input.identity.canonicalToken) {
    return emptyPlan(input, 'AMBIGUOUS', [{
      reason: 'IDENTITY_NOT_VERIFIED', message: 'Las versiones no pertenecen a la identidad canónica de la tarjeta.', preparationLineId: null, previous: null, current: null, incidentIds: [],
    }])
  }
  if (input.comparison.previousFingerprint.value !== acceptedFingerprint || input.comparison.currentFingerprint.value !== currentFingerprint) {
    return emptyPlan(input, 'AMBIGUOUS', [{
      reason: 'CURRENT_VERSION_CHANGED', message: 'La versión evaluada ya no coincide con la versión verificada.', preparationLineId: null, previous: null, current: null, incidentIds: [],
    }])
  }
  if (!input.comparison.sameIdentity || input.comparison.conflicts.length > 0) {
    return emptyPlan(input, 'AMBIGUOUS', input.comparison.conflicts.map(conflict => ({
      reason: 'COMPARISON_AMBIGUOUS', message: `Comparación ambigua: ${conflict.reason}.`, preparationLineId: null, previous: null, current: null, incidentIds: [],
    })))
  }

  const currentVersion = input.currentVersion
  const planningDifferences = input.comparison.differences.filter(difference => !isQuantityValueCompanion(difference, input.comparison?.differences ?? []))
  const planningInput = { ...input, comparison: { ...input.comparison, differences: planningDifferences } }
  const rawActions = [...keepActions(planningInput), ...planningDifferences.map(difference => actionForDifference(difference, input.preparationLines, input.incidents, input.card, currentVersion))]
  const hasRemainingActiveLine = Array.isArray(currentVersion.lines)
    && currentVersion.lines.length > 0
    && currentVersion.lines.every(line => Number.isFinite(line.quantity) && line.quantity > 0)
    && rawActions.some(action => (action.kind === 'KEEP' || action.kind === 'UPDATE_QUANTITY' || action.kind === 'ADD') && (action.newRequestedQuantity ?? 0) > 0)
  const activePersistedById = new Map(scopedPreparationLines(input.preparationLines, input.card, false).map(line => [line.id, line]))
  const actions = !hasRemainingActiveLine && rawActions.every(action => action.conflict == null)
    ? rawActions.map(action => {
      if (action.kind !== 'REMOVE') return action
      const persistedLine = action.preparationLineId ? (activePersistedById.get(action.preparationLineId) ?? null) : null
      return conflictAction(
        persistedLine?.excluded_from_dispatch ? 'PREPARATION_LINE_EXCLUDED' : 'REMOVAL_WOULD_DISCARD_WORK',
        'No se puede aceptar una versión comercial que deje el pedido sin ninguna línea activa válida.',
        action.previous, action.current, persistedLine, input.incidents,
      )
    })
    : rawActions
  const actionConflicts = actions.flatMap(action => action.conflict ? [action.conflict] : [])
  const conflicts = !hasRemainingActiveLine && actionConflicts.length === 0
    ? [{ reason: 'REMOVAL_WOULD_DISCARD_WORK' as const, message: 'No se puede aceptar una versión comercial que deje el pedido sin ninguna línea activa válida.', preparationLineId: null, previous: null, current: null, incidentIds: [] }]
    : actionConflicts
  const hasCommercialDifference = input.comparison.differences.length > 0
  return {
    status: conflicts.length > 0 ? 'REQUIRES_RESOLUTION' : 'READY',
    canAcceptCompletely: conflicts.length === 0,
    card: input.card,
    identity: input.identity,
    acceptedFingerprint,
    currentFingerprint,
    currentPhysicalId: input.currentVersion.physicalId,
    differences: input.comparison.differences,
    actions,
    conflicts,
    impact: {
      added: actions.filter(action => action.kind === 'ADD').length,
      removed: actions.filter(action => action.kind === 'REMOVE').length,
      quantityUpdates: actions.filter(action => action.kind === 'UPDATE_QUANTITY').length,
      conflicts: conflicts.length,
      totalDelta: hasCommercialDifference ? input.comparison.totals.totalDelta : 0,
    },
  }
}
