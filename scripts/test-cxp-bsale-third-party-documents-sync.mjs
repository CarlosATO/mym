import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const repoRoot = path.resolve(__dirname, '..')

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('@/')) {
      const targetPath = path.join(repoRoot, 'src', specifier.slice(2))
      const withExt = fs.existsSync(`${targetPath}.ts`)
        ? `${targetPath}.ts`
        : targetPath
      return nextResolve(pathToFileURL(withExt).href, context)
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !path.extname(specifier) &&
      context.parentURL?.startsWith('file:')
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL))
      const candidateTs = path.resolve(parentDir, `${specifier}.ts`)
      if (fs.existsSync(candidateTs)) {
        return nextResolve(pathToFileURL(candidateTs).href, context)
      }
    }
    return nextResolve(specifier, context)
  },
})

const {
  CAYLO_COMPANY_ID,
  createSupabaseBsaleThirdPartyUpsertBatch,
  normalizeBsaleThirdPartyDocument,
  normalizeDocumentFolio,
  normalizeSupplierRut,
  parseBsaleSpecificTaxNumber,
  syncBsaleThirdPartyDocumentsForCaylo,
} = await import('../src/modules/cuentas-por-pagar/bsale-third-party-documents-sync.ts')

function loadEnvLocal() {
  const envPath = path.join(repoRoot, '.env.local')
  if (!fs.existsSync(envPath)) return
  const content = fs.readFileSync(envPath, 'utf8')
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eqIdx = trimmed.indexOf('=')
    if (eqIdx <= 0) continue
    const key = trimmed.slice(0, eqIdx).trim()
    let val = trimmed.slice(eqIdx + 1).trim()
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1)
    }
    if (!process.env[key]) {
      process.env[key] = val
    }
  }
}

function makeSampleRawDoc(overrides = {}) {
  return {
    href: 'https://api.bsale.io/v1/third_party_documents/9186.json',
    id: 9186,
    codeSii: '33',
    emissionDate: 1763596800, // Note: overridden in tests
    siiReceptionDate: 1763638654,
    type: 'buy',
    month: 3,
    year: 2026,
    number: 163496,
    clientCode: '76100687-8',
    clientActivity: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
    exemptAmount: 0,
    netAmount: 313597,
    ivaRate: 19,
    ivaAmount: 59583,
    ivaOutOfTime: 0,
    ivaNotRecoverable: 0,
    ivaAmountWithheld: 0,
    fixedAsset: 0,
    commissionTotalNet: 0,
    commissionTotalExempt: 0,
    commissionTotalIva: 0,
    specificTaxCode: '',
    specificTaxAmount: '',
    specificTaxRate: '',
    additionalTaxAmount: null,
    totalAmount: 373180,
    reportedSii: 1,
    thirdSii: 0,
    canceled: 0,
    addBook: 1,
    docsCount: 1,
    include: 0,
    siiInProgress: false,
    siiStatus: ['ACD', 'ERM'],
    liquidationCode: null,
    urlPdf: 'http://dte.bsale.cl/get_dte/pdf/9186?token=signed',
    urlXml: 'http://dte.bsale.cl/get_dte/xml/9186?token=signed',
    ...overrides,
  }
}

async function runUnitTests() {
  console.log('1. Pruebas unitarias de normalización, fechas, impuestos específicos y notas...')

  // 1.1 Normalización de RUT y folio
  assert.equal(normalizeSupplierRut('77.763.917-k'), '77763917K')
  assert.equal(normalizeSupplierRut(' 76100687-8 '), '761006878')
  assert.throws(() => normalizeSupplierRut('ABC-1'), /RUT de proveedor inválido/)

  assert.deepEqual(normalizeDocumentFolio('00163496'), {
    documentNumber: 163496,
    documentFolio: '163496',
  })
  assert.deepEqual(normalizeDocumentFolio(0), {
    documentNumber: 0,
    documentFolio: '0',
  })

  // 1.2 Impuestos específicos con guion final de Bsale
  assert.deepEqual(parseBsaleSpecificTaxNumber(''), { raw: null, numeric: null })
  assert.deepEqual(parseBsaleSpecificTaxNumber('76147.0-'), {
    raw: '76147.0-',
    numeric: 76147,
  })
  assert.deepEqual(parseBsaleSpecificTaxNumber('91.0-'), {
    raw: '91.0-',
    numeric: 91,
  })
  assert.deepEqual(parseBsaleSpecificTaxNumber('12.0-'), {
    raw: '12.0-',
    numeric: 12,
  })
  assert.deepEqual(parseBsaleSpecificTaxNumber('1500.0-2500.0-', 'sum'), {
    raw: '1500.0-2500.0-',
    numeric: 4000,
  })
  assert.deepEqual(parseBsaleSpecificTaxNumber('10.0-18.0-', 'single_or_null'), {
    raw: '10.0-18.0-',
    numeric: null,
  })

  // 1.3 Distinción estricta entre fecha de emisión y período tributario
  // id 8391: emitido 2025-12-18 (1766016000), pero registrado en libro 01/2026
  const dec18InJan2026Book = makeSampleRawDoc({
    id: 8391,
    number: 6259,
    clientCode: '77758871-0',
    clientActivity: 'MAYORISTA PETS SPA',
    emissionDate: 1766016000, // 2025-12-18 UTC
    month: 1,
    year: 2026,
    totalAmount: 2480234,
  })
  const dec18Outcome = normalizeBsaleThirdPartyDocument(dec18InJan2026Book)
  assert.equal(dec18Outcome.status, 'SKIPPED_BEFORE_CUTOFF')
  assert.equal(dec18Outcome.emissionDate, '2025-12-18')
  assert.equal(dec18Outcome.taxYear, 2026)
  assert.equal(dec18Outcome.taxMonth, 1)

  // id 8382: emitido 2025-12-31 (1767139200), en libro 01/2026
  const dec31InJan2026Book = makeSampleRawDoc({
    id: 8382,
    number: 3880635,
    clientCode: '92011000-2',
    clientActivity: 'EMPRESA NACIONAL DE ENERGIA ENEX S.A.',
    emissionDate: 1767139200, // 2025-12-31 UTC
    month: 1,
    year: 2026,
    specificTaxCode: '28-',
    specificTaxAmount: '76147.0-',
    specificTaxRate: '0.0-',
    totalAmount: 470152,
  })
  const dec31Outcome = normalizeBsaleThirdPartyDocument(dec31InJan2026Book)
  assert.equal(dec31Outcome.status, 'SKIPPED_BEFORE_CUTOFF')
  assert.equal(dec31Outcome.emissionDate, '2025-12-31')

  // Emitido 2026-01-01 (1767225600) -> elegible
  const jan01Doc = makeSampleRawDoc({
    id: 8402,
    codeSii: '33',
    number: 800051,
    clientCode: '77.269.430-6',
    clientActivity: 'DISTRIBUIDORA MAYORISTA DYL SPA',
    emissionDate: 1767225600, // 2026-01-01 UTC
    month: 1,
    year: 2026,
    netAmount: 156939,
    ivaAmount: 29818,
    specificTaxCode: '19-',
    specificTaxRate: '12.0-',
    specificTaxAmount: '91.0-',
    totalAmount: 186846,
  })
  const jan01Outcome = normalizeBsaleThirdPartyDocument(jan01Doc)
  assert.equal(jan01Outcome.status, 'ELIGIBLE')
  assert.equal(jan01Outcome.record.emission_date, '2026-01-01')
  assert.equal(jan01Outcome.record.issuer_rut_normalized, '772694306')
  assert.equal(jan01Outcome.record.specific_tax_code, '19-')
  assert.equal(jan01Outcome.record.specific_tax_rate_raw, '12.0-')
  assert.equal(jan01Outcome.record.specific_tax_rate, 12)
  assert.equal(jan01Outcome.record.specific_tax_amount_raw, '91.0-')
  assert.equal(jan01Outcome.record.specific_tax_amount, 91)
  assert.equal(jan01Outcome.record.total_amount, 186846)

  // 1.4 Factura exenta (34), Nota de crédito (61 con siiStatus: null y sin urlPdf/urlXml), Nota de débito (56)
  const exemptDoc = makeSampleRawDoc({
    id: 9016,
    codeSii: '34',
    number: 1387,
    clientCode: '76727539-0',
    clientActivity: 'ASESORIAS PROFESIONALES SPA',
    emissionDate: 1772668800, // 2026-03-05
    exemptAmount: 550000,
    netAmount: 0,
    ivaRate: 0,
    ivaAmount: 0,
    totalAmount: 550000,
    siiStatus: ['PAG', 'ERM'],
  })
  const exemptOutcome = normalizeBsaleThirdPartyDocument(exemptDoc)
  assert.equal(exemptOutcome.status, 'ELIGIBLE')
  assert.equal(exemptOutcome.record.code_sii, '34')
  assert.equal(exemptOutcome.record.exempt_amount, 550000)
  assert.deepEqual(exemptOutcome.record.sii_status, ['PAG', 'ERM'])

  const creditNoteWithoutLinks = makeSampleRawDoc({
    id: 9231,
    codeSii: '61',
    number: 7211,
    clientCode: '76100687-8',
    clientActivity: 'SOCIEDAD COMERCIAL MARBEN PETS LIMITADA',
    emissionDate: 1773964800, // 2026-03-20
    netAmount: 36324,
    ivaAmount: 6902,
    totalAmount: 43226,
    addBook: 0,
    include: 1,
    siiStatus: null,
  })
  delete creditNoteWithoutLinks.urlPdf
  delete creditNoteWithoutLinks.urlXml
  const creditNoteOutcome = normalizeBsaleThirdPartyDocument(creditNoteWithoutLinks)
  assert.equal(creditNoteOutcome.status, 'ELIGIBLE')
  assert.equal(creditNoteOutcome.record.code_sii, '61')
  assert.equal(creditNoteOutcome.record.sii_status, null)
  assert.equal(creditNoteOutcome.record.add_book, 0)
  assert.equal(creditNoteOutcome.record.include_flag, 1)
  assert.equal(creditNoteOutcome.record.url_pdf, null)
  assert.equal(creditNoteOutcome.record.url_xml, null)

  const debitNoteDoc = makeSampleRawDoc({
    id: 8913,
    codeSii: '56',
    number: 66064,
    clientCode: '76073164-1',
    clientActivity: 'PROVEEDOR ND SPA',
    emissionDate: 1771372800, // 2026-02-18
    netAmount: 10000,
    ivaAmount: 1900,
    totalAmount: 11900,
    siiStatus: null,
  })
  const debitNoteOutcome = normalizeBsaleThirdPartyDocument(debitNoteDoc)
  assert.equal(debitNoteOutcome.status, 'ELIGIBLE')
  assert.equal(debitNoteOutcome.record.code_sii, '56')
  assert.equal(debitNoteOutcome.record.sii_status, null)

  // 1.5 Paginación, deduplicación, UPSERT idempotente y detección de respuestas incompletas
  const page1Items = [
    dec18InJan2026Book,
    dec31InJan2026Book,
    jan01Doc,
  ]
  const page2Items = [
    exemptDoc,
    creditNoteWithoutLinks,
    debitNoteDoc,
    jan01Doc, // duplicado intencional entre páginas
  ]

  const inMemoryMirror = new Map()
  const mockUpsertBatch = async ({ companyId, documents, syncedAt }) => {
    let inserted = 0
    let updated = 0
    for (const doc of documents) {
      const key = `${companyId}:${doc.bsale_document_id}`
      const existing = inMemoryMirror.get(key)
      if (!existing) {
        inMemoryMirror.set(key, {
          ...doc,
          first_seen_at: syncedAt,
          last_seen_at: syncedAt,
          last_sync_at: syncedAt,
        })
        inserted++
      } else {
        inMemoryMirror.set(key, {
          ...doc,
          url_pdf: doc.url_pdf ?? existing.url_pdf,
          url_xml: doc.url_xml ?? existing.url_xml,
          first_seen_at: existing.first_seen_at,
          last_seen_at: syncedAt,
          last_sync_at: syncedAt,
        })
        updated++
      }
    }
    return {
      processed_count: inserted + updated,
      inserted_count: inserted,
      updated_count: updated,
      synced_at: syncedAt,
    }
  }

  const mockFetchPageSuccess = async ({ offset }) => {
    if (offset === 0) {
      return { count: 7, limit: 3, offset: 0, items: page1Items }
    }
    if (offset === 3) {
      return { count: 7, limit: 3, offset: 3, items: page2Items.slice(0, 3) }
    }
    return { count: 7, limit: 3, offset: 6, items: page2Items.slice(3) }
  }

  // Primera ejecución
  const firstRun = await syncBsaleThirdPartyDocumentsForCaylo({
    years: [2026],
    pageLimit: 3,
    upsertBatchSize: 2,
    syncedAt: '2026-11-23T10:00:00.000Z',
    fetchPage: mockFetchPageSuccess,
    upsertBatch: mockUpsertBatch,
  })

  assert.equal(firstRun.status, 'SUCCESS')
  assert.equal(firstRun.pagesFetched, 3)
  assert.equal(firstRun.totalReportedByBsale, 7)
  assert.equal(firstRun.totalFetchedRaw, 7)
  assert.equal(firstRun.uniqueDocumentsFetched, 6)
  assert.equal(firstRun.duplicateIdsSkipped, 1)
  assert.equal(firstRun.skippedBeforeCutoffCount, 2)
  assert.equal(firstRun.eligibleCount, 4)
  assert.equal(firstRun.eligibleInvoicesCount, 2)
  assert.equal(firstRun.eligibleNotesCount, 2)
  assert.deepEqual(firstRun.byCodeSii, { '33': 1, '34': 1, '61': 1, '56': 1 })
  assert.equal(firstRun.withSiiStatusNullCount, 2)
  assert.equal(firstRun.withoutUrlPdfCount, 1)
  assert.equal(firstRun.withSpecificTaxCount, 1)
  assert.equal(firstRun.upsertedInsertedCount, 4)
  assert.equal(firstRun.upsertedUpdatedCount, 0)
  assert.equal(inMemoryMirror.size, 4)

  // Segunda ejecución idempotente (sin duplicados y conservando first_seen_at)
  const secondRun = await syncBsaleThirdPartyDocumentsForCaylo({
    years: [2026],
    pageLimit: 3,
    upsertBatchSize: 2,
    syncedAt: '2026-11-23T10:05:00.000Z',
    fetchPage: mockFetchPageSuccess,
    upsertBatch: mockUpsertBatch,
  })
  assert.equal(secondRun.status, 'SUCCESS')
  assert.equal(secondRun.upsertedInsertedCount, 0)
  assert.equal(secondRun.upsertedUpdatedCount, 4)
  assert.equal(inMemoryMirror.size, 4)
  const mirrored8402 = inMemoryMirror.get(`${CAYLO_COMPANY_ID}:8402`)
  assert.equal(mirrored8402.first_seen_at, '2026-11-23T10:00:00.000Z')
  assert.equal(mirrored8402.last_sync_at, '2026-11-23T10:05:00.000Z')

  // 1.6 Respuesta incompleta / truncada: no elimina documentos existentes y marca INCOMPLETE_RESPONSE
  const truncatedRun = await syncBsaleThirdPartyDocumentsForCaylo({
    years: [2026],
    pageLimit: 3,
    fetchPage: async ({ offset }) => {
      if (offset === 0) {
        // Reporta count: 10 pero devuelve solo 2 elementos en la primera página
        return { count: 10, limit: 3, offset: 0, items: [jan01Doc, exemptDoc] }
      }
      return { count: 10, limit: 3, offset, items: [] }
    },
    upsertBatch: mockUpsertBatch,
  })
  assert.equal(truncatedRun.status, 'INCOMPLETE_RESPONSE')
  assert.equal(truncatedRun.incompleteResponseDetected, true)
  assert.equal(truncatedRun.errors.length, 1)
  assert.equal(truncatedRun.errors[0].phase, 'PAGINATION_INTEGRITY')
  assert.equal(inMemoryMirror.size, 4, 'No debe eliminar documentos existentes ante respuesta incompleta')

  // 1.7 Rechazo de empresa distinta de Caylo
  await assert.rejects(
    () =>
      syncBsaleThirdPartyDocumentsForCaylo({
        companyId: 'd3000000-0000-0000-0000-000000000003',
        dryRun: true,
      }),
    /exclusivamente a Caylo/
  )

  console.log('   ✓ Pruebas unitarias y de paginación/idempotencia completadas.')
}

async function runPostgresMigrationTest(pgConnectionString) {
  console.log('2. Verificando migración PostgreSQL, RPC atómica, RLS y protección contra DELETE...')
  const client = new pg.Client({ connectionString: pgConnectionString })
  await client.connect()

  try {
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN;
        END IF;
      END
      $$;

      CREATE SCHEMA IF NOT EXISTS auth;
      CREATE SCHEMA IF NOT EXISTS core;
      CREATE SCHEMA IF NOT EXISTS portal;
      CREATE SCHEMA IF NOT EXISTS cuentas_por_pagar;

      GRANT USAGE ON SCHEMA core, portal, cuentas_por_pagar TO authenticated, service_role;

      CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
      LANGUAGE sql STABLE AS $fn$
        SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $fn$;

      CREATE TABLE IF NOT EXISTS core.companies (
        id uuid PRIMARY KEY,
        name text NOT NULL
      );
      INSERT INTO core.companies (id, name)
      VALUES ('d1000000-0000-0000-0000-000000000001', 'Caylo')
      ON CONFLICT (id) DO NOTHING;

      CREATE TABLE IF NOT EXISTS portal.roles (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS portal.users (
        id uuid PRIMARY KEY,
        role_id uuid NOT NULL REFERENCES portal.roles(id),
        is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE IF NOT EXISTS core.user_company_access (
        user_id uuid NOT NULL,
        company_id uuid NOT NULL,
        PRIMARY KEY (user_id, company_id)
      );

      CREATE OR REPLACE FUNCTION core.has_company_access(p_user_id uuid, p_company_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
        SELECT EXISTS (
          SELECT 1 FROM core.user_company_access
          WHERE user_id = p_user_id AND company_id = p_company_id
        );
      $fn$;

      CREATE OR REPLACE FUNCTION cuentas_por_pagar.can_access(p_company_id uuid)
      RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $fn$
        SELECT p_company_id = 'd1000000-0000-0000-0000-000000000001'::uuid
           AND core.has_company_access(auth.uid(), p_company_id)
           AND EXISTS (
             SELECT 1 FROM portal.users u
             JOIN portal.roles r ON r.id = u.role_id
             WHERE u.id = auth.uid()
               AND u.is_active = true
               AND r.is_active = true
               AND r.name IN ('SUPER_USUARIO', 'GERENCIA', 'FINANZAS')
           );
      $fn$;
      GRANT EXECUTE ON FUNCTION cuentas_por_pagar.can_access(uuid) TO authenticated, service_role;

      INSERT INTO portal.roles (id, name, is_active) VALUES
        ('11111111-1111-1111-1111-111111111111', 'FINANZAS', true),
        ('22222222-2222-2222-2222-222222222222', 'BODEGA', true)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO portal.users (id, role_id, is_active) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '11111111-1111-1111-1111-111111111111', true),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', '22222222-2222-2222-2222-222222222222', true)
      ON CONFLICT (id) DO NOTHING;

      INSERT INTO core.user_company_access (user_id, company_id) VALUES
        ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'd1000000-0000-0000-0000-000000000001'),
        ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'd1000000-0000-0000-0000-000000000001')
      ON CONFLICT DO NOTHING;
    `)

    const migrationSql = fs.readFileSync(
      path.join(
        repoRoot,
        'supabase/migrations/20261123133636_integraciones_bsale_third_party_documents.sql'
      ),
      'utf8'
    )
    await client.query(migrationSql)
    await client.query(`GRANT USAGE ON SCHEMA integraciones TO anon, authenticated, service_role;`)

    const sampleOutcome1 = normalizeBsaleThirdPartyDocument(
      makeSampleRawDoc({
        id: 9186,
        codeSii: '33',
        number: 163496,
        emissionDate: 1773792000, // 2026-03-18
      })
    )
    const sampleOutcome2 = normalizeBsaleThirdPartyDocument(
      makeSampleRawDoc({
        id: 9231,
        codeSii: '61',
        number: 7211,
        emissionDate: 1773964800, // 2026-03-20
        addBook: 0,
        include: 1,
        siiStatus: null,
        urlPdf: null,
        urlXml: null,
      })
    )
    assert.equal(sampleOutcome1.status, 'ELIGIBLE')
    assert.equal(sampleOutcome2.status, 'ELIGIBLE')

    // UPSERT inicial ejecutado explícitamente bajo rol service_role
    await client.query(`BEGIN`)
    await client.query(`SET LOCAL ROLE service_role`)
    await client.query(
      `SELECT set_config('request.jwt.claim.role', 'service_role', true)`
    )
    const upsert1 = await client.query(
      `SELECT integraciones.upsert_bsale_third_party_documents_sync($1::uuid, $2::jsonb, $3::timestamptz) AS res`,
      [
        CAYLO_COMPANY_ID,
        JSON.stringify([sampleOutcome1.record, sampleOutcome2.record]),
        '2026-11-23T10:00:00Z',
      ]
    )
    await client.query(`COMMIT`)
    assert.equal(upsert1.rows[0].res.processed_count, 2)
    assert.equal(upsert1.rows[0].res.inserted_count, 2)
    assert.equal(upsert1.rows[0].res.updated_count, 0)

    // Re-ejecución idempotente (UPSERT update) bajo rol service_role
    const updatedDoc1 = {
      ...sampleOutcome1.record,
      url_pdf: null, // Verifica que COALESCE conserve el enlace firmado existente si luego viene omitido
    }
    await client.query(`BEGIN`)
    await client.query(`SET LOCAL ROLE service_role`)
    await client.query(
      `SELECT set_config('request.jwt.claim.role', 'service_role', true)`
    )
    const upsert2 = await client.query(
      `SELECT integraciones.upsert_bsale_third_party_documents_sync($1::uuid, $2::jsonb, $3::timestamptz) AS res`,
      [
        CAYLO_COMPANY_ID,
        JSON.stringify([updatedDoc1, sampleOutcome2.record]),
        '2026-11-23T10:10:00Z',
      ]
    )
    await client.query(`COMMIT`)
    assert.equal(upsert2.rows[0].res.processed_count, 2)
    assert.equal(upsert2.rows[0].res.inserted_count, 0)
    assert.equal(upsert2.rows[0].res.updated_count, 2)

    // Verificar que el servicio de sincronización funciona con createSupabaseBsaleThirdPartyUpsertBatch usando cliente service_role
    const serviceRoleAdapter = {
      schema(schemaName) {
        assert.equal(schemaName, 'integraciones')
        return {
          async rpc(fnName, args) {
            await client.query(`BEGIN`)
            try {
              await client.query(`SET LOCAL ROLE service_role`)
              await client.query(
                `SELECT set_config('request.jwt.claim.role', 'service_role', true)`
              )
              const rpcRes = await client.query(
                `SELECT integraciones.${fnName}($1::uuid, $2::jsonb, $3::timestamptz) AS data`,
                [args.p_company_id, JSON.stringify(args.p_documents), args.p_synced_at]
              )
              await client.query(`COMMIT`)
              return { data: rpcRes.rows[0].data, error: null }
            } catch (err) {
              await client.query(`ROLLBACK`)
              return { data: null, error: { message: err.message } }
            }
          },
        }
      },
    }

    const serviceSyncViaServiceRole = await syncBsaleThirdPartyDocumentsForCaylo({
      years: [2026],
      syncedAt: '2026-11-23T10:12:00Z',
      fetchPage: async () => ({
        count: 2,
        limit: 50,
        offset: 0,
        items: [sampleOutcome1.record.raw_json, sampleOutcome2.record.raw_json],
      }),
      upsertBatch: createSupabaseBsaleThirdPartyUpsertBatch(serviceRoleAdapter),
    })
    assert.equal(serviceSyncViaServiceRole.status, 'SUCCESS')
    assert.equal(serviceSyncViaServiceRole.upsertedProcessedCount, 2)
    assert.equal(serviceSyncViaServiceRole.upsertedInsertedCount, 0)
    assert.equal(serviceSyncViaServiceRole.upsertedUpdatedCount, 2)

    // Verificar estado persistido en tabla
    const checkRows = await client.query(
      `SELECT bsale_document_id, code_sii, document_folio, issuer_rut_normalized, sii_status, add_book, include_flag, url_pdf, first_seen_at, last_sync_at
       FROM integraciones.bsale_third_party_documents
       ORDER BY bsale_document_id`
    )
    assert.equal(checkRows.rowCount, 2)
    assert.deepEqual(checkRows.rows[0].sii_status, ['ACD', 'ERM'])
    assert.equal(
      checkRows.rows[0].url_pdf,
      'http://dte.bsale.cl/get_dte/pdf/9186?token=signed'
    )
    assert.equal(checkRows.rows[1].sii_status, null)
    assert.equal(checkRows.rows[1].add_book, 0)
    assert.equal(checkRows.rows[1].include_flag, 1)
    assert.equal(
      new Date(checkRows.rows[0].first_seen_at).toISOString(),
      '2026-11-23T10:00:00.000Z'
    )
    assert.equal(
      new Date(checkRows.rows[0].last_sync_at).toISOString(),
      '2026-11-23T10:12:00.000Z'
    )

    // Verificar que no se pueden eliminar documentos sincronizados
    await assert.rejects(
      () =>
        client.query(
          `DELETE FROM integraciones.bsale_third_party_documents WHERE bsale_document_id = 9186`
        ),
      /no pueden eliminarse/
    )

    // CRÍTICO: Verificar que un usuario authenticated CON permisos de Cuentas por Pagar (FINANZAS en Caylo)
    // NO puede ejecutar upsert_bsale_third_party_documents_sync para insertar o modificar documentos del espejo
    await client.query(`BEGIN`)
    await client.query(`SET LOCAL ROLE authenticated`)
    await client.query(
      `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`
    )
    await client.query(
      `SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true)`
    )
    await assert.rejects(
      () =>
        client.query(
          `SELECT integraciones.upsert_bsale_third_party_documents_sync($1::uuid, $2::jsonb, $3::timestamptz)`,
          [
            CAYLO_COMPANY_ID,
            JSON.stringify([sampleOutcome1.record]),
            '2026-11-23T10:15:00Z',
          ]
        ),
      /permission denied for function upsert_bsale_third_party_documents_sync/
    )
    await client.query(`ROLLBACK`)

    // Defensa en profundidad: incluso si el cuerpo de la función se evaluara con request.jwt.claim.role = 'authenticated',
    // la validación interna de v_invoker_role rechaza cualquier rol distinto de service_role/postgres
    await client.query(`BEGIN`)
    await client.query(
      `SELECT set_config('role', 'authenticated', true)`
    )
    await client.query(
      `SELECT set_config('request.jwt.claim.role', 'authenticated', true)`
    )
    await client.query(
      `SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true)`
    )
    await assert.rejects(
      () =>
        client.query(
          `SELECT integraciones.upsert_bsale_third_party_documents_sync($1::uuid, $2::jsonb, $3::timestamptz)`,
          [
            CAYLO_COMPANY_ID,
            JSON.stringify([sampleOutcome1.record]),
            '2026-11-23T10:15:00Z',
          ]
        ),
      /permission denied for function upsert_bsale_third_party_documents_sync/
    )
    await client.query(`ROLLBACK`)

    // Verificar restricción de acceso directo a la tabla para usuario no autorizado (BODEGA)
    await client.query(`BEGIN`)
    await client.query(`SET LOCAL ROLE authenticated`)
    await client.query(
      `SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true)`
    )
    await assert.rejects(
      () =>
        client.query(`SELECT * FROM integraciones.bsale_third_party_documents`),
      /permission denied/
    )
    await client.query(`ROLLBACK`)

    // Verificar restricción de acceso a enlaces firmados para usuario no autorizado (BODEGA)
    await client.query(`BEGIN`)
    await client.query(`SET LOCAL ROLE authenticated`)
    await client.query(
      `SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true)`
    )
    await assert.rejects(
      () =>
        client.query(
          `SELECT integraciones.get_bsale_third_party_document_signed_links($1::uuid, 9186)`,
          [CAYLO_COMPANY_ID]
        ),
      /Acceso denegado/
    )
    await client.query(`ROLLBACK`)

    // Verificar que usuario FINANZAS de Caylo sí puede consultar enlaces mediante la RPC controlada
    await client.query(`BEGIN`)
    await client.query(`SET LOCAL ROLE authenticated`)
    await client.query(
      `SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', true)`
    )
    const linksRes = await client.query(
      `SELECT integraciones.get_bsale_third_party_document_signed_links($1::uuid, 9186) AS links`,
      [CAYLO_COMPANY_ID]
    )
    assert.equal(
      linksRes.rows[0].links.url_pdf,
      'http://dte.bsale.cl/get_dte/pdf/9186?token=signed'
    )
    await client.query(`ROLLBACK`)

    console.log('   ✓ Migración PostgreSQL, UPSERT idempotente, RLS y protección de enlaces verificados.')
  } finally {
    await client.end()
  }
}

async function runLiveDryRunValidation(disposablePgUrl = null) {
  console.log('3. Validación dry-run en solo lectura contra Bsale Caylo (año 2026)...')
  loadEnvLocal()

  const summary = await syncBsaleThirdPartyDocumentsForCaylo({
    years: [2026],
    dryRun: true,
  })

  console.log(
    JSON.stringify(
      {
        status: summary.status,
        pagesFetched: summary.pagesFetched,
        totalReportedByBsale: summary.totalReportedByBsale,
        totalFetchedRaw: summary.totalFetchedRaw,
        uniqueDocumentsFetched: summary.uniqueDocumentsFetched,
        duplicateIdsSkipped: summary.duplicateIdsSkipped,
        skippedBeforeCutoffCount: summary.skippedBeforeCutoffCount,
        skippedUnsupportedCodeSiiCount: summary.skippedUnsupportedCodeSiiCount,
        invalidCount: summary.invalidCount,
        eligibleCount: summary.eligibleCount,
        eligibleInvoicesCount: summary.eligibleInvoicesCount,
        eligibleNotesCount: summary.eligibleNotesCount,
        byCodeSii: summary.byCodeSii,
        withSiiStatusNullCount: summary.withSiiStatusNullCount,
        withUrlPdfCount: summary.withUrlPdfCount,
        withoutUrlPdfCount: summary.withoutUrlPdfCount,
        withUrlXmlCount: summary.withUrlXmlCount,
        withoutUrlXmlCount: summary.withoutUrlXmlCount,
        withSpecificTaxCount: summary.withSpecificTaxCount,
        errorsCount: summary.errors.length,
        errors: summary.errors,
      },
      null,
      2
    )
  )

  assert.equal(summary.status, 'SUCCESS')
  assert.equal(summary.incompleteResponseDetected, false)
  assert.equal(summary.errors.length, 0)
  assert.equal(summary.totalReportedByBsale, 849)
  assert.equal(summary.skippedBeforeCutoffCount, 2)
  assert.equal(summary.eligibleCount, 847)
  assert.equal(summary.eligibleInvoicesCount, 777)
  assert.equal(summary.eligibleNotesCount, 70)
  assert.deepEqual(summary.byCodeSii, {
    '33': 747,
    '34': 30,
    '61': 68,
    '56': 2,
  })

  if (disposablePgUrl) {
    console.log('4. Verificando UPSERT real de los 847 documentos bajo service_role en la instancia PostgreSQL local efímera...')
    const client = new pg.Client({ connectionString: disposablePgUrl })
    await client.connect()
    try {
      await client.query(`BEGIN`)
      await client.query(`SET LOCAL ROLE service_role`)
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'service_role', true)`
      )
      const batchRes1 = await client.query(
        `SELECT integraciones.upsert_bsale_third_party_documents_sync($1::uuid, $2::jsonb, $3::timestamptz) AS res`,
        [CAYLO_COMPANY_ID, JSON.stringify(summary.records), '2026-11-23T10:15:00Z']
      )
      await client.query(`COMMIT`)
      assert.equal(batchRes1.rows[0].res.processed_count, 847)
      // 2 documentos de muestra (9186 y 9231) ya habían sido insertados en el paso 2
      assert.equal(
        batchRes1.rows[0].res.inserted_count + batchRes1.rows[0].res.updated_count,
        847
      )

      // Re-ejecución completa idempotente de los 847 documentos bajo service_role
      await client.query(`BEGIN`)
      await client.query(`SET LOCAL ROLE service_role`)
      await client.query(
        `SELECT set_config('request.jwt.claim.role', 'service_role', true)`
      )
      const batchRes2 = await client.query(
        `SELECT integraciones.upsert_bsale_third_party_documents_sync($1::uuid, $2::jsonb, $3::timestamptz) AS res`,
        [CAYLO_COMPANY_ID, JSON.stringify(summary.records), '2026-11-23T10:20:00Z']
      )
      await client.query(`COMMIT`)
      assert.equal(batchRes2.rows[0].res.processed_count, 847)
      assert.equal(batchRes2.rows[0].res.inserted_count, 0)
      assert.equal(batchRes2.rows[0].res.updated_count, 847)

      const countRes = await client.query(`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE code_sii IN ('33', '34'))::int AS invoices,
          count(*) FILTER (WHERE code_sii IN ('61', '56'))::int AS notes,
          count(*) FILTER (WHERE sii_status IS NULL)::int AS sii_status_null,
          count(*) FILTER (WHERE specific_tax_amount IS NOT NULL AND specific_tax_amount > 0)::int AS with_specific_tax
        FROM integraciones.bsale_third_party_documents
      `)
      assert.equal(countRes.rows[0].total, 847)
      assert.equal(countRes.rows[0].invoices, 777)
      assert.equal(countRes.rows[0].notes, 70)
      console.log('   ✓ Los 847 documentos reales de 2026 pasaron todas las restricciones SQL e idempotencia UPSERT en PostgreSQL local efímero:', countRes.rows[0])
    } finally {
      await client.end()
    }
  }

  console.log('   ✓ Dry-run 2026 verificado: 849 leídos -> 2 emitidos en dic-2025 excluidos -> 847 elegibles (777 facturas y 70 notas).')
}

async function runWithDisposablePostgres(includeLiveDryRun = false) {
  const pgBinDir = '/opt/homebrew/opt/postgresql@15/bin'
  const initdbBin = path.join(pgBinDir, 'initdb')
  const pgCtlBin = path.join(pgBinDir, 'pg_ctl')
  const createdbBin = path.join(pgBinDir, 'createdb')
  const tmpDir = '/tmp/pg_cxp_bsale_third_party_test'
  const port = 55439

  fs.rmSync(tmpDir, { recursive: true, force: true })
  execFileSync(initdbBin, ['-D', tmpDir, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], {
    stdio: 'ignore',
  })

  try {
    execFileSync(
      pgCtlBin,
      ['-D', tmpDir, '-l', path.join(tmpDir, 'logfile'), '-o', `-p ${port} -k ${tmpDir}`, 'start'],
      { stdio: 'ignore' }
    )
    execFileSync(createdbBin, ['-h', tmpDir, '-p', String(port), '-U', 'postgres', 'cxp_bsale_test'], {
      stdio: 'ignore',
    })
    const pgUrl = `postgresql://postgres@localhost:${port}/cxp_bsale_test?host=${tmpDir}`
    await runPostgresMigrationTest(pgUrl)
    if (includeLiveDryRun) {
      await runLiveDryRunValidation(pgUrl)
    }
  } finally {
    try {
      execFileSync(pgCtlBin, ['-D', tmpDir, 'stop', '-m', 'immediate'], { stdio: 'ignore' })
    } catch {
      // ignore
    }
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}

async function main() {
  await runUnitTests()

  const includeLiveDryRun = process.argv.includes('--live-dry-run')

  if (process.env.PG_TEST_URL) {
    await runPostgresMigrationTest(process.env.PG_TEST_URL)
    if (includeLiveDryRun) {
      await runLiveDryRunValidation(process.env.PG_TEST_URL)
    }
  } else if (process.argv.includes('--with-disposable-pg')) {
    await runWithDisposablePostgres(includeLiveDryRun)
  } else if (includeLiveDryRun) {
    await runLiveDryRunValidation(null)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
