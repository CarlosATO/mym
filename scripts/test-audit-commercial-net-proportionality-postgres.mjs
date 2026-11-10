// Run after test-audit-commercial-acceptance-postgres.sql in a disposable database.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { planAuditCommercialAcceptance } from '../src/lib/logistica/audit-commercial-acceptance-plan.ts'

const host = process.env.AUDIT_TEST_PGHOST
const port = process.env.AUDIT_TEST_PGPORT
const database = process.env.AUDIT_TEST_PGDATABASE
if (!host?.startsWith('/') || !port || !database) throw new Error('Explicit disposable PostgreSQL socket, port and database required')

const cases = [
  { name: 'precio fraccionario, netos redondeados no proporcionales', oldQty: 3, newQty: 2, unit: 0.5, oldNet: 2, newNet: 1, oldTax: 0, newTax: 0, accepted: false },
  { name: 'cantidad fraccionaria, netos redondeados no proporcionales', oldQty: 1.5, newQty: 1, unit: 1, oldNet: 2, newNet: 1, oldTax: 0, newTax: 0, accepted: false },
  { name: 'cantidad fraccionaria proporcional', oldQty: 1.5, newQty: 1, unit: 10, oldNet: 15, newNet: 10, oldTax: 3, newTax: 2, accepted: true },
  { name: 'decimal no representable en binario proporcional', oldQty: 0.3, newQty: 0.2, unit: 10, oldNet: 3, newNet: 2, oldTax: 1, newTax: 0, accepted: true },
  { name: 'precio y cantidad fraccionarios proporcionales', oldQty: 2.4, newQty: 1.6, unit: 12.5, oldNet: 30, newNet: 20, oldTax: 6, newTax: 4, accepted: true },
]

for (const fixture of cases) test(`SQL y TypeScript: ${fixture.name}`, () => {
  const makeVersion = (quantity, net, tax, id) => ({
    identity: { canonicalToken: 'token', historicalBsaleId: 93141, currentBsaleId: id, folio: '5172' }, physicalId: id,
    lines: [{ detailId: 1, variantId: 1, sku: 'A', quantity, unitNetValue: fixture.unit, lineNetAmount: net, lineTaxAmount: tax, lineGrossAmount: net + tax }],
    sourceDetails: [{ id: 1, netDiscount: 0 }], netAmount: net, taxAmount: tax, totalAmount: net + tax,
  })
  const previous = makeVersion(fixture.oldQty, fixture.oldNet, fixture.oldTax, 93141)
  const current = makeVersion(fixture.newQty, fixture.newNet, fixture.newTax, 10)
  const taxEvidence = {
    canonicalToken: 'token', fetchedAt: '2026-11-10T12:00:00Z',
    tax: { id: 1, code: '14', percentage: 19, active: true, source: '/taxes/1.json' },
    previousDocument: { id: 93141, taxIds: [1], exemptAmount: 0, taxAmount: fixture.oldTax, source: '/documents/93141/document_taxes.json' },
    currentDocument: { id: 10, taxIds: [1], exemptAmount: 0, taxAmount: fixture.newTax, source: '/documents/10/document_taxes.json' },
    products: [{ variantId: 1, productId: 101, taxIds: [1], source: '/products/101/product_taxes.json' }],
  }
  const result = planAuditCommercialAcceptance({ previous, current, taxEvidence, auditedLines: [{ bsale_detail_id: 1, bsale_variant_id: 1, sku: 'A', product_name: 'A', audit_quantity: fixture.newQty }] })
  assert.equal(result.eligible, fixture.accepted, JSON.stringify(result.errors))
  if (!fixture.accepted) assert.ok(result.errors.includes('NET_AMOUNT_NOT_PROPORTIONAL'))

  const requestId = '00000000-0000-0000-0000-000000000006'
  const sql = `BEGIN;
    DELETE FROM logistica.sales_order_audit_commercial_acceptance_requests;
    DELETE FROM logistica.sales_order_preparation_commercial_versions WHERE sequence_no=2;
    SELECT logistica.fixture_request('${requestId}');
    DELETE FROM logistica.sales_order_audit_lines WHERE bsale_variant_id=2;
    UPDATE logistica.sales_order_audit_lines SET audit_quantity=${fixture.newQty}, prepared_quantity_snapshot=${fixture.newQty} WHERE bsale_variant_id=1;
    UPDATE logistica.sales_order_preparation_commercial_versions SET version_snapshot=$fixture$${JSON.stringify(previous)}$fixture$::jsonb WHERE sequence_no=1;
    UPDATE logistica.sales_order_audit_commercial_acceptance_requests SET version_snapshot=$fixture$${JSON.stringify({ ...current, taxEvidence })}$fixture$::jsonb || jsonb_build_object('auditPhysical', logistica.audit_commercial_physical_snapshot_v1('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003')) WHERE id='${requestId}';
    SELECT logistica.fixture_resign('${requestId}');
    DO $test$ BEGIN
      ${fixture.accepted
        ? `IF logistica.fixture_accept('${requestId}')->>'status' <> 'ACCEPTED' THEN RAISE EXCEPTION 'expected acceptance'; END IF;`
        : `BEGIN PERFORM logistica.fixture_accept('${requestId}'); RAISE EXCEPTION 'non-proportional net accepted'; EXCEPTION WHEN raise_exception THEN IF SQLERRM <> 'AUDIT_ACCEPTANCE_UNEXPLAINED_VALUE_CHANGE' THEN RAISE; END IF; END;`}
    END $test$;
    ROLLBACK;`
  const pg = spawnSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-h', host, '-p', port, '-d', database, '-c', sql], { encoding: 'utf8' })
  assert.equal(pg.status, 0, pg.stderr || pg.error?.message)
})
