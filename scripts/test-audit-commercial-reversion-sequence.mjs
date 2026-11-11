import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const MIGRATION_PATH = resolve(process.cwd(), 'supabase/migrations/20261111170000_logistica_audit_commercial_reversion_sequence.sql')

test('Contrato de migración SQL 20261111170000_logistica_audit_commercial_reversion_sequence.sql', () => {
  const sql = readFileSync(MIGRATION_PATH, 'utf-8')

  // 1. Integridad transaccional
  assert.ok(sql.trim().startsWith('BEGIN;'), 'La migración debe abrir una transacción con BEGIN;')
  assert.ok(sql.trim().endsWith('COMMIT;'), 'La migración debe cerrar la transacción con COMMIT;')

  // 2. Eliminación dirigida con validación de definición previa sobre sales_order_preparation_comme_company_id_card_id_fingerprin_key
  assert.match(
    sql,
    /conname\s*=\s*'sales_order_preparation_comme_company_id_card_id_fingerprin_key'/i,
    'Debe buscar específicamente el constraint conname sales_order_preparation_comme_company_id_card_id_fingerprin_key'
  )
  assert.match(
    sql,
    /IF NOT FOUND THEN\s*RAISE EXCEPTION 'Restriccion sales_order_preparation_comme_company_id_card_id_fingerprin_key no encontrada/i,
    'Debe fallar explícitamente si no se encuentra la restricción antigua'
  )
  assert.match(
    sql,
    /v_def IS DISTINCT FROM 'UNIQUE \(company_id, card_id, fingerprint\)'/i,
    'Debe verificar que la definición del constraint corresponde exactamente a UNIQUE (company_id, card_id, fingerprint)'
  )
  assert.match(
    sql,
    /DROP CONSTRAINT\s+sales_order_preparation_comme_company_id_card_id_fingerprin_key/i,
    'Debe eliminar exactamente la restricción esperada'
  )

  // 3. Adición de la restricción de protección física UNIQUE sobre current_bsale_nv_id
  assert.match(
    sql,
    /ADD CONSTRAINT\s+sales_order_preparation_commercial_versions_company_card_bsale_id_key\s+UNIQUE\s*\(\s*company_id,\s*card_id,\s*current_bsale_nv_id\s*\)/i,
    'Debe agregar la restricción UNIQUE (company_id, card_id, current_bsale_nv_id)'
  )

  // 4. Verificación en la función: no debe contener la restricción global restrictiva previa
  assert.doesNotMatch(
    sql,
    /WHERE\s+company_id\s*=\s*p_company_id\s+AND\s+card_id\s*=\s*p_card_id\s+AND\s+fingerprint\s*=\s*v_request\.version_fingerprint/i,
    'No debe contener el rechazo global de fingerprint que impedía secuencias A -> B -> A'
  )

  // 5. Verificación en la función: debe rechazar duplicados del mismo documento físico Bsale
  assert.match(
    sql,
    /IF EXISTS\s*\(\s*SELECT 1 FROM logistica\.sales_order_preparation_commercial_versions[\s\S]*current_bsale_nv_id\s*=\s*v_current_id[\s\S]*\)\s*THEN[\s\S]*RAISE EXCEPTION\s*'AUDIT_ACCEPTANCE_DOCUMENT_ALREADY_EXISTS'/i,
    'Debe rechazar con AUDIT_ACCEPTANCE_DOCUMENT_ALREADY_EXISTS si el documento físico ya fue registrado'
  )

  // 6. Verificación en la función: debe rechazar transiciones nulas respecto a la versión activa inmediata
  assert.match(
    sql,
    /IF v_request\.version_fingerprint\s*=\s*v_previous\.fingerprint\s*THEN[\s\S]*RAISE EXCEPTION\s*'AUDIT_ACCEPTANCE_FINGERPRINT_ALREADY_EXISTS'/i,
    'Debe rechazar con AUDIT_ACCEPTANCE_FINGERPRINT_ALREADY_EXISTS si no hay cambio respecto a la versión activa previa'
  )

  // 7. Preservación de idempotencia para solicitudes ya aplicadas
  assert.match(
    sql,
    /IF v_request\.applied_version_id IS NOT NULL THEN[\s\S]*RETURN jsonb_build_object\('status',\s*'ALREADY_ACCEPTED'/i,
    'Debe mantener la respuesta idempotente ALREADY_ACCEPTED cuando applied_version_id no es nulo'
  )

  // 8. Preservación de permisos y seguridad
  assert.match(sql, /REVOKE ALL ON FUNCTION logistica\.accept_sales_order_audit_commercial_changes_v1/i)
  assert.match(sql, /GRANT EXECUTE ON FUNCTION logistica\.accept_sales_order_audit_commercial_changes_v1[\s\S]*TO service_role/i)
  assert.match(sql, /SECURITY DEFINER/i)
})

/**
 * Simulación aislada de la lógica del motor de persistencia de versiones comerciales
 * para validar la secuencia A -> B -> A, idempotencia y rechazo de duplicados.
 */
class IsolatedCommercialEngine {
  constructor(companyId, cardId) {
    this.companyId = companyId
    this.cardId = cardId
    this.versions = []
    this.requests = new Map()
  }

  seedVersion(doc) {
    const version = {
      id: `ver-${this.versions.length + 1}`,
      company_id: this.companyId,
      card_id: this.cardId,
      sequence_no: this.versions.length + 1,
      current_bsale_nv_id: doc.currentBsaleId,
      fingerprint: doc.fingerprint,
      previous_fingerprint: this.versions.length > 0 ? this.versions[this.versions.length - 1].fingerprint : null,
      version_snapshot: doc.snapshot,
    }
    this.versions.push(version)
    return version
  }

  createRequest(requestId, previousVersionId, previousFingerprint, versionFingerprint, currentBsaleId, snapshot) {
    const req = {
      id: requestId,
      previous_version_id: previousVersionId,
      previous_fingerprint: previousFingerprint,
      version_fingerprint: versionFingerprint,
      current_bsale_nv_id: currentBsaleId,
      version_snapshot: snapshot,
      applied_version_id: null,
    }
    this.requests.set(requestId, req)
    return req
  }

  // Reproducción exacta de la lógica de evaluación implementada en la migración SQL
  acceptChanges(requestId, currentBsaleId) {
    const request = this.requests.get(requestId)
    if (!request) throw new Error('AUDIT_ACCEPTANCE_REQUEST_NOT_FOUND')

    // Regla de idempotencia
    if (request.applied_version_id !== null) {
      const existing = this.versions.find(v => v.id === request.applied_version_id)
      if (!existing) throw new Error('AUDIT_ACCEPTANCE_RESULT_MISSING')
      return { status: 'ALREADY_ACCEPTED', versionId: existing.id }
    }

    // Regla de versión previa activa
    const previous = this.versions.length > 0 ? this.versions[this.versions.length - 1] : null
    if (!previous || previous.id !== request.previous_version_id || previous.fingerprint !== request.previous_fingerprint) {
      throw new Error('AUDIT_ACCEPTANCE_PREVIOUS_VERSION_STALE')
    }

    // NUEVA REGLA 1: Rechazar duplicar el mismo documento físico Bsale
    const duplicateDoc = this.versions.find(v => v.current_bsale_nv_id === currentBsaleId)
    if (duplicateDoc) {
      throw new Error('AUDIT_ACCEPTANCE_DOCUMENT_ALREADY_EXISTS')
    }

    // NUEVA REGLA 2: Rechazar si no hay cambio respecto a la versión activa previa inmediata
    if (request.version_fingerprint === previous.fingerprint) {
      throw new Error('AUDIT_ACCEPTANCE_FINGERPRINT_ALREADY_EXISTS')
    }

    // Simulación de validaciones de snapshot / líneas / precios
    if (request.version_snapshot?.taxInvalid) {
      throw new Error('AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID')
    }
    if (request.version_snapshot?.linesChanged) {
      throw new Error('AUDIT_ACCEPTANCE_QUANTITY_OR_PRICE_CHANGED')
    }

    // Inserción de nueva versión
    const newVersion = {
      id: `ver-${this.versions.length + 1}`,
      company_id: this.companyId,
      card_id: this.cardId,
      sequence_no: previous.sequence_no + 1,
      current_bsale_nv_id: currentBsaleId,
      previous_fingerprint: previous.fingerprint,
      fingerprint: request.version_fingerprint,
      version_snapshot: request.version_snapshot,
    }
    this.versions.push(newVersion)
    request.applied_version_id = newVersion.id

    return { status: 'ACCEPTED', versionId: newVersion.id }
  }
}

test('Secuencia comercial A -> B -> A con documentos físicos diferentes es permitida', () => {
  const engine = new IsolatedCommercialEngine('comp-1', 'card-1')

  const FINGERPRINT_A = 'fp-canonical-46315'
  const FINGERPRINT_B = 'fp-canonical-47184'

  // Versión 1: Bsale 93120, total $46.315 (fingerprint A)
  const v1 = engine.seedVersion({
    currentBsaleId: 93120,
    fingerprint: FINGERPRINT_A,
    snapshot: { total: 46315 },
  })
  assert.equal(engine.versions.length, 1)
  assert.equal(v1.sequence_no, 1)
  assert.equal(v1.fingerprint, FINGERPRINT_A)

  // Versión 2: Modificación en Bsale 93141, total $47.184 (fingerprint B)
  const req2 = engine.createRequest('req-2', v1.id, v1.fingerprint, FINGERPRINT_B, 93141, { total: 47184 })
  const res2 = engine.acceptChanges('req-2', 93141)
  assert.equal(res2.status, 'ACCEPTED')
  assert.equal(engine.versions.length, 2)
  const v2 = engine.versions[1]
  assert.equal(v2.sequence_no, 2)
  assert.equal(v2.current_bsale_nv_id, 93141)
  assert.equal(v2.fingerprint, FINGERPRINT_B)
  assert.equal(v2.previous_fingerprint, FINGERPRINT_A)

  // Versión 3 (NV 5172 caso real): Reversión a $46.315 con nuevo documento Bsale 93200 (fingerprint A)
  // Ahora debe ser aceptado legítimamente
  const req3 = engine.createRequest('req-3', v2.id, v2.fingerprint, FINGERPRINT_A, 93200, { total: 46315 })
  const res3 = engine.acceptChanges('req-3', 93200)
  assert.equal(res3.status, 'ACCEPTED')
  assert.equal(engine.versions.length, 3)
  const v3 = engine.versions[2]
  assert.equal(v3.sequence_no, 3)
  assert.equal(v3.current_bsale_nv_id, 93200)
  assert.equal(v3.fingerprint, FINGERPRINT_A)
  assert.equal(v3.previous_fingerprint, FINGERPRINT_B)
})

test('Rechazo estricto de duplicar la misma versión del mismo documento físico', () => {
  const engine = new IsolatedCommercialEngine('comp-1', 'card-1')
  const v1 = engine.seedVersion({
    currentBsaleId: 93120,
    fingerprint: 'fp-A',
    snapshot: { total: 46315 },
  })

  // Intentar aceptar una solicitud con el mismo documento físico 93120
  const reqDup = engine.createRequest('req-dup', v1.id, v1.fingerprint, 'fp-different', 93120, { total: 50000 })
  assert.throws(
    () => engine.acceptChanges('req-dup', 93120),
    /AUDIT_ACCEPTANCE_DOCUMENT_ALREADY_EXISTS/
  )
})

test('Rechazo de solicitud si el fingerprint no cambia respecto a la versión activa inmediata', () => {
  const engine = new IsolatedCommercialEngine('comp-1', 'card-1')
  const v1 = engine.seedVersion({
    currentBsaleId: 93120,
    fingerprint: 'fp-A',
    snapshot: { total: 46315 },
  })

  // Documento físico nuevo 93125 pero con el mismo fingerprint de la versión 1 (sin cambio comercial respecto a la activa)
  const reqSame = engine.createRequest('req-same', v1.id, v1.fingerprint, 'fp-A', 93125, { total: 46315 })
  assert.throws(
    () => engine.acceptChanges('req-same', 93125),
    /AUDIT_ACCEPTANCE_FINGERPRINT_ALREADY_EXISTS/
  )
})

test('Idempotencia pura en reintentos de solicitudes ya aplicadas', () => {
  const engine = new IsolatedCommercialEngine('comp-1', 'card-1')
  const v1 = engine.seedVersion({
    currentBsaleId: 93120,
    fingerprint: 'fp-A',
    snapshot: { total: 46315 },
  })

  const req = engine.createRequest('req-ok', v1.id, v1.fingerprint, 'fp-B', 93141, { total: 47184 })
  const resFirst = engine.acceptChanges('req-ok', 93141)
  assert.equal(resFirst.status, 'ACCEPTED')

  // Segundo intento con la misma solicitud
  const resRetry = engine.acceptChanges('req-ok', 93141)
  assert.equal(resRetry.status, 'ALREADY_ACCEPTED')
  assert.equal(resRetry.versionId, resFirst.versionId)
  assert.equal(engine.versions.length, 2, 'No se deben crear versiones duplicadas al reintentar')
})

test('Las protecciones y validaciones de auditoría física y evidencia tributaria permanecen intactas', () => {
  const engine = new IsolatedCommercialEngine('comp-1', 'card-1')
  const v1 = engine.seedVersion({
    currentBsaleId: 93120,
    fingerprint: 'fp-A',
    snapshot: { total: 46315 },
  })

  // Falla evidencia fiscal
  const reqTaxBad = engine.createRequest('req-tax-bad', v1.id, v1.fingerprint, 'fp-B', 93141, { taxInvalid: true })
  assert.throws(
    () => engine.acceptChanges('req-tax-bad', 93141),
    /AUDIT_ACCEPTANCE_TAX_EVIDENCE_INVALID/
  )

  // Falla líneas o cantidades físicas
  const reqLineBad = engine.createRequest('req-line-bad', v1.id, v1.fingerprint, 'fp-B', 93141, { linesChanged: true })
  assert.throws(
    () => engine.acceptChanges('req-line-bad', 93141),
    /AUDIT_ACCEPTANCE_QUANTITY_OR_PRICE_CHANGED/
  )
})
