import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import {
  isAuditCardBlockedForSync,
} from '../src/modules/logistica/preparacion-pedidos/preparation-line-validation.ts'

const root = process.cwd()
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

test('1. botón Sincronizar aparece en tarjetas IN_AUDIT con incidencias o diferencias comerciales pendientes', () => {
  assert.equal(isAuditCardBlockedForSync({
    cardStatus: 'IN_AUDIT',
    openAuditIncidentCount: 1,
    openCommercialIncidentCount: 0,
    commercialVerificationStatus: null,
  }), true)

  assert.equal(isAuditCardBlockedForSync({
    cardStatus: 'IN_AUDIT',
    openAuditIncidentCount: 0,
    openCommercialIncidentCount: 1,
    commercialVerificationStatus: 'READY_TO_INVOICE',
  }), true)

  for (const status of ['INCIDENTS', 'BLOCKED']) {
    assert.equal(isAuditCardBlockedForSync({
      cardStatus: 'IN_AUDIT',
      openAuditIncidentCount: 0,
      openCommercialIncidentCount: 0,
      commercialVerificationStatus: status,
    }), true, `debe mostrarse para verificationStatus=${status}`)
  }
})

test('2. botón Sincronizar NO aparece en auditorías finalizadas (AUDITED), otros estados ni IN_AUDIT limpia', () => {
  assert.equal(isAuditCardBlockedForSync({
    cardStatus: 'IN_AUDIT',
    openAuditIncidentCount: 0,
    openCommercialIncidentCount: 0,
    commercialVerificationStatus: 'READY_TO_INVOICE',
  }), false)

  for (const cardStatus of ['AUDITED', 'IN_PREPARATION', 'PENDING_ROUTE_PREP', 'INVOICED_READY_FOR_ROUTE']) {
    assert.equal(isAuditCardBlockedForSync({
      cardStatus,
      openAuditIncidentCount: 2,
      openCommercialIncidentCount: 2,
      commercialVerificationStatus: 'INCIDENTS',
    }), false, `no debe mostrarse en ${cardStatus}`)
  }
})

test('3. syncSalesOrderAuditCardFromBsale reutiliza motor Bsale + verificación comercial de Auditoría y nunca altera evidencias ni finaliza automáticamente', () => {
  const src = read('src/app/actions/logistica/sales-order-preparation-incident-sync.ts')
  const fnStart = src.indexOf('export async function syncSalesOrderAuditCardFromBsale')
  assert.ok(fnStart !== -1, 'debe exportar syncSalesOrderAuditCardFromBsale')
  const fnBody = src.slice(fnStart)

  // Permisos, estado IN_AUDIT, auditoría OPEN y lock de Auditoría
  assert.match(fnBody, /requireWmsPermission\('logistica\.audit\.manage'\)/)
  assert.match(fnBody, /if \(cardRow\.status !== 'IN_AUDIT'\)/)
  assert.match(fnBody, /\.from\('sales_order_audits'\)/)
  assert.match(fnBody, /\.eq\('status',\s*'OPEN'\)/)
  assert.match(fnBody, /openAudit\.locked_by_user_id/)

  // Reutiliza infraestructura Bsale + verificación comercial y pre-cierre oficiales de Auditoría
  assert.match(fnBody, /createBsalePreparationCommercialProvider\(\)\.getCurrentVersion/)
  assert.match(fnBody, /hydrateBsaleDocumentsById\(/)
  assert.match(fnBody, /replaceBsaleDocumentSnapshot\(/)
  assert.match(fnBody, /verifySalesOrderAuditCommercial\(/)
  assert.match(fnBody, /getSalesOrderAuditFinalizationStatus\(/)
  assert.match(fnBody, /\.eq\('status',\s*'IN_AUDIT'\)\s*\.select\('id,\s*status'\)\s*\.maybeSingle\(\)/)

  // Reglas estrictas Bloque 3A: NO finalizar automáticamente, NO alterar líneas/incidencias/evidencias, NO tocar otras tarjetas
  assert.doesNotMatch(fnBody, /finalize_sales_order_audit/)
  assert.doesNotMatch(fnBody, /finalizeSalesOrderAudit/)
  assert.doesNotMatch(fnBody, /reconcile_bodega_preparation_cards/)
  assert.doesNotMatch(fnBody, /sales_order_audit_lines[\s\S]*?\.update\(/)
  assert.doesNotMatch(fnBody, /sales_order_audit_incidents[\s\S]*?\.update\(/)
  assert.doesNotMatch(fnBody, /sales_order_audit_attachments[\s\S]*?\.delete\(/)
})

test('4. contratos UI Auditoría: tarjeta, drawer y enriquecimiento de board locks', () => {
  const cardSrc = read('src/modules/logistica/preparacion-pedidos/sales-order-card.tsx')
  const auditDrawerSrc = read('src/modules/logistica/auditoria/sales-order-audit-drawer.tsx')
  const auditActionSrc = read('src/app/actions/logistica/sales-order-audit.ts')

  assert.match(cardSrc, /isAuditCardBlockedForSync/)
  assert.match(cardSrc, /isAuditOwnedByOther/)
  assert.match(cardSrc, /onSyncAuditCard/)

  assert.match(auditDrawerSrc, /syncSalesOrderAuditCardFromBsale/)
  assert.match(auditDrawerSrc, /handleSyncAuditBsale/)
  assert.match(auditDrawerSrc, /REVISAR CIERRE/)

  assert.match(auditActionSrc, /open_audit_incident_count/)
  assert.match(auditActionSrc, /commercial_verification_status/)
})
