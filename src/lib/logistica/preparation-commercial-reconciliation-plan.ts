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
  bsale_detail_id: number
  bsale_variant_id: number | null
  sku: string | null
  product_name: string
  requested_quantity: number
  prepared_quantity: number | null
  line_status: 'PENDING' | 'CONFIRMED' | 'INCIDENT' | string
  excluded_from_dispatch: boolean
}

export type PreparationReconciliationIncident = {
  id: string
  preparation_line_id: string
  status: string
  incident_type?: string | null
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

function normalizeVariantId(variantId: number | null | undefined): number | null {
  if (variantId == null) return null
  const parsed = Number(variantId)
  return Number.isSafeInteger(parsed) ? parsed : null
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

function persistedCandidates(line: LineRef, preparationLines: PreparationReconciliationLine[]): PreparationReconciliationLine[] {
  if (!line) return []
  const byDetail = line.detailId == null ? [] : preparationLines.filter(item => item.bsale_detail_id === Number(line.detailId))
  if (byDetail.length > 0) return byDetail
  const byVariant = line.variantId == null ? [] : preparationLines.filter(item => item.bsale_variant_id === Number(line.variantId))
  if (byVariant.length > 0) return byVariant
  return line.sku?.trim()
    ? preparationLines.filter(item => item.sku?.trim().toLocaleUpperCase('es-CL') === line.sku?.trim().toLocaleUpperCase('es-CL'))
    : []
}

function incidentsFor(lineId: string | null, incidents: PreparationReconciliationIncident[]): PreparationReconciliationIncident[] {
  return lineId == null ? [] : incidents.filter(incident => incident.preparation_line_id === lineId)
}

function isUntouched(line: PreparationReconciliationLine): boolean {
  return line.line_status === 'PENDING'
    && line.prepared_quantity == null
    && line.excluded_from_dispatch === false
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

function findSinglePersistedLine(line: LineRef, preparationLines: PreparationReconciliationLine[]): { line: PreparationReconciliationLine | null; ambiguous: boolean } {
  const candidates = persistedCandidates(line, preparationLines)
  return { line: candidates.length === 1 ? candidates[0] : null, ambiguous: candidates.length > 1 }
}

function actionForDifference(
  difference: CommercialLineDifference,
  preparationLines: PreparationReconciliationLine[],
  incidents: PreparationReconciliationIncident[],
): PreparationCommercialReconciliationAction {
  const match = findSinglePersistedLine(difference.previous, preparationLines)
  if (difference.confidence === 'AMBIGUOUS') {
    return conflictAction('COMPARISON_AMBIGUOUS', 'El comparador no pudo emparejar la línea de forma inequívoca.', difference.previous, difference.current, match.line, incidents)
  }
  if (match.ambiguous) {
    return conflictAction('PREPARATION_LINE_AMBIGUOUS', 'Existen varias líneas operativas posibles para la misma identidad comercial.', difference.previous, difference.current, null, incidents)
  }
  if (difference.kind === 'ADDED') {
    if (!hasCanonicalProductIdentity(difference.current)) return conflictAction('UNKEYED_COMMERCIAL_LINE', 'La línea nueva no tiene una variante o SKU identificable.', difference.previous, difference.current, null, incidents)
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
    if (match.line.excluded_from_dispatch) return conflictAction('PREPARATION_LINE_EXCLUDED', 'La línea está excluida y su referencia operativa debe preservarse.', difference.previous, difference.current, match.line, incidents)
    if (!isUntouched(match.line)) return conflictAction('REMOVAL_WOULD_DISCARD_WORK', 'La línea eliminada ya tiene trabajo operativo o un estado distinto de pendiente.', difference.previous, difference.current, match.line, incidents)
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
    if (relatedIncidents.length > 0) return conflictAction('OPERATIONAL_INCIDENT_EXISTS', 'La línea con cantidad modificada tiene una incidencia operativa.', difference.previous, difference.current, match.line, incidents)
    const newQuantity = difference.current?.quantity ?? 0
    const preparedQuantity = match.line.prepared_quantity ?? 0
    if (newQuantity < preparedQuantity) return conflictAction('QUANTITY_BELOW_PREPARED', 'La nueva cantidad solicitada es inferior a la cantidad ya preparada.', difference.previous, difference.current, match.line, incidents)
    return {
      kind: 'UPDATE_QUANTITY', preparationLineId: match.line.id, previous: difference.previous, current: difference.current,
      previousRequestedQuantity: match.line.requested_quantity, newRequestedQuantity: newQuantity,
      preparedQuantity: match.line.prepared_quantity, quantityDelta: difference.quantityDelta, incidentIds: [], conflict: null,
    }
  }
  if (
    difference.kind === 'VALUE_CHANGED'
    && isConfirmedCommercialValueDifference(difference)
    && difference.previous?.quantity === difference.current?.quantity
    && match.line.requested_quantity === difference.current?.quantity
  ) {
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
  return input.preparationLines
    .filter(line => !planningDifferences.some(difference => difference.previous && persistedCandidates(difference.previous, [line]).length > 0))
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

  const planningDifferences = input.comparison.differences.filter(difference => !isQuantityValueCompanion(difference, input.comparison?.differences ?? []))
  const planningInput = { ...input, comparison: { ...input.comparison, differences: planningDifferences } }
  const actions = [...keepActions(planningInput), ...planningDifferences.map(difference => actionForDifference(difference, input.preparationLines, input.incidents))]
  const conflicts = actions.flatMap(action => action.conflict ? [action.conflict] : [])
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
