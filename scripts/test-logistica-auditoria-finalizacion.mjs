import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { validateAuditPreClose } from '../src/modules/logistica/auditoria/audit-policy.ts'
import { getMovementRule } from '../src/modules/logistica/preparacion-pedidos/movement-rules.ts'

const root = new URL('../', import.meta.url)
const migration = await readFile(new URL('supabase/migrations/20261020160000_logistica_finalize_sales_order_audit.sql', root), 'utf8')
const baseMigration = await readFile(new URL('supabase/migrations/20261020150000_logistica_sales_order_audit_base.sql', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/logistica/sales-order-audit.ts', root), 'utf8')
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/auditoria/sales-order-audit-drawer.tsx', root), 'utf8')
const closeDialog = await readFile(new URL('src/modules/logistica/auditoria/audit-close-review-dialog.tsx', root), 'utf8')
const movementRules = await readFile(new URL('src/modules/logistica/preparacion-pedidos/movement-rules.ts', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

function finalizeFunctionBody() {
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION logistica.finalize_sales_order_audit')
  assert.ok(start >= 0, 'finalize_sales_order_audit debe existir')
  const end = migration.indexOf('REVOKE ALL ON FUNCTION logistica.finalize_sales_order_audit', start)
  return migration.slice(start, end)
}

test('1. status AUDITED permitido por el constraint real', () => {
  assert.match(migration, /DROP CONSTRAINT IF EXISTS sales_order_preparation_cards_status_check/)
  for (const status of ['PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'INVOICED_READY_FOR_ROUTE', 'CANCELLED', 'AUDITED']) {
    assert.match(migration, new RegExp(`'${status}'`))
  }
  assert.match(migration, /CHECK \(status IN \([\s\S]*?'AUDITED'[\s\S]*?\)\)/)
  assert.match(migration, /CREATE OR REPLACE VIEW logistica\.vw_sales_order_preparation_board[\s\S]*?'AUDITED'/)
})

test('2. pre-cierre false no finaliza; la finalización revalida todo', () => {
  const body = finalizeFunctionBody()
  assert.doesNotMatch(body, /logistica\.can_finalize_sales_order_audit/)
  assert.match(migration, /No confía en[\s\S]*?can_finalize_sales_order_audit/)
  assert.equal(validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'PENDING' }],
    incidents: [],
    packageCount: 2,
  }).canFinalize, false)
})

test('3. líneas pendientes bloquean', () => {
  assert.match(finalizeFunctionBody(), /line_status = 'PENDING'[\s\S]*?v_pending_lines > 0/)
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'PENDING' }, { line_status: 'CONFIRMED' }],
    incidents: [],
    packageCount: 2,
  })
  assert.equal(result.blockers.some(blocker => blocker.code === 'LINES_PENDING'), true)
})

test('4. incidencias OPEN bloquean', () => {
  assert.match(finalizeFunctionBody(), /status = 'OPEN'[\s\S]*?v_open_incidents > 0/)
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }],
    incidents: [{ status: 'OPEN', incident_type: 'OTHER', evidence_count: 0 }],
    packageCount: 2,
  })
  assert.equal(result.blockers.some(blocker => blocker.code === 'OPEN_INCIDENTS'), true)
})

test('5-6. package_count NULL o 0 bloquea', () => {
  const body = finalizeFunctionBody()
  assert.match(body, /package_count IS NULL OR v_audit\.package_count < 1/)
  const nullCase = validateAuditPreClose({
    auditStatus: 'OPEN', cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }], incidents: [], packageCount: null,
  })
  const zeroCase = validateAuditPreClose({
    auditStatus: 'OPEN', cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }], incidents: [], packageCount: 0,
  })
  assert.equal(nullCase.blockers.some(blocker => blocker.code === 'PACKAGE_COUNT_REQUIRED'), true)
  assert.equal(zeroCase.blockers.some(blocker => blocker.code === 'PACKAGE_COUNT_REQUIRED'), true)
})

test('7. evidencia obligatoria faltante bloquea', () => {
  assert.match(finalizeFunctionBody(), /audit_incident_has_required_evidence/)
  assert.match(finalizeFunctionBody(), /v_missing_evidence > 0/)
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'INCIDENT' }],
    incidents: [{ status: 'OPEN', incident_type: 'DAMAGED_PRODUCT', evidence_count: 0 }],
    packageCount: 2,
  })
  assert.equal(result.blockers.some(blocker => blocker.code === 'MISSING_REQUIRED_EVIDENCE'), true)
})

test('8. foto global NO es obligatoria para finalizar', () => {
  const body = finalizeFunctionBody()
  assert.match(body, /La foto global es opcional/)
  assert.doesNotMatch(body, /IF NOT v_has_global_photo\s+THEN[\s\S]*?RAISE EXCEPTION/)
  const result = validateAuditPreClose({
    auditStatus: 'OPEN', cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }], incidents: [], packageCount: 2,
  })
  assert.equal(result.canFinalize, true)
})

test('9. sólo el owner del lock puede finalizar', () => {
  const body = finalizeFunctionBody()
  assert.match(body, /v_audit\.locked_by_user_id IS NULL/)
  assert.match(body, /v_audit\.locked_by_user_id <> v_actor/)
  assert.match(body, /assigned_auditor_user_id IS DISTINCT FROM v_actor/)
})

test('10. card fuera de IN_AUDIT rechaza', () => {
  assert.match(finalizeFunctionBody(), /v_card\.status <> 'IN_AUDIT'/)
})

test('11. audit fuera de OPEN rechaza', () => {
  assert.match(finalizeFunctionBody(), /v_audit\.status <> 'OPEN'/)
})

test('12-13. finalización deja audit COMPLETED con completed_at', () => {
  assert.match(finalizeFunctionBody(), /SET status = 'COMPLETED',[\s\S]*?completed_at = v_completed_at/)
  assert.match(migration, /CHECK \(status IN \('OPEN', 'CLOSED', 'COMPLETED'\)\)/)
  assert.match(migration, /status IN \('CLOSED', 'COMPLETED'\) AND completed_at IS NOT NULL/)
})

test('14. lock de auditoría liberado', () => {
  assert.match(finalizeFunctionBody(), /locked_by_user_id = NULL,[\s\S]*?locked_at = NULL/)
})

test('15. assigned auditor conservado', () => {
  const body = finalizeFunctionBody()
  const update = body.slice(body.indexOf("UPDATE logistica.sales_order_audits"), body.indexOf("UPDATE logistica.sales_order_preparation_cards"))
  assert.doesNotMatch(update, /assigned_auditor_user_id\s*=/)
  assert.match(body, /assigned_auditor_user_id', v_audit\.assigned_auditor_user_id/)
})

test('16. preparation assigned_user_id conservado', () => {
  const body = finalizeFunctionBody()
  const update = body.slice(body.indexOf("UPDATE logistica.sales_order_preparation_cards"), body.indexOf("INSERT INTO logistica.sales_order_preparation_movements"))
  assert.doesNotMatch(update, /assigned_user_id\s*=/)
  assert.doesNotMatch(update, /prepared_quantity|requested_quantity/)
})

test('17. card pasa a AUDITED', () => {
  assert.match(finalizeFunctionBody(), /UPDATE logistica\.sales_order_preparation_cards[\s\S]*?SET status = 'AUDITED'/)
  assert.match(migration, /'PENDING_ROUTE_PREP', 'IN_PREPARATION', 'IN_AUDIT', 'AUDITED'/)
})

test('18. movement AUDIT_COMPLETED registrado', () => {
  const body = finalizeFunctionBody()
  assert.match(body, /INSERT INTO logistica\.sales_order_preparation_movements/)
  assert.match(body, /'IN_AUDIT', 'AUDITED', v_actor/)
  assert.match(body, /'event', 'AUDIT_COMPLETED'/)
  assert.match(body, /'package_count', v_audit\.package_count/)
  assert.match(body, /'has_global_dispatch_photo', v_has_global_photo/)
})

test('19. AUDITED es read-only en backend', () => {
  assert.match(baseMigration, /v_audit\.status <> 'OPEN'/)
  assert.match(baseMigration, /v_card\.status <> 'IN_AUDIT'/)
  assert.match(migration, /CREATE OR REPLACE FUNCTION logistica\.is_audit_evidence_path_writable/)
  assert.match(migration, /AND a\.status = 'OPEN'/)
  assert.match(migration, /audit_evidence_insert[\s\S]*?is_audit_evidence_path_writable/)
  assert.match(migration, /audit_evidence_delete[\s\S]*?is_audit_evidence_path_writable/)
})

test('20. no drag hacia AUDITED', () => {
  const rule = getMovementRule('IN_AUDIT', 'AUDITED')
  assert.match(rule.error ?? '', /finalizando la Auditoría/)
  assert.match(movementRules, /toStatus === 'AUDITED'/)
  assert.match(migration, /IF p_to_status = 'AUDITED' THEN/)
})

test('21. no drag desde AUDITED', () => {
  const rule = getMovementRule('AUDITED', 'IN_PREPARATION')
  assert.match(rule.error ?? '', /terminal/)
  assert.match(movementRules, /fromStatus === 'AUDITED'/)
  assert.match(migration, /IF v_from_status = 'AUDITED' THEN/)
})

test('22. drawer AUDITED read-only y sin acciones de escritura', () => {
  assert.match(panel, /selectedCard\?\.status === 'AUDITED'/)
  assert.match(panel, /onFinalized=\{handleAuditFinalized\}/)
  assert.match(drawer, /const isFinalized = card\.status === 'AUDITED'/)
  assert.match(drawer, /AUDITORÍA FINALIZADA/)
  assert.match(drawer, /!isFinalized && \([\s\S]*?REVISAR CIERRE/)
  assert.match(drawer, /\{!isFinalized && \([\s\S]*?Confirmar/)
})

test('23. fotos históricas visibles después del cierre', () => {
  assert.match(drawer, /Incidencias históricas/)
  assert.match(drawer, /attachments\.filter\(item => item\.incident_id === incident\.id\)/)
  assert.match(drawer, /handleOpenEvidence\(item\)/)
  assert.match(migration, /a\.status IN \('OPEN', 'COMPLETED', 'CLOSED'\)/)
})

test('24. package_count visible en drawer AUDITED', () => {
  assert.match(drawer, /Cantidad final de bultos/)
  assert.match(drawer, /packageCount == null \? '—' : packageCount/)
  assert.match(closeDialog, /packageCount == null \? 'Sin bultos' : `\$\{packageCount\} bultos`/)
})

test('25. finalización no modifica Bsale', () => {
  assert.doesNotMatch(finalizeFunctionBody(), /INSERT INTO integraciones\./i)
  assert.doesNotMatch(finalizeFunctionBody(), /UPDATE integraciones\./i)
  assert.doesNotMatch(finalizeFunctionBody(), /DELETE FROM integraciones\./i)
  assert.doesNotMatch(finalizeFunctionBody(), /sync|reconcile|invoice/i)
})

test('26. no modifica requested/prepared/audited snapshots', () => {
  const body = finalizeFunctionBody()
  assert.doesNotMatch(body, /UPDATE logistica\.sales_order_audit_lines/i)
  assert.doesNotMatch(body, /requested_quantity_snapshot\s*=/)
  assert.doesNotMatch(body, /prepared_quantity_snapshot\s*=/)
  assert.doesNotMatch(body, /audit_quantity\s*=/)
})

test('27. modal final compacto y con acción Finalizar Auditoría', () => {
  assert.match(closeDialog, /max-w-\[660px\]/)
  assert.match(closeDialog, /Auditoría lista para finalizar/)
  assert.match(closeDialog, /La Auditoría cumple todos los requisitos de cierre\./)
  assert.match(closeDialog, /Finalizar Auditoría/)
  assert.match(closeDialog, /onFinalize/)
  assert.match(drawer, /finalizeSalesOrderAudit/)
  assert.match(actions, /rpc\('finalize_sales_order_audit'/)
})

test('28. script de test registrado en package.json', () => {
  assert.equal(packageJson.scripts['test:logistica-auditoria-finalizacion'], 'node --experimental-strip-types --test scripts/test-logistica-auditoria-finalizacion.mjs')
})

test('29. finalize success no vacía el detail', () => {
  const body = drawer.slice(drawer.indexOf('const handleFinalize'), drawer.indexOf('const hasSnapshot'))
  assert.match(body, /patchDetail\(current => \(\{/)
  assert.doesNotMatch(body, /setDetail\(null\)/)
  assert.doesNotMatch(body, /invalidateAuditCache/)
  assert.doesNotMatch(body, /setAuditCache\(card\.card_id, null\)/)
  assert.match(body, /status: 'COMPLETED'/)
})

test('30. card AUDITED usa audit COMPLETED', () => {
  assert.match(drawer, /const isFinalized = card\.status === 'AUDITED' \|\| audit\?\.status === 'COMPLETED'/)
  assert.match(drawer, /const canWrite = canManage && isOwner && !isSelfAuditBlocked && !isFinalized/)
})

test('31. get detail permite lectura COMPLETED', () => {
  const start = baseMigration.indexOf('CREATE OR REPLACE FUNCTION logistica.get_sales_order_audit_detail')
  const end = baseMigration.indexOf('REVOKE ALL ON FUNCTION logistica.get_sales_order_audit_detail', start)
  const body = baseMigration.slice(start, end)
  assert.ok(start >= 0 && end > start)
  assert.doesNotMatch(body, /a\.status\s*=\s*'OPEN'/)
  assert.doesNotMatch(body, /status\s*<>\s*'OPEN'/)
  assert.doesNotMatch(body, /c\.status\s*=\s*'IN_AUDIT'/)
  assert.doesNotMatch(body, /card\.status\s*=\s*'IN_AUDIT'/)
  assert.match(body, /AND card_id = p_card_id/)
  assert.match(actions, /getSalesOrderAuditDetail\([\s\S]*?companyIdOverride\?: string \| null/)
  assert.match(drawer, /getSalesOrderAuditDetail\(card\.card_id, card\.company_id\)/)
})

test('32. AUDITED no materializa ni intenta take', () => {
  assert.doesNotMatch(drawer, /materialize_sales_order_audit_snapshot/)
  assert.doesNotMatch(actions, /materialize_sales_order_audit_snapshot/)
  assert.match(drawer, /const canTake = !isFinalized &&/)
  assert.match(drawer, /\{!isFinalized && \([\s\S]*?TOMAR AUDITORÍA/)
})

test('33. loadDetail no deja loading infinito', () => {
  const start = drawer.indexOf('const loadDetail = useCallback')
  const end = drawer.indexOf('useEffect(() => {\n    mountedRef.current = true', start)
  const body = drawer.slice(start, end)
  assert.match(body, /try \{/)
  assert.match(body, /catch \(err: unknown\)/)
  assert.match(body, /finally \{/)
  assert.match(body, /setLoading\(false\)/)
  assert.match(body, /No se pudo cargar la Auditoría\./)
})

test('34. badge AUDITADA y totales históricos', () => {
  assert.match(drawer, /isFinalized \? 'Auditada' : 'En auditoría'/)
  assert.match(drawer, /const preparedTotal = formatPreparedTotal\(hasSnapshot, summary\.prepared\)/)
  assert.match(drawer, /const auditedTotal = formatAuditedTotal\(hasSnapshot, hasAnyAudited, summary\.audited\)/)
})

test('35. cache post-finalize conserva snapshot', () => {
  const body = drawer.slice(drawer.indexOf('const handleFinalize'), drawer.indexOf('const hasSnapshot'))
  assert.match(body, /patchDetail/)
  assert.match(body, /onFinalized\?\.\(finalized\)/)
  assert.match(body, /void loadDetail\(\)/)
  assert.match(drawer, /setAuditCache\(card\.card_id, next\)/)
})
