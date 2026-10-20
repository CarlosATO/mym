import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  deriveAuditLineStatus,
  deriveQuantityIncidentType,
  evaluateAuditTake,
  incidentRequiresObservation,
  incidentRequiresPhoto,
  isAuditIncidentType,
  resolveAuditIncident,
  validateAuditPreClose,
} from '../src/modules/logistica/auditoria/audit-policy.ts'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020150000_logistica_sales_order_audit_base.sql', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/logistica/sales-order-audit.ts', root), 'utf8')
const policy = await readFile(new URL('src/modules/logistica/auditoria/audit-policy.ts', root), 'utf8')
const docs = await readFile(new URL('docs/logistica/DOCUMENTO_FUNCIONAL_APP_BODEGA.md', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

test('1. snapshot idempotente por constraints y ON CONFLICT', () => {
  assert.match(migration, /UNIQUE \(company_id, card_id, cycle_no\)/)
  assert.match(migration, /UNIQUE \(company_id, audit_id, preparation_line_id\)/)
  assert.match(migration, /ON CONFLICT \(company_id, card_id, cycle_no\) DO NOTHING/)
  assert.match(migration, /ON CONFLICT \(company_id, audit_id, preparation_line_id\) DO NOTHING/)
  assert.match(migration, /uq_sales_order_audits_active_card/)
})

test('2. requested_quantity_snapshot es inmutable', () => {
  assert.match(migration, /requested_quantity_snapshot numeric NOT NULL CHECK \(requested_quantity_snapshot >= 0\)/)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_audit_lines[\s\S]*?SET[\s\S]*?requested_quantity_snapshot\s*=/i)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_lines/i)
})

test('3. prepared_quantity_snapshot es inmutable', () => {
  assert.match(migration, /prepared_quantity_snapshot numeric NOT NULL CHECK \(prepared_quantity_snapshot >= 0\)/)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_audit_lines[\s\S]*?SET[\s\S]*?prepared_quantity_snapshot\s*=/i)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_lines/i)
})

test('4. audit NULL = PENDING', () => {
  assert.equal(deriveAuditLineStatus(null, 5), 'PENDING')
  assert.match(migration, /line_status = 'PENDING'\s+AND audit_quantity IS NULL/)
})

test('5. audit = prepared = CONFIRMED', () => {
  assert.equal(deriveAuditLineStatus(5, 5), 'CONFIRMED')
  assert.equal(deriveAuditLineStatus(0, 0), 'CONFIRMED')
  assert.match(migration, /line_status <> 'CONFIRMED'\s+OR audit_quantity = prepared_quantity_snapshot/)
})

test('6. audit < prepared = INCIDENT y tipo automático inferior', () => {
  assert.equal(deriveAuditLineStatus(4, 5), 'INCIDENT')
  assert.equal(deriveQuantityIncidentType(4, 5), 'QUANTITY_LOWER_THAN_PREPARED')
  assert.match(migration, /v_incident_type := 'QUANTITY_LOWER_THAN_PREPARED'/)
})

test('7. audit > prepared = INCIDENT y tipo automático superior', () => {
  assert.equal(deriveAuditLineStatus(6, 5), 'INCIDENT')
  assert.equal(deriveQuantityIncidentType(6, 5), 'QUANTITY_GREATER_THAN_PREPARED')
  assert.match(migration, /v_incident_type := 'QUANTITY_GREATER_THAN_PREPARED'/)
})

test('8. audit puede superar requested sin tope superior', () => {
  assert.match(migration, /audit_quantity numeric CHECK \(audit_quantity IS NULL OR audit_quantity >= 0\)/)
  assert.doesNotMatch(migration, /audit_quantity\s*<=\s*(requested_quantity|prepared_quantity)/i)
  assert.equal(deriveAuditLineStatus(3, 2), 'INCIDENT')
})

test('9. exceso no modifica requested ni prepared', () => {
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_lines/i)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_cards/i)
  assert.match(migration, /NO modifica Preparación/)
})

test('10. prepared 0 / audit 0 = CONFIRMED', () => {
  assert.equal(deriveAuditLineStatus(0, 0), 'CONFIRMED')
  assert.equal(deriveQuantityIncidentType(0, 0), null)
})

test('11. prepared 0 / audit > 0 = INCIDENT', () => {
  assert.equal(deriveAuditLineStatus(1, 0), 'INCIDENT')
  assert.equal(deriveQuantityIncidentType(1, 0), 'QUANTITY_GREATER_THAN_PREPARED')
})

test('12. incidencia cuantitativa automática sin motivo redundante', () => {
  assert.match(migration, /IF v_incident_type IS NULL THEN/)
  assert.match(migration, /IF p_audit_quantity < v_line\.prepared_quantity_snapshot THEN/)
  assert.match(migration, /ELSIF p_audit_quantity > v_line\.prepared_quantity_snapshot THEN/)
})

test('13. WRONG_PRODUCT requiere foto', () => {
  assert.equal(incidentRequiresPhoto('WRONG_PRODUCT'), true)
  assert.match(migration, /i\.incident_type IN \('WRONG_PRODUCT', 'DAMAGED_PRODUCT'\)/)
  assert.match(migration, /MISSING_REQUIRED_EVIDENCE/)
})

test('14. DAMAGED_PRODUCT requiere foto', () => {
  assert.equal(incidentRequiresPhoto('DAMAGED_PRODUCT'), true)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.audit_incident_has_required_evidence/)
  assert.match(migration, /NOT logistica\.audit_incident_has_required_evidence\(i\.company_id, i\.id\)/)
})

test('15. fotos opcionales en incidencias no obligatorias', () => {
  assert.equal(incidentRequiresPhoto('QUANTITY_LOWER_THAN_PREPARED'), false)
  assert.equal(incidentRequiresPhoto('QUANTITY_GREATER_THAN_PREPARED'), false)
  assert.equal(incidentRequiresPhoto('PRODUCT_NOT_FOUND'), false)
  assert.equal(incidentRequiresPhoto('OTHER'), false)
})

test('16. package_count es independiente de unidades y líneas', () => {
  assert.match(migration, /package_count integer CHECK \(package_count IS NULL OR package_count >= 0\)/)
  assert.doesNotMatch(migration, /package_count\s*=\s*(count|sum)\(/i)
  assert.match(actions, /packageCount: number/)
})

test('17. package_count no admite negativos', () => {
  assert.match(migration, /package_count integer CHECK \(package_count IS NULL OR package_count >= 0\)/)
  assert.match(migration, /p_package_count IS NULL OR p_package_count < 0/)
  assert.match(actions, /params\.packageCount < 0/)
})

test('18. foto global opcional y una por auditoría', () => {
  assert.match(migration, /GLOBAL_DISPATCH_PHOTO/)
  assert.match(migration, /uq_sales_order_audit_attachments_global/)
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }],
    incidents: [],
    packageCount: 2,
  })
  assert.equal(result.canFinalize, true)
})

test('19. un solo auditor puede tomar el lock', () => {
  const first = evaluateAuditTake({
    actorUserId: 'auditor-a',
    preparerUserId: 'preparer',
    lockedByUserId: null,
    canManage: true,
    canAuthorizeException: false,
  })
  const second = evaluateAuditTake({
    actorUserId: 'auditor-b',
    preparerUserId: 'preparer',
    lockedByUserId: 'auditor-a',
    canManage: true,
    canAuthorizeException: false,
  })
  assert.equal(first.ok, true)
  assert.equal(first.event, 'AUDIT_LOCK_CLAIM')
  assert.equal(second.ok, false)
  assert.match(migration, /FOR UPDATE/)
  assert.match(migration, /uq_sales_order_audits_active_card/)
})

test('20. segundo auditor no puede mutar', () => {
  assert.match(migration, /v_audit\.locked_by_user_id <> v_actor/)
  assert.match(migration, /Esta auditoría está asignada a otro usuario\./)
})

test('21. el preparador original no puede auditar', () => {
  const decision = evaluateAuditTake({
    actorUserId: 'preparer',
    preparerUserId: 'preparer',
    lockedByUserId: null,
    canManage: true,
    canAuthorizeException: true,
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.error, 'No puedes auditar una preparación realizada por ti.')
  assert.match(migration, /v_card\.assigned_user_id = v_actor/)
  assert.match(migration, /No puedes auditar una preparación realizada por ti\./)
})

test('22. lock sin timeout, heartbeat ni liberación automática', () => {
  assert.doesNotMatch(migration, /interval '/i)
  assert.doesNotMatch(migration, /heartbeat|ttl|expire/i)
  assert.doesNotMatch(migration, /locked_at\s*<\s*now\(\)\s*-/i)
})

test('23. RLS y aislamiento multiempresa', () => {
  for (const table of [
    'sales_order_audits',
    'sales_order_audit_lines',
    'sales_order_audit_incidents',
    'sales_order_audit_attachments',
  ]) {
    assert.match(migration, new RegExp(`ALTER TABLE logistica\\.${table} ENABLE ROW LEVEL SECURITY`))
  }
  assert.equal((migration.match(/core\.has_company_access\(auth\.uid\(\), company_id\)/g) ?? []).length >= 4, true)
  assert.equal((migration.match(/core\.has_permission_for_company\(auth\.uid\(\), company_id, 'logistica\.audit\.manage'\)/g) ?? []).length >= 4, true)
  assert.match(migration, /company_id uuid NOT NULL REFERENCES core\.companies\(id\)/)
})

test('24. no UPDATE a tablas de Preparación', () => {
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_lines/i)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_cards/i)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_incidents/i)
})

test('25. no operaciones Bsale', () => {
  assert.doesNotMatch(migration, /INSERT INTO integraciones\./i)
  assert.doesNotMatch(migration, /UPDATE integraciones\./i)
  assert.doesNotMatch(migration, /DELETE FROM integraciones\./i)
  assert.doesNotMatch(migration, /INSERT INTO logistica\.bsale/i)
})

test('26. pre-cierre bloqueado por líneas pendientes', () => {
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'PENDING' }, { line_status: 'CONFIRMED' }],
    incidents: [],
    packageCount: 3,
  })
  assert.equal(result.canFinalize, false)
  assert.equal(result.blockers.some(blocker => blocker.code === 'LINES_PENDING'), true)
})

test('27. pre-cierre bloqueado por incidencias OPEN', () => {
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'INCIDENT' }],
    incidents: [{ status: 'OPEN', incident_type: 'QUANTITY_GREATER_THAN_PREPARED', evidence_count: 1 }],
    packageCount: 3,
  })
  assert.equal(result.canFinalize, false)
  assert.equal(result.blockers.some(blocker => blocker.code === 'OPEN_INCIDENTS'), true)
})

test('28. pre-cierre requiere package_count válido', () => {
  const missing = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }],
    incidents: [],
    packageCount: null,
  })
  const zero = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }],
    incidents: [],
    packageCount: 0,
  })
  assert.equal(missing.canFinalize, false)
  assert.equal(missing.blockers.some(blocker => blocker.code === 'PACKAGE_COUNT_REQUIRED'), true)
  assert.equal(zero.canFinalize, false)
})

test('29. snapshot no se rematerializa si ya existe', () => {
  assert.match(migration, /INSERT INTO logistica\.sales_order_audits[\s\S]*?ON CONFLICT \(company_id, card_id, cycle_no\) DO NOTHING/)
  assert.match(migration, /INSERT INTO logistica\.sales_order_audit_lines[\s\S]*?ON CONFLICT \(company_id, audit_id, preparation_line_id\) DO NOTHING/)
  assert.match(migration, /RETURN v_audit_id;/)
})

test('incidencias: catálogo, OTHER y superseded', () => {
  assert.match(migration, /'QUANTITY_LOWER_THAN_PREPARED'/)
  assert.match(migration, /'QUANTITY_GREATER_THAN_PREPARED'/)
  assert.match(migration, /'WRONG_PRODUCT'/)
  assert.match(migration, /'DAMAGED_PRODUCT'/)
  assert.match(migration, /'PRODUCT_NOT_FOUND'/)
  assert.match(migration, /'OTHER'/)
  assert.equal(incidentRequiresObservation('OTHER'), true)
  assert.match(migration, /La observación es obligatoria para la incidencia OTRO\./)
  assert.match(migration, /SET status = 'SUPERSEDED'/)
  assert.match(migration, /status IN \('OPEN', 'RESOLVED', 'SUPERSEDED'\)/)
})

test('pre-cierre no ejecuta transición final', () => {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION logistica.can_finalize_sales_order_audit')
  const end = migration.indexOf('REVOKE ALL ON FUNCTION logistica.can_finalize_sales_order_audit', start)
  const body = migration.slice(start, end)
  assert.doesNotMatch(body, /UPDATE\s+logistica\.sales_order_audits/i)
  assert.doesNotMatch(body, /completed_at\s*=\s*now\(\)/i)
  assert.doesNotMatch(body, /INVOICED_READY_FOR_ROUTE|READY_FOR_INVOICE|AUDITED/i)
})

test('backend expone contratos RPC', () => {
  assert.match(actions, /rpc\('take_sales_order_audit'/)
  assert.match(actions, /rpc\('get_sales_order_audit_detail'/)
  assert.match(actions, /rpc\('confirm_sales_order_audit_line'/)
  assert.match(actions, /rpc\('set_sales_order_audit_package_count'/)
  assert.match(actions, /rpc\('register_sales_order_audit_attachment'/)
  assert.match(actions, /rpc\('can_finalize_sales_order_audit'/)
  assert.match(policy, /export function validateAuditPreClose/)
})

test('storage reutiliza patrón privado por company_id y permisos', () => {
  assert.match(migration, /'audit-evidence'/)
  assert.match(migration, /public,\s*file_size_limit,\s*allowed_mime_types/)
  assert.match(migration, /is_audit_evidence_path_allowed/)
  assert.match(migration, /core\.has_permission_for_company\(v_actor_id, v_company_id, 'logistica\.audit\.manage'\)/)
})

test('documentación actualizada a auditoría comparativa visible', () => {
  assert.match(docs, /AUDITORÍA COMPARATIVA VISIBLE/)
  assert.match(docs, /SOLICITADO \| PREPARADO \| AUDITADO/)
  assert.match(docs, /exceso/i)
  assert.match(docs, /IN_AUDIT.*AUDITED|AUDITED/)
  assert.match(docs, /finalize_sales_order_audit/)
  assert.match(docs, /COMPLETED/)
})

test('script de test registrado en package.json', () => {
  assert.equal(
    packageJson.scripts['test:logistica-auditoria-base'],
    'node --experimental-strip-types --test scripts/test-logistica-auditoria-base.mjs',
  )
})

test('manual 1. audit = prepared sin incidencia = CONFIRMED', () => {
  const resolved = resolveAuditIncident({ auditQuantity: 5, preparedQuantity: 5 })
  assert.equal(resolved.error, null)
  assert.equal(resolved.incidentType, null)
  assert.equal(deriveAuditLineStatus(5, 5, resolved.incidentType), 'CONFIRMED')
})

test('manual 2. audit = prepared + DAMAGED_PRODUCT = INCIDENT', () => {
  const resolved = resolveAuditIncident({
    auditQuantity: 5,
    preparedQuantity: 5,
    incidentType: 'DAMAGED_PRODUCT',
  })
  assert.equal(resolved.error, null)
  assert.equal(resolved.incidentType, 'DAMAGED_PRODUCT')
  assert.equal(deriveAuditLineStatus(5, 5, resolved.incidentType), 'INCIDENT')
})

test('manual 3. audit = prepared + WRONG_PRODUCT = INCIDENT', () => {
  const resolved = resolveAuditIncident({
    auditQuantity: 5,
    preparedQuantity: 5,
    incidentType: 'WRONG_PRODUCT',
  })
  assert.equal(resolved.error, null)
  assert.equal(resolved.incidentType, 'WRONG_PRODUCT')
  assert.equal(deriveAuditLineStatus(5, 5, resolved.incidentType), 'INCIDENT')
})

test('manual 4. PRODUCT_NOT_FOUND con audit 0 = INCIDENT', () => {
  const resolved = resolveAuditIncident({
    auditQuantity: 0,
    preparedQuantity: 3,
    incidentType: 'PRODUCT_NOT_FOUND',
  })
  assert.equal(resolved.error, null)
  assert.equal(resolved.incidentType, 'PRODUCT_NOT_FOUND')
  assert.equal(deriveAuditLineStatus(0, 3, resolved.incidentType), 'INCIDENT')
})

test('manual 5. PRODUCT_NOT_FOUND con audit > 0 se rechaza', () => {
  const resolved = resolveAuditIncident({
    auditQuantity: 1,
    preparedQuantity: 3,
    incidentType: 'PRODUCT_NOT_FOUND',
  })
  assert.equal(resolved.error, 'PRODUCT_NOT_FOUND sólo es válido con cantidad auditada 0.')
  assert.match(migration, /PRODUCT_NOT_FOUND sólo es válido con cantidad auditada 0\./)
  assert.match(migration, /sales_order_audit_incidents_product_not_found_zero/)
  assert.match(actions, /PRODUCT_NOT_FOUND sólo es válido con cantidad auditada 0\./)
})

test('manual 6. OTHER sin observación se rechaza', () => {
  const resolved = resolveAuditIncident({
    auditQuantity: 5,
    preparedQuantity: 5,
    incidentType: 'OTHER',
  })
  assert.equal(resolved.error, 'La observación es obligatoria para la incidencia OTRO.')
  assert.match(migration, /La observación es obligatoria para la incidencia OTRO\./)
  assert.match(actions, /La observación es obligatoria para la incidencia OTRO\./)
})

test('manual 7. OTHER con observación = INCIDENT', () => {
  const resolved = resolveAuditIncident({
    auditQuantity: 5,
    preparedQuantity: 5,
    incidentType: 'OTHER',
    observation: 'Empaque reventado en el fondo del bulto.',
  })
  assert.equal(resolved.error, null)
  assert.equal(resolved.incidentType, 'OTHER')
  assert.equal(resolved.observation, 'Empaque reventado en el fondo del bulto.')
  assert.equal(deriveAuditLineStatus(5, 5, resolved.incidentType), 'INCIDENT')
})

test('manual 8. DAMAGED_PRODUCT requiere evidencia para pre-cierre', () => {
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'INCIDENT' }],
    incidents: [{ status: 'OPEN', incident_type: 'DAMAGED_PRODUCT', evidence_count: 0 }],
    packageCount: 2,
  })
  assert.equal(result.blockers.some(blocker => blocker.code === 'MISSING_REQUIRED_EVIDENCE'), true)
})

test('manual 9. WRONG_PRODUCT requiere evidencia para pre-cierre', () => {
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'INCIDENT' }],
    incidents: [{ status: 'OPEN', incident_type: 'WRONG_PRODUCT', evidence_count: 0 }],
    packageCount: 2,
  })
  assert.equal(result.blockers.some(blocker => blocker.code === 'MISSING_REQUIRED_EVIDENCE'), true)
})

test('manual 10. incidencia manual anterior pasa a SUPERSEDED', () => {
  assert.match(migration, /UPDATE logistica\.sales_order_audit_incidents\s+SET status = 'SUPERSEDED'/)
  assert.match(migration, /AND status = 'OPEN'/)
})

test('manual 11. corregir incidencia manual puede volver a CONFIRMED', () => {
  const corrected = resolveAuditIncident({
    auditQuantity: 5,
    preparedQuantity: 5,
    incidentType: null,
  })
  assert.equal(corrected.error, null)
  assert.equal(corrected.incidentType, null)
  assert.equal(deriveAuditLineStatus(5, 5, corrected.incidentType), 'CONFIRMED')
})

test('manual 12. requested/prepared nunca cambian por incidencia manual', () => {
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_lines/i)
  assert.doesNotMatch(migration, /UPDATE\s+logistica\.sales_order_preparation_cards/i)
  assert.doesNotMatch(migration, /UPDATE\s+integraciones\./i)
})

test('manual 13. incidencia manual coexiste con igualdad numérica', () => {
  assert.equal(deriveAuditLineStatus(5, 5, 'DAMAGED_PRODUCT'), 'INCIDENT')
  assert.equal(deriveAuditLineStatus(5, 5, 'WRONG_PRODUCT'), 'INCIDENT')
  assert.equal(deriveAuditLineStatus(5, 5, 'OTHER'), 'INCIDENT')
})

test('manual 14. constraints permiten INCIDENT con audit = prepared', () => {
  assert.equal(isAuditIncidentType('DAMAGED_PRODUCT'), true)
  assert.equal(isAuditIncidentType('NOT_A_TYPE'), false)
  assert.match(migration, /line_status <> 'CONFIRMED'\s+OR audit_quantity = prepared_quantity_snapshot/)
  assert.doesNotMatch(migration, /line_status\s*=\s*'INCIDENT'[\s\S]{0,200}audit_quantity\s*<>/)
  assert.match(migration, /INCIDENT puede coexistir con audit_quantity = prepared_quantity_snapshot/)
})
