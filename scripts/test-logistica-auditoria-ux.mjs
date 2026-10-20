import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  deriveAuditLineStatus,
  evaluateAuditTake,
  incidentRequiresObservation,
  incidentRequiresPhoto,
  isAuditLockError,
  resolveAuditIncident,
  validateAuditPreClose,
} from '../src/modules/logistica/auditoria/audit-policy.ts'
import {
  auditBlockerMessages,
  formatAuditedTotal,
  formatAuditQuantity,
  formatPreparedTotal,
  getAuditLineResultLabel,
  summarizeAuditDetail,
  validateAuditEvidenceFile,
} from '../src/modules/logistica/auditoria/audit-ui-utils.ts'

const root = new URL('../', import.meta.url)
const panel = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const card = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', root), 'utf8')
const drawer = await readFile(new URL('src/modules/logistica/auditoria/sales-order-audit-drawer.tsx', root), 'utf8')
const incidentDialog = await readFile(new URL('src/modules/logistica/auditoria/audit-incident-dialog.tsx', root), 'utf8')
const takeoverDialog = await readFile(new URL('src/modules/logistica/auditoria/audit-takeover-dialog.tsx', root), 'utf8')
const closeDialog = await readFile(new URL('src/modules/logistica/auditoria/audit-close-review-dialog.tsx', root), 'utf8')
const actions = await readFile(new URL('src/app/actions/logistica/sales-order-audit.ts', root), 'utf8')
const previewDialog = await readFile(new URL('src/modules/logistica/auditoria/audit-evidence-preview-dialog.tsx', root), 'utf8')
const uiUtils = await readFile(new URL('src/modules/logistica/auditoria/audit-ui-utils.ts', root), 'utf8')
const cache = await readFile(new URL('src/modules/logistica/auditoria/audit-cache.ts', root), 'utf8')
const migration = await readFile(new URL('supabase/migrations/20261020150000_logistica_sales_order_audit_base.sql', root), 'utf8')
const packageJson = JSON.parse(await readFile(new URL('package.json', root), 'utf8'))

test('1. IN_AUDIT abre AuditDrawer y Preparación conserva su drawer', () => {
  assert.match(panel, /selectedCard\?\.status === 'IN_AUDIT'/)
  assert.match(panel, /<SalesOrderAuditDrawer/)
  assert.match(panel, /<SalesOrderDrawer/)
  assert.match(panel, /if \(card\.status === 'IN_AUDIT'\) \{\s+setSelectedCard\(card\)/)
})

test('2-4. Solicitado, Preparado y Auditado están separados', () => {
  assert.match(drawer, />Solicitado</)
  assert.match(drawer, /requested_quantity_snapshot/)
  assert.match(drawer, />Preparado</)
  assert.match(drawer, /prepared_quantity_snapshot/)
  assert.match(drawer, />Auditado</)
  assert.match(drawer, /audit_quantity/)
})

test('5. NULL se muestra como — y 0 se conserva', () => {
  assert.equal(formatAuditQuantity(null), '—')
  assert.equal(formatAuditQuantity(0), '0')
  assert.match(drawer, /placeholder="—"/)
  assert.match(drawer, /line\.audit_quantity == null \? '' : String\(line\.audit_quantity\)/)
})

test('6. El input auditado no tiene tope superior', () => {
  assert.match(drawer, /type="number"\s+min=\{0\}\s+step="any"/)
  assert.doesNotMatch(drawer, /max=\{line\.requested_quantity_snapshot\}/)
  assert.equal(deriveAuditLineStatus(3, 2), 'INCIDENT')
})

test('7. El input no modifica requested ni prepared', () => {
  assert.doesNotMatch(drawer, /confirmSalesOrderPreparationLine/)
  assert.doesNotMatch(drawer, /prepared_quantity_snapshot\s*=/)
  assert.match(drawer, /line\.requested_quantity_snapshot/)
  assert.match(drawer, /line\.prepared_quantity_snapshot/)
})

test('8. Confirmar cantidad exacta produce CONFIRMED', () => {
  const resolved = resolveAuditIncident({ auditQuantity: 5, preparedQuantity: 5 })
  assert.equal(resolved.incidentType, null)
  assert.equal(deriveAuditLineStatus(5, 5, resolved.incidentType), 'CONFIRMED')
  assert.match(drawer, /confirmSalesOrderAuditLine/)
  const line = { line_status: 'CONFIRMED', requested_quantity_snapshot: 5, prepared_quantity_snapshot: 5 }
  assert.equal(getAuditLineResultLabel(line, null), 'Conforme')
})

test('8b. Preparado distinto de solicitado se muestra como conforme con preparación', () => {
  const line = { line_status: 'CONFIRMED', requested_quantity_snapshot: 5, prepared_quantity_snapshot: 4 }
  assert.equal(getAuditLineResultLabel(line, null), 'Conforme con preparación')
  assert.match(drawer, /Faltante declarado en Preparación/)
})

test('9. Diferencia menor abre incidencia automática', () => {
  const resolved = resolveAuditIncident({ auditQuantity: 4, preparedQuantity: 5 })
  assert.equal(resolved.incidentType, 'QUANTITY_LOWER_THAN_PREPARED')
  assert.match(drawer, /QUANTITY_LOWER_THAN_PREPARED/)
  assert.match(drawer, /setIncidentDialog/)
  assert.match(incidentDialog, /Incidencia de Auditoría/)
})

test('10. Diferencia mayor abre incidencia automática', () => {
  const resolved = resolveAuditIncident({ auditQuantity: 6, preparedQuantity: 5 })
  assert.equal(resolved.incidentType, 'QUANTITY_GREATER_THAN_PREPARED')
  assert.match(drawer, /QUANTITY_GREATER_THAN_PREPARED/)
  assert.match(incidentDialog, /más unidades físicas que las declaradas/)
})

test('11. Incidencia manual disponible con cantidades iguales', () => {
  assert.match(drawer, /Incidencia/)
  const resolved = resolveAuditIncident({ auditQuantity: 5, preparedQuantity: 5, incidentType: 'DAMAGED_PRODUCT' })
  assert.equal(resolved.incidentType, 'DAMAGED_PRODUCT')
  assert.equal(deriveAuditLineStatus(5, 5, resolved.incidentType), 'INCIDENT')
  assert.match(uiUtils, /Producto dañado/)
})

test('12-13. DAMAGED_PRODUCT y WRONG_PRODUCT requieren fotografía', () => {
  assert.equal(incidentRequiresPhoto('DAMAGED_PRODUCT'), true)
  assert.equal(incidentRequiresPhoto('WRONG_PRODUCT'), true)
  assert.match(incidentDialog, /Debes adjuntar una fotografía obligatoria\./)
  assert.match(incidentDialog, /Falta evidencia/)
  assert.match(drawer, /Falta foto obligatoria/)
})

test('14. PRODUCT_NOT_FOUND exige cantidad auditada 0', () => {
  const rejected = resolveAuditIncident({ auditQuantity: 1, preparedQuantity: 5, incidentType: 'PRODUCT_NOT_FOUND' })
  assert.equal(rejected.error, 'PRODUCT_NOT_FOUND sólo es válido con cantidad auditada 0.')
  const allowed = resolveAuditIncident({ auditQuantity: 0, preparedQuantity: 5, incidentType: 'PRODUCT_NOT_FOUND' })
  assert.equal(allowed.error, null)
  assert.match(incidentDialog, /Producto no encontrado sólo es válido cuando la cantidad auditada es 0\./)
  assert.match(migration, /sales_order_audit_incidents_product_not_found_zero/)
})

test('15. OTHER exige observación', () => {
  assert.equal(incidentRequiresObservation('OTHER'), true)
  const rejected = resolveAuditIncident({ auditQuantity: 5, preparedQuantity: 5, incidentType: 'OTHER' })
  assert.equal(rejected.error, 'La observación es obligatoria para la incidencia OTRO.')
  const allowed = resolveAuditIncident({ auditQuantity: 5, preparedQuantity: 5, incidentType: 'OTHER', observation: 'Empaque roto' })
  assert.equal(allowed.error, null)
  assert.match(incidentDialog, /La observación es obligatoria para la incidencia Otro\./)
})

test('16. Upload usa audit-evidence y registro de metadata', () => {
  assert.match(actions, /AUDIT_EVIDENCE_BUCKET/)
  assert.match(actions, /\.storage\s*\n?\s*\.from\(AUDIT_EVIDENCE_BUCKET\)/)
  assert.match(actions, /register_sales_order_audit_attachment/)
  assert.match(uiUtils, /audit-evidence/)
  assert.match(incidentDialog, /AUDIT_EVIDENCE_ACCEPT/)
  assert.match(drawer, /uploadSalesOrderAuditEvidence/)
})

test('17. Foto global es opcional y usa GLOBAL_DISPATCH_PHOTO', () => {
  assert.match(drawer, /GLOBAL_DISPATCH_PHOTO/)
  assert.match(drawer, /Fotografía de salida/)
  assert.match(drawer, />\(opcional\)/)
  assert.match(drawer, /evidencia de los bultos entregados al transportista/i)
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'CONFIRMED' }],
    incidents: [],
    packageCount: 2,
  })
  assert.equal(result.canFinalize, true)
})

test('18-19. package_count es independiente y editable', () => {
  assert.match(drawer, /Cantidad final de bultos/)
  assert.match(drawer, /Dato físico independiente de productos y unidades/)
  assert.match(drawer, /setSalesOrderAuditPackageCount/)
  assert.match(actions, /rpc\('set_sales_order_audit_package_count'/)
  assert.match(drawer, /onKeyDown=\{event => \{ if \(event\.key === 'Enter'\) void handleSavePackage\(\) \}\}/)
})

test('20. Lock de auditoría y estado owner', () => {
  assert.match(drawer, /takeSalesOrderAudit/)
  assert.match(drawer, /Tu auditoría/)
  assert.match(drawer, /canWrite/)
  assert.match(drawer, /isOwner/)
})

test('21. Preparador no puede tomar Auditoría', () => {
  const decision = evaluateAuditTake({
    actorUserId: 'preparer',
    preparerUserId: 'preparer',
    lockedByUserId: null,
    canManage: true,
    canAuthorizeException: true,
  })
  assert.equal(decision.ok, false)
  assert.equal(decision.error, 'No puedes auditar una preparación realizada por ti.')
  assert.match(drawer, /No puedes auditar una preparación realizada por ti\./)
})

test('22. Otro auditor deja la vista en sólo lectura', () => {
  assert.match(drawer, /Esta Nota de Venta está siendo auditada por/)
  assert.match(drawer, /Modo sólo lectura/)
  assert.match(drawer, /canManage && isOwner && !isPreparer/)
  assert.equal(isAuditLockError('Esta auditoría está asignada a otro usuario.'), true)
})

test('23. Takeover exige permiso y motivo', () => {
  assert.match(drawer, /canAuthorizeException/)
  assert.match(drawer, /<AuditTakeoverDialog/)
  assert.match(takeoverDialog, /Motivo \*/)
  assert.match(takeoverDialog, /El motivo es obligatorio\./)
  assert.match(actions, /take_sales_order_audit/)
})

test('24. Cache no sustituye autorización', () => {
  assert.match(cache, /getAuditCache/)
  assert.match(cache, /setAuditCache/)
  assert.match(drawer, /getAuditCache/)
  assert.match(drawer, /getSalesOrderAuditDetail/)
  assert.doesNotMatch(cache, /has_permission|has_company_access|canManage/)
})

test('25. Confirmar parchea la línea sin reload completo', () => {
  assert.match(drawer, /applyLineConfirmation/)
  assert.match(drawer, /lines: current\.lines\.map/)
  assert.doesNotMatch(drawer, /router\.refresh/)
  assert.doesNotMatch(drawer, /loadBoard/)
})

test('26. Historial SUPERSEDED no se borra', () => {
  assert.match(drawer, /status: 'SUPERSEDED'/)
  assert.match(migration, /SET status = 'SUPERSEDED'/)
  assert.doesNotMatch(migration, /DELETE FROM logistica\.sales_order_audit_incidents/)
})

test('27. Revisar cierre llama al contrato can_finalize', () => {
  assert.match(drawer, /handleReviewClose/)
  assert.match(drawer, /getSalesOrderAuditFinalizationStatus/)
  assert.match(actions, /rpc\('can_finalize_sales_order_audit'/)
})

test('28. Blockers traducidos a mensajes humanos', () => {
  const messages = auditBlockerMessages([
    { code: 'LINES_PENDING', message: 'x', count: 3 },
    { code: 'OPEN_INCIDENTS', message: 'x', count: 2 },
    { code: 'PACKAGE_COUNT_REQUIRED', message: 'x' },
    { code: 'MISSING_REQUIRED_EVIDENCE', message: 'x', count: 1 },
  ])
  assert.deepEqual(messages, [
    'Faltan 3 productos por auditar.',
    'Existen incidencias pendientes de resolver.',
    'Debes informar la cantidad final de bultos.',
    'Falta evidencia fotográfica obligatoria.',
  ])
})

test('29. can_finalize true no mueve la tarjeta ni completa la auditoría', () => {
  assert.match(closeDialog, /no cambia el estado de la tarjeta ni completa la Auditoría/)
  assert.doesNotMatch(closeDialog, /moveSalesOrderPreparationCard/)
  assert.doesNotMatch(drawer, /moveSalesOrderPreparationCard/)
  const start = migration.indexOf('CREATE OR REPLACE FUNCTION logistica.can_finalize_sales_order_audit')
  const end = migration.indexOf('REVOKE ALL ON FUNCTION logistica.can_finalize_sales_order_audit', start)
  const body = migration.slice(start, end)
  assert.doesNotMatch(body, /UPDATE\s+logistica\.sales_order_audits/i)
  assert.doesNotMatch(body, /completed_at\s*=\s*now\(\)/i)
})

test('30. No operaciones Bsale desde Auditoría', () => {
  for (const source of [drawer, incidentDialog, takeoverDialog, closeDialog, actions]) {
    assert.doesNotMatch(source, /updateBsale|createBsale|deleteBsale|integraciones\.bsale/i)
  }
  assert.doesNotMatch(migration, /INSERT INTO integraciones\.|UPDATE integraciones\.|DELETE FROM integraciones\./i)
})

test('31. No mutación de Preparación desde Auditoría', () => {
  for (const source of [drawer, incidentDialog, takeoverDialog, closeDialog, actions]) {
    assert.doesNotMatch(source, /confirmSalesOrderPreparationLine|moveSalesOrderPreparationCard/)
  }
  assert.doesNotMatch(drawer, /prepared_quantity\s*=/)
  assert.doesNotMatch(drawer, /requested_quantity\s*=/)
})

test('UX policy: resumen separa líneas y unidades', () => {
  const detail = {
    audit: null,
    attachments: [],
    incidents: [
      { id: 'i1', audit_line_id: 'l1', status: 'OPEN' },
    ],
    lines: [
      { id: 'l1', line_status: 'INCIDENT', requested_quantity_snapshot: 2, prepared_quantity_snapshot: 2, audit_quantity: 3 },
      { id: 'l2', line_status: 'CONFIRMED', requested_quantity_snapshot: 5, prepared_quantity_snapshot: 4, audit_quantity: 4 },
      { id: 'l3', line_status: 'PENDING', requested_quantity_snapshot: 1, prepared_quantity_snapshot: 1, audit_quantity: null },
    ],
  }
  const summary = summarizeAuditDetail(detail)
  assert.equal(summary.totalLines, 3)
  assert.equal(summary.auditedLines, 2)
  assert.equal(summary.conformingLines, 1)
  assert.equal(summary.incidentLines, 1)
  assert.equal(summary.openIncidents, 1)
  assert.equal(summary.requested, 8)
  assert.equal(summary.prepared, 7)
  assert.equal(summary.audited, 7)
})

test('UX policy: archivo de evidencia valida MIME y tamaño', () => {
  const valid = validateAuditEvidenceFile(new File([new Uint8Array(10)], 'foto.jpg', { type: 'image/jpeg' }))
  assert.equal(valid.ok, true)
  const invalidMime = validateAuditEvidenceFile(new File([new Uint8Array(10)], 'foto.gif', { type: 'image/gif' }))
  assert.equal(invalidMime.ok, false)
  const invalidSize = validateAuditEvidenceFile(new File([], 'foto.jpg', { type: 'image/jpeg' }))
  assert.equal(invalidSize.ok, false)
})

test('script UX registrado en package.json', () => {
  assert.equal(
    packageJson.scripts['test:logistica-auditoria-ux'],
    'node --experimental-strip-types --test scripts/test-logistica-auditoria-ux.mjs',
  )
})


test('visual 1. drawer ancho en desktop', () => {
  assert.match(drawer, /w-\[96vw\]/)
  assert.match(drawer, /max-w-\[1550px\]/)
  assert.match(drawer, /xl:w-\[80vw\]/)
})

test('visual 2. layout desktop de dos columnas', () => {
  assert.match(drawer, /xl:grid-cols-\[minmax\(0,1fr\)_340px\]/)
  assert.match(drawer, /2xl:grid-cols-\[minmax\(0,1fr\)_360px\]/)
})

test('visual 3. tabla compacta de líneas', () => {
  assert.match(drawer, /<table className="w-full min-w-\[900px\]/)
  assert.match(drawer, /<thead>/)
  assert.match(drawer, /<tbody>/)
  assert.match(drawer, />SKU</)
  assert.match(drawer, />Producto</)
})

test('visual 4. no hay tarjetas grandes por producto', () => {
  assert.match(drawer, /<Fragment key=\{line\.id\}>/)
  assert.match(drawer, /<tr className="border-b border-\[#E8DFD5\] align-top/)
  assert.doesNotMatch(drawer, /key=\{line\.id\} className="rounded-lg/)
})

test('visual 5. columnas Solicitado / Preparado / Auditado', () => {
  assert.match(drawer, />Solicitado</)
  assert.match(drawer, />Preparado</)
  assert.match(drawer, />Auditado</)
  assert.match(drawer, /line\.requested_quantity_snapshot/)
  assert.match(drawer, /line\.prepared_quantity_snapshot/)
  assert.match(drawer, /line\.audit_quantity/)
})

test('visual 6. Resultado compacto con badge', () => {
  assert.match(drawer, /resultToneClasses/)
  assert.match(drawer, /inline-flex rounded-md border px-1\.5 py-0\.5 text-\[10px\]/)
  assert.match(drawer, /getAuditLineResultLabel/)
})

test('visual 7. acciones compactas por fila', () => {
  assert.match(drawer, /Confirmar/)
  assert.match(drawer, />\s*Incidencia\s*</)
  assert.match(drawer, /px-2 py-1 text-\[10px\]/)
})

test('visual 8. incidencia como subfila compacta', () => {
  assert.match(drawer, /colSpan=\{7\}/)
  assert.match(drawer, /openIncident && \(/)
  assert.match(drawer, /Obs\.: \{openIncident\.observation\}/)
  assert.match(drawer, /Falta foto obligatoria/)
})

test('visual 9. panel lateral de cierre', () => {
  assert.match(drawer, /<aside/)
  assert.match(drawer, /Cierre de Auditoría/)
})

test('visual 10. panel lateral sticky', () => {
  assert.match(drawer, /xl:sticky/)
  assert.match(drawer, /xl:top-4/)
})

test('visual 11. package_count vive en el panel lateral', () => {
  const aside = drawer.slice(drawer.indexOf('<aside'), drawer.indexOf('</aside>'))
  assert.match(aside, /Cantidad final de bultos/)
  assert.match(aside, /audit-package-count/)
  assert.match(aside, /handleSavePackage/)
})

test('visual 12. foto global vive en el panel lateral', () => {
  const aside = drawer.slice(drawer.indexOf('<aside'), drawer.indexOf('</aside>'))
  assert.match(aside, /Fotografía de salida/)
  assert.match(aside, /handleGlobalPhoto/)
  assert.match(aside, /GLOBAL_DISPATCH_PHOTO|globalPhoto/)
})

test('visual 13. resumen compacto en panel', () => {
  const aside = drawer.slice(drawer.indexOf('<aside'), drawer.indexOf('</aside>'))
  assert.match(aside, /SideStat/)
  assert.match(aside, /grid grid-cols-2/)
  assert.match(aside, /<SideStat label="Líneas"/)
  assert.match(aside, /<SideStat label="Conformes"/)
  assert.match(aside, /<SideStat label="Solicitado"/)
  assert.match(aside, /<SideStat label="Preparado"/)
  assert.match(aside, /<SideStat label="Auditado"/)
  assert.match(aside, /<SideStat label="Bultos"/)
  assert.doesNotMatch(drawer, /SummaryBox/)
})

test('visual 14. revisar cierre vive en el panel lateral', () => {
  const aside = drawer.slice(drawer.indexOf('<aside'), drawer.indexOf('</aside>'))
  assert.match(aside, /REVISAR CIERRE/)
  assert.match(aside, /handleReviewClose/)
})

test('visual 15. Preparado muestra — antes de snapshot y 0 cuando suma real 0', () => {
  assert.equal(formatPreparedTotal(false, 0), '—')
  assert.equal(formatPreparedTotal(false, 5), '—')
  assert.equal(formatPreparedTotal(true, 0), '0')
  assert.equal(formatPreparedTotal(true, 5), '5')
  assert.match(drawer, /preparedTotal/)
})

test('visual 16. Auditado muestra — si todas las líneas están NULL', () => {
  assert.equal(formatAuditedTotal(true, false, 0), '—')
  assert.equal(formatAuditedTotal(true, false, 5), '—')
  assert.match(drawer, /hasAnyAudited/)
})

test('visual 17. Auditado muestra 0 si existe auditoría real con suma 0', () => {
  assert.equal(formatAuditedTotal(true, true, 0), '0')
  assert.equal(formatAuditedTotal(true, true, 5), '5')
})

test('visual 18. sin regresión de confirmación', () => {
  assert.match(drawer, /confirmSalesOrderAuditLine/)
  assert.match(drawer, /handleConfirmLine/)
})

test('visual 19. sin regresión de fotos', () => {
  assert.match(drawer, /uploadSalesOrderAuditEvidence/)
  assert.match(drawer, /AUDIT_EVIDENCE_ACCEPT/)
})

test('visual 20. sin regresión de locking', () => {
  assert.match(drawer, /isOwner/)
  assert.match(drawer, /isLockedByOther/)
  assert.match(drawer, /canWrite/)
  assert.match(drawer, /takeSalesOrderAudit/)
})


test('perf 1. confirmación usa fast path de companyId y evita preflight redundante', () => {
  const start = actions.indexOf('export async function confirmSalesOrderAuditLine')
  const end = actions.indexOf('export async function setSalesOrderAuditPackageCount', start)
  const body = actions.slice(start, end)
  assert.match(body, /requireAuditUser\(params\.companyId\)/)
  assert.match(actions, /Fast path para mutaciones de Auditoría/)
  assert.match(actions, /core\.has_company_access/)
  assert.doesNotMatch(body, /getActiveCompanyId\(/)
  assert.match(body, /\[audit-confirm\]\[server\]/)
})

test('perf 2. confirmación no recarga detalle ni materializa después del RPC', () => {
  const start = actions.indexOf('export async function confirmSalesOrderAuditLine')
  const end = actions.indexOf('export async function setSalesOrderAuditPackageCount', start)
  const body = actions.slice(start, end)
  assert.doesNotMatch(body, /getSalesOrderAuditDetail/)
  assert.doesNotMatch(body, /materialize_sales_order_audit_snapshot/)
  assert.doesNotMatch(body, /router\.refresh/)
})

test('perf 3. drawer pasa companyId a confirmación y uploads', () => {
  assert.match(drawer, /companyId: card\.company_id/)
  const companyIdCount = (drawer.match(/companyId: card\.company_id/g) ?? []).length
  assert.equal(companyIdCount >= 5, true)
})

test('perf 4. patch local y cache actualizados tras confirmar', () => {
  assert.match(drawer, /applyLineConfirmation/)
  assert.match(drawer, /setAuditCache/)
  assert.match(drawer, /\[audit-confirm\]\[client-incident\]/)
})

test('perf 5. modal cierra después de la respuesta persistida', () => {
  const confirmIndex = incidentDialog.indexOf('const result = await onConfirm')
  const closeIndex = incidentDialog.indexOf('onOpenChange(false)', confirmIndex)
  assert.equal(confirmIndex >= 0, true)
  assert.equal(closeIndex > confirmIndex, true)
  assert.match(incidentDialog, /\[audit-confirm\]\[modal\]/)
  assert.match(incidentDialog, /confirmMs/)
  assert.match(incidentDialog, /closeMs/)
})


test('evidencias 1. evidencias existentes visibles en la subfila', () => {
  assert.match(drawer, /incidentEvidence\.map/)
  assert.match(drawer, /handleOpenEvidence/)
  assert.match(drawer, /Ver evidencia/)
  assert.match(drawer, /FileImage/)
})

test('evidencias 2. click abre preview reutilizable', () => {
  assert.match(drawer, /setPreviewOpen\(true\)/)
  assert.match(drawer, /<AuditEvidencePreviewDialog/)
  assert.match(previewDialog, /Evidencia fotográfica/)
  assert.match(previewDialog, /Vista previa temporal de la evidencia registrada/)
})

test('evidencias 3. preview usa signed URL temporal lazy', () => {
  assert.match(actions, /getSalesOrderAuditAttachmentSignedUrl/)
  assert.match(actions, /createSignedUrl\(data\.storage_path as string, 300\)/)
  assert.match(previewDialog, /evidence\.signedUrl/)
  assert.match(drawer, /getSalesOrderAuditAttachmentSignedUrl\(attachment\.id\)/)
  assert.doesNotMatch(drawer, /createSignedUrl/)
})

test('evidencias 4. bucket audit-evidence sigue privado', () => {
  assert.match(migration, /'audit-evidence',\s+'audit-evidence',\s+false/)
  assert.doesNotMatch(actions, /getPublicUrl/)
})

test('evidencias 5. una foto satisface la evidencia obligatoria', () => {
  const result = validateAuditPreClose({
    auditStatus: 'OPEN',
    cardStatus: 'IN_AUDIT',
    lines: [{ line_status: 'INCIDENT' }],
    incidents: [{ status: 'OPEN', incident_type: 'DAMAGED_PRODUCT', evidence_count: 1 }],
    packageCount: 2,
  })
  assert.equal(result.blockers.some(blocker => blocker.code === 'MISSING_REQUIRED_EVIDENCE'), false)
  assert.match(drawer, /incidentEvidence\.length === 0/)
})

test('evidencias 6. una incidencia puede mostrar múltiples fotos', () => {
  assert.match(drawer, /incidentEvidence\.map/)
  assert.match(drawer, /evidencia\$\{incidentEvidence\.length === 1 \? '' : 's'\}/)
  assert.doesNotMatch(migration, /UNIQUE \(company_id, incident_id\)/)
})

test('evidencias 7. botón cambia a Agregar otra foto', () => {
  assert.match(drawer, /Agregar otra foto/)
  assert.match(drawer, /Agregar fotografía/)
  assert.match(drawer, /incidentEvidence\.length > 0/)
})

test('evidencias 8. no existe eliminación visual de evidencia', () => {
  assert.doesNotMatch(drawer, /Eliminar evidencia|delete.*evidence/i)
  assert.doesNotMatch(actions, /deleteSalesOrderAuditEvidence|removeSalesOrderAuditEvidence/)
})

test('evidencias 9. foto global sigue siendo única y visible', () => {
  assert.match(migration, /uq_sales_order_audit_attachments_global/)
  assert.match(drawer, /globalPhoto \?/)
  assert.match(drawer, /handleOpenEvidence\(globalPhoto\)/)
  assert.match(drawer, />\s*Ver\s*</)
})

test('evidencias 10. HEIC tiene fallback sin romper upload', () => {
  assert.match(drawer, /image\/heic/)
  assert.match(previewDialog, /image\/heic/)
  assert.match(previewDialog, /Vista previa no disponible para este formato\./)
  assert.match(previewDialog, /El archivo HEIC quedó registrado correctamente como evidencia\./)
  assert.match(actions, /image\/heic/)
})
