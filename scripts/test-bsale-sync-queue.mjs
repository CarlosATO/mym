import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import { registerHooks } from 'node:module'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'
import ts from 'typescript'

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MOCK_AUTH_STATE = {
  cookieSessionAvailable: false,
  currentUserId: null,
  activeCompanyId: null,
  createSupabase: createSupabaseJsClient,
}

// Resolver @/* y extensiones .ts para importar y ejecutar las acciones REALES del ERP
// (bsale-sync.ts, sales-order-preparation-incident-sync.ts, bsale-sync-queue-runtime.ts)
// sin requerir empaquetador y simulando ausencia de sesión activa de navegador cuando corresponde.
const mockServerUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function createClient() {
  const state = globalThis.__BSALE_SYNC02_TEST_AUTH__
  if (!state || !state.cookieSessionAvailable) {
    throw new Error('NO_BROWSER_SESSION_COOKIES_AVAILABLE')
  }
  const client = state.createSupabase(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    db: { schema: 'portal' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
  client.auth.getUser = async () => ({
    data: { user: state.currentUserId ? { id: state.currentUserId, email: 'op@mym.cl' } : null },
    error: null,
  })
  return client
}
`)

const mockCompaniesUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function getActiveCompanyId() {
  return globalThis.__BSALE_SYNC02_TEST_AUTH__?.activeCompanyId ?? null
}
`)

const mockNextCacheUrl = 'data:text/javascript,' + encodeURIComponent(`
export function revalidatePath() {}
export function revalidateTag() {}
`)

const mockNextHeadersUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function cookies() {
  throw new Error('NO_BROWSER_SESSION_COOKIES_AVAILABLE')
}
`)

function resolveTsFileCandidate(basePath) {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    path.join(basePath, 'index.ts'),
  ]
  for (const cand of candidates) {
    try {
      if (statSync(cand).isFile()) return pathToFileURL(cand).href
    } catch {
      // candidate does not exist
    }
  }
  return null
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@/lib/supabase/server') {
      return { url: mockServerUrl, shortCircuit: true }
    }
    if (specifier === '@/app/actions/companies') {
      return { url: mockCompaniesUrl, shortCircuit: true }
    }
    if (specifier === 'next/cache') {
      return { url: mockNextCacheUrl, shortCircuit: true }
    }
    if (specifier === 'next/headers') {
      return { url: mockNextHeadersUrl, shortCircuit: true }
    }
    if (specifier.startsWith('@/')) {
      const target = path.join(PROJECT_ROOT, 'src', specifier.slice(2))
      const resolved = resolveTsFileCandidate(target)
      if (resolved) return { url: resolved, shortCircuit: true }
    }
    if (
      (specifier.startsWith('./') || specifier.startsWith('../'))
      && context.parentURL?.startsWith('file:')
      && !context.parentURL.includes('/node_modules/')
    ) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL))
      const target = path.resolve(parentDir, specifier)
      if (!path.extname(target)) {
        const resolved = resolveTsFileCandidate(target)
        if (resolved) return { url: resolved, shortCircuit: true }
      }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file:') && !url.includes('/node_modules/') && (url.endsWith('.ts') || url.endsWith('.tsx'))) {
      const filePath = fileURLToPath(url)
      const source = readFileSync(filePath, 'utf8')
      const out = ts.transpileModule(source, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
        },
      })
      return { format: 'module', source: out.outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

globalThis.__BSALE_SYNC02_TEST_AUTH__ = MOCK_AUTH_STATE

const { Pool } = pg

const COMPANY_CAYLO = 'd1000000-0000-0000-0000-000000000001'
const COMPANY_AMIMASCOTA = 'd3000000-0000-0000-0000-000000000003'
const COMPANY_INDEPENDENT = 'd4000000-0000-0000-0000-000000000004'
const USER_PREP = '11111111-1111-4111-8111-111111111111'
const USER_AUDITOR = '22222222-2222-4222-8222-222222222222'
const USER_OTHER_AUDITOR = '33333333-3333-4333-8333-333333333333'
const CARD_PREP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CARD_INCIDENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'
const CARD_AUDIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const INCIDENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1'
const AUDIT_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'

const PG15_BIN = '/opt/homebrew/opt/postgresql@15/bin'

function startIsolatedPostgres15() {
  const dataDir = mkdtempSync('/tmp/pg15-sync02-')
  const socketDir = mkdtempSync('/tmp/pg15-sock-')
  const port = 55400 + Math.floor(Math.random() * 400)

  execFileSync(path.join(PG15_BIN, 'initdb'), [
    '-D', dataDir,
    '-U', 'postgres',
    '-A', 'trust',
    '--encoding=UTF8',
    '--no-locale',
  ], { stdio: 'ignore' })

  const pgOptions = `-k ${socketDir} -p ${port} -c listen_addresses=`
  execFileSync(path.join(PG15_BIN, 'pg_ctl'), [
    '-D', dataDir,
    '-l', path.join(dataDir, 'postgres.log'),
    '-o', pgOptions,
    '-w',
    'start',
  ], { stdio: 'ignore' })

  const pool = new Pool({
    host: socketDir,
    port,
    user: 'postgres',
    database: 'postgres',
    max: 16,
  })

  const stop = async () => {
    await pool.end().catch(() => {})
    try {
      execFileSync(path.join(PG15_BIN, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', 'stop'], { stdio: 'ignore' })
    } catch {
      // ignore cleanup
    }
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(socketDir, { recursive: true, force: true })
  }

  return { pool, port, stop }
}

/**
 * Servidor HTTP local en memoria para @supabase/supabase-js (PostgREST mínimo sobre pg.Pool)
 * y para Bsale API simulada (registrando cada método HTTP y ruta solicitada).
 */
async function startLocalPostgrestAndBsaleServers(pool) {
  const bsaleCalls = []

  function buildWhereClause(searchParams, values) {
    const clauses = []
    for (const [key, rawVal] of searchParams.entries()) {
      if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue
      if (!/^[a-zA-Z0-9_]+$/.test(key)) continue
      if (rawVal.startsWith('eq.')) {
        values.push(rawVal.slice(3))
        clauses.push(`${key} = $${values.length}`)
      } else if (rawVal.startsWith('lt.')) {
        values.push(rawVal.slice(3))
        clauses.push(`${key} < $${values.length}`)
      } else if (rawVal.startsWith('gt.')) {
        values.push(rawVal.slice(3))
        clauses.push(`${key} > $${values.length}`)
      } else if (rawVal === 'is.null') {
        clauses.push(`${key} IS NULL`)
      } else if (rawVal === 'not.is.null') {
        clauses.push(`${key} IS NOT NULL`)
      } else if (rawVal.startsWith('in.(') && rawVal.endsWith(')')) {
        const inner = rawVal.slice(4, -1).split(',').map(s => s.replace(/^"|"$/g, '')).filter(Boolean)
        values.push(inner)
        clauses.push(`${key}::text = ANY($${values.length}::text[])`)
      } else if (rawVal.startsWith('not.in.(') && rawVal.endsWith(')')) {
        const inner = rawVal.slice(8, -1).split(',').map(s => s.replace(/^"|"$/g, '')).filter(Boolean)
        values.push(inner)
        clauses.push(`NOT (${key}::text = ANY($${values.length}::text[]))`)
      }
    }
    return clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
  }

  const supabaseServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const chunks = []
      for await (const ch of req) chunks.push(ch)
      const bodyStr = Buffer.concat(chunks).toString('utf8')
      const bodyJson = bodyStr ? JSON.parse(bodyStr) : {}

      const schemaHeader = req.method === 'GET' || req.method === 'HEAD'
        ? (req.headers['accept-profile'] || 'public')
        : (req.headers['content-profile'] || req.headers['accept-profile'] || 'public')
      const schema = String(schemaHeader)
      const accept = String(req.headers['accept'] || '')
      const prefer = String(req.headers['prefer'] || '')
      const wantsSingle = accept.includes('application/vnd.pgrst.object+json')

      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fnName = url.pathname.slice('/rest/v1/rpc/'.length)
        const entries = Object.entries(bodyJson ?? {})
        const argsSql = entries.map(([k], idx) => `${k} := $${idx + 1}`).join(', ')
        const vals = entries.map(([k, v]) => {
          if (v === null || typeof v !== 'object') return v
          if (!Array.isArray(v)) return JSON.stringify(v)
          if (k === 'p_details' || v.some(el => el !== null && typeof el === 'object')) {
            return JSON.stringify(v)
          }
          return v
        })
        const q = `SELECT ${schema}.${fnName}(${argsSql}) AS result`
        const queryRes = await pool.query(q, vals)
        const out = queryRes.rows[0]?.result ?? null
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(out))
        return
      }

      if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.slice('/rest/v1/'.length)
        if (req.method === 'GET' || req.method === 'HEAD') {
          const vals = []
          const whereSql = buildWhereClause(url.searchParams, vals)
          const orderParam = url.searchParams.get('order')
          let orderSql = ''
          if (orderParam) {
            const [col, dir] = orderParam.split('.')
            if (/^[a-zA-Z0-9_]+$/.test(col)) {
              orderSql = `ORDER BY ${col} ${dir === 'desc' ? 'DESC' : 'ASC'}`
            }
          }
          const limitParam = url.searchParams.get('limit')
          const limitSql = limitParam ? `LIMIT ${Number(limitParam)}` : ''

          const countRequested = prefer.includes('count=exact')
          const queryRes = await pool.query(`SELECT * FROM ${schema}.${table} ${whereSql} ${orderSql} ${limitSql}`, vals)
          const headers = { 'Content-Type': 'application/json' }
          if (countRequested) {
            headers['Content-Range'] = `0-${Math.max(0, queryRes.rows.length - 1)}/${queryRes.rows.length}`
          }
          if (req.method === 'HEAD') {
            res.writeHead(200, headers)
            res.end()
            return
          }
          if (wantsSingle) {
            if (queryRes.rows.length === 0) {
              res.writeHead(406, headers)
              res.end(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned' }))
              return
            }
            res.writeHead(200, headers)
            res.end(JSON.stringify(queryRes.rows[0]))
            return
          }
          res.writeHead(200, headers)
          res.end(JSON.stringify(queryRes.rows))
          return
        }

        if (req.method === 'POST') {
          const rowsToInsert = Array.isArray(bodyJson) ? bodyJson : [bodyJson]
          const cols = Object.keys(rowsToInsert[0] ?? {})
          const onConflict = url.searchParams.get('on_conflict')
          const inserted = []
          for (const item of rowsToInsert) {
            const vals = cols.map(c => {
              const v = item[c]
              return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
            })
            const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ')
            let conflictSql = ''
            if (onConflict && prefer.includes('resolution=merge-duplicates')) {
              const conflictCols = onConflict.split(',').map(s => s.trim()).join(', ')
              const updates = cols.map(c => `${c} = EXCLUDED.${c}`).join(', ')
              conflictSql = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updates}`
            }
            const r = await pool.query(
              `INSERT INTO ${schema}.${table} (${cols.join(', ')}) VALUES (${placeholders}) ${conflictSql} RETURNING *`,
              vals,
            )
            inserted.push(...r.rows)
          }
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(wantsSingle ? (inserted[0] ?? null) : inserted))
          return
        }

        if (req.method === 'PATCH') {
          const cols = Object.keys(bodyJson ?? {})
          const vals = cols.map(c => {
            const v = bodyJson[c]
            return (v !== null && typeof v === 'object') ? JSON.stringify(v) : v
          })
          const setSql = cols.map((c, idx) => `${c} = $${idx + 1}`).join(', ')
          const whereSql = buildWhereClause(url.searchParams, vals)
          const r = await pool.query(`UPDATE ${schema}.${table} SET ${setSql} ${whereSql} RETURNING *`, vals)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(wantsSingle ? (r.rows[0] ?? null) : r.rows))
          return
        }

        if (req.method === 'DELETE') {
          const vals = []
          const whereSql = buildWhereClause(url.searchParams, vals)
          const r = await pool.query(`DELETE FROM ${schema}.${table} ${whereSql} RETURNING *`, vals)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(wantsSingle ? (r.rows[0] ?? null) : r.rows))
          return
        }
      }

      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: `Not found: ${url.pathname}` }))
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: err instanceof Error ? err.message : String(err) }))
    }
  })

  const makeNvDoc = (id, number, token) => ({
    id,
    number,
    token,
    documentTypeId: 23,
    document_type: { id: 23 },
    state: 0,
    emissionDate: 1763942400,
    generationDate: 1763942400,
    totalAmount: 11900,
    netAmount: 10000,
    taxAmount: 1900,
    exemptAmount: 0,
    client: { id: 501 },
    office: { id: 1 },
    details: {
      count: 1,
      items: [
        {
          id: id * 10 + 1,
          lineNumber: 0,
          quantity: 2,
          netUnitValue: 5000,
          totalUnitValue: 5950,
          netAmount: 10000,
          taxAmount: 1900,
          totalAmount: 11900,
          netDiscount: 0,
          variant: { id: 9001, code: 'SKU-TEST-1', description: 'Alimento Test' },
        },
      ],
    },
  })

  const nvById = new Map([
    [7001, makeNvDoc(7001, 5501, 'tok-card-7001')],
    [7002, makeNvDoc(7002, 5502, 'tok-inc-7002')],
    [7003, makeNvDoc(7003, 5503, 'tok-aud-7003')],
  ])

  const bsaleServer = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    bsaleCalls.push({ method: req.method, path: url.pathname + url.search })

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'NON_GET_FORBIDDEN_IN_SYNC' }))
      return
    }

    const detailMatch = url.pathname.match(/^\/v1\/documents\/(\d+)\/details\.json$/)
    if (detailMatch) {
      const doc = nvById.get(Number(detailMatch[1]))
      const items = doc ? doc.details.items : []
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: items.length, items }))
      return
    }

    const docMatch = url.pathname.match(/^\/v1\/documents\/(\d+)\.json$/)
    if (docMatch) {
      const doc = nvById.get(Number(docMatch[1]))
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(doc))
      return
    }

    if (url.pathname === '/v1/documents.json') {
      const numberParam = url.searchParams.get('number')
      const docType = Number(url.searchParams.get('documenttypeid') || 0)
      let items = []
      if (numberParam) {
        items = [...nvById.values()].filter(d => String(d.number) === String(numberParam))
      } else if (docType === 23) {
        items = [...nvById.values()]
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: items.length, items }))
      return
    }

    // Catálogo, clientes, pagos, stocks, kardex, referencias -> respuesta vacía limpia para sync general
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ count: 0, items: [] }))
  })

  await new Promise(resolve => supabaseServer.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => bsaleServer.listen(0, '127.0.0.1', resolve))

  const supaPort = supabaseServer.address().port
  const bsalePort = bsaleServer.address().port

  return {
    supabaseUrl: `http://127.0.0.1:${supaPort}`,
    bsaleBaseUrl: `http://127.0.0.1:${bsalePort}/v1`,
    bsaleCalls,
    async close() {
      await new Promise(resolve => supabaseServer.close(resolve))
      await new Promise(resolve => bsaleServer.close(resolve))
    },
  }
}

async function bootstrapFullIsolatedSchema(pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE SCHEMA IF NOT EXISTS portal;
    CREATE SCHEMA IF NOT EXISTS integraciones;
    CREATE SCHEMA IF NOT EXISTS logistica;
    CREATE SCHEMA IF NOT EXISTS comercial;
    CREATE SCHEMA IF NOT EXISTS mermas;
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;

    CREATE TABLE core.companies (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      trade_name text NOT NULL DEFAULT 'Test',
      business_name text NOT NULL DEFAULT 'Test SpA',
      is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO core.companies (id, name) VALUES
      ('${COMPANY_CAYLO}', 'Distribuidora MyM / Caylo'),
      ('${COMPANY_AMIMASCOTA}', 'AmiMascota'),
      ('${COMPANY_INDEPENDENT}', 'Empresa Independiente');

    CREATE TABLE portal.users (
      id uuid PRIMARY KEY,
      email text,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    INSERT INTO portal.users (id, email, is_active) VALUES
      ('${USER_PREP}', 'prep@mym.cl', true),
      ('${USER_AUDITOR}', 'auditor@mym.cl', true),
      ('${USER_OTHER_AUDITOR}', 'other-auditor@mym.cl', true);

    CREATE TABLE core.user_company_access (
      user_id uuid NOT NULL,
      company_id uuid NOT NULL REFERENCES core.companies(id),
      role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, company_id)
    );
    INSERT INTO core.user_company_access (user_id, company_id, role, is_active) VALUES
      ('${USER_PREP}', '${COMPANY_CAYLO}', 'OPERADOR_BODEGA', true),
      ('${USER_AUDITOR}', '${COMPANY_CAYLO}', 'AUDITOR_BODEGA', true),
      ('${USER_OTHER_AUDITOR}', '${COMPANY_CAYLO}', 'AUDITOR_BODEGA', true);

    CREATE TABLE portal.test_user_permissions (
      user_id uuid NOT NULL,
      permission_code text NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    );
    INSERT INTO portal.test_user_permissions (user_id, permission_code) VALUES
      ('${USER_PREP}', 'module.logistica.view'),
      ('${USER_PREP}', 'logistica.preparation.manage'),
      ('${USER_AUDITOR}', 'module.logistica.view'),
      ('${USER_AUDITOR}', 'logistica.audit.manage'),
      ('${USER_OTHER_AUDITOR}', 'module.logistica.view'),
      ('${USER_OTHER_AUDITOR}', 'logistica.audit.manage');

    CREATE OR REPLACE FUNCTION portal.user_has_permission(p_user_id uuid, p_permission_code text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM portal.test_user_permissions
         WHERE user_id = p_user_id AND permission_code = p_permission_code
      );
    $$;

    CREATE TABLE integraciones.bsale_sync_locks (
      company_id   uuid NOT NULL REFERENCES core.companies(id),
      lock_name    text NOT NULL,
      run_id       uuid,
      acquired_at  timestamptz NOT NULL DEFAULT now(),
      expires_at   timestamptz NOT NULL,
      metadata     jsonb,
      PRIMARY KEY (company_id, lock_name)
    );
    ALTER TABLE integraciones.bsale_sync_locks ENABLE ROW LEVEL SECURITY;

    CREATE TABLE integraciones.bsale_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES core.companies(id),
      status text NOT NULL,
      trigger text,
      date_from text,
      date_to text,
      products_count int,
      variants_count int,
      stocks_count int,
      costs_count int,
      documents_count int,
      document_details_count int,
      metrics jsonb,
      error_message text,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );

    CREATE TABLE integraciones.sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      provider text,
      entity text,
      trigger_type text,
      status text,
      started_at timestamptz NOT NULL DEFAULT now(),
      finished_at timestamptz,
      duration_ms bigint,
      read_count int DEFAULT 0,
      inserted_count int DEFAULT 0,
      updated_count int DEFAULT 0,
      skipped_count int DEFAULT 0,
      error_count int DEFAULT 0,
      message text,
      metadata jsonb DEFAULT '{}'::jsonb,
      requested_by uuid
    );

    CREATE TABLE integraciones.sync_locks (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      provider text NOT NULL,
      entity text NOT NULL,
      locked_by text,
      sync_run_id uuid,
      expires_at timestamptz NOT NULL,
      UNIQUE (company_id, provider, entity)
    );

    CREATE TABLE integraciones.sync_errors (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sync_run_id uuid,
      company_id uuid,
      provider text,
      entity text,
      external_id text,
      error_code text,
      error_message text,
      safe_payload jsonb
    );

    CREATE TABLE integraciones.bsale_documents (
      company_id uuid NOT NULL,
      bsale_id bigint NOT NULL,
      number bigint,
      emission_date text,
      generation_date timestamptz,
      total_amount numeric,
      document_level_payments_amount numeric,
      sale_condition_id bigint,
      net_amount numeric,
      tax_amount numeric,
      exempt_amount numeric,
      document_type_id int,
      client_id bigint,
      office_id int,
      state int,
      tracking_number text,
      url_pdf text,
      raw_json jsonb,
      bsale_sync_run_id uuid,
      synced_at timestamptz,
      PRIMARY KEY (company_id, bsale_id)
    );

    CREATE TABLE integraciones.bsale_document_details (
      company_id uuid NOT NULL,
      bsale_id bigint NOT NULL,
      bsale_document_id bigint NOT NULL,
      related_detail_bsale_id bigint,
      line_number int,
      quantity numeric,
      net_unit_value numeric,
      total_unit_value numeric,
      net_amount numeric,
      tax_amount numeric,
      total_amount numeric,
      net_discount numeric,
      variant_id bigint,
      variant_code text,
      variant_description text,
      raw_json jsonb,
      bsale_sync_run_id uuid,
      synced_at timestamptz,
      PRIMARY KEY (company_id, bsale_id)
    );

    CREATE OR REPLACE FUNCTION integraciones.replace_bsale_document_snapshot_v1(
      p_company_id uuid,
      p_run_id uuid,
      p_document jsonb,
      p_details jsonb
    )
    RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE
      v_doc_id bigint := (p_document->>'bsale_id')::bigint;
      v_det jsonb;
    BEGIN
      INSERT INTO integraciones.bsale_documents (
        company_id, bsale_id, number, emission_date, generation_date, total_amount,
        net_amount, tax_amount, exempt_amount, document_type_id, client_id, office_id,
        state, raw_json, bsale_sync_run_id, synced_at
      ) VALUES (
        p_company_id, v_doc_id, (p_document->>'number')::bigint, p_document->>'emission_date',
        NULLIF(p_document->>'generation_date','')::timestamptz, (p_document->>'total_amount')::numeric,
        (p_document->>'net_amount')::numeric, (p_document->>'tax_amount')::numeric, (p_document->>'exempt_amount')::numeric,
        (p_document->>'document_type_id')::int, (p_document->>'client_id')::bigint, (p_document->>'office_id')::int,
        (p_document->>'state')::int, p_document->'raw_json', p_run_id, now()
      )
      ON CONFLICT (company_id, bsale_id) DO UPDATE
        SET number = EXCLUDED.number,
            total_amount = EXCLUDED.total_amount,
            raw_json = EXCLUDED.raw_json,
            bsale_sync_run_id = EXCLUDED.bsale_sync_run_id,
            synced_at = now();

      DELETE FROM integraciones.bsale_document_details
       WHERE company_id = p_company_id AND bsale_document_id = v_doc_id;

      FOR v_det IN SELECT * FROM jsonb_array_elements(COALESCE(p_details, '[]'::jsonb))
      LOOP
        INSERT INTO integraciones.bsale_document_details (
          company_id, bsale_id, bsale_document_id, line_number, quantity,
          variant_id, variant_code, variant_description, raw_json, bsale_sync_run_id, synced_at
        ) VALUES (
          p_company_id, (v_det->>'bsale_id')::bigint, v_doc_id, (v_det->>'line_number')::int,
          (v_det->>'quantity')::numeric, (v_det->>'variant_id')::bigint, v_det->>'variant_code',
          v_det->>'variant_description', v_det->'raw_json', p_run_id, now()
        );
      END LOOP;

      UPDATE integraciones.bsale_sync_runs
         SET status = 'COMPLETED',
             completed_at = now(),
             documents_count = 1,
             document_details_count = jsonb_array_length(COALESCE(p_details, '[]'::jsonb))
       WHERE id = p_run_id;

      RETURN jsonb_build_object('document_id', v_doc_id);
    END;
    $$;

    CREATE TABLE integraciones.vw_bsale_sales_order_items_for_preparation (
      company_id uuid NOT NULL,
      nv_bsale_id bigint NOT NULL,
      variant_id bigint NOT NULL,
      product_name text NOT NULL,
      PRIMARY KEY (company_id, nv_bsale_id, variant_id)
    );
    INSERT INTO integraciones.vw_bsale_sales_order_items_for_preparation (company_id, nv_bsale_id, variant_id, product_name) VALUES
      ('${COMPANY_CAYLO}', 7001, 9001, 'Alimento Test'),
      ('${COMPANY_CAYLO}', 7002, 9001, 'Alimento Test'),
      ('${COMPANY_CAYLO}', 7003, 9001, 'Alimento Test');

    CREATE TABLE logistica.sales_order_preparation_cards (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      status text NOT NULL,
      bsale_nv_id bigint NOT NULL,
      bsale_nv_folio text,
      canonical_bsale_token text,
      current_bsale_nv_id bigint,
      updated_at timestamptz DEFAULT now()
    );
    INSERT INTO logistica.sales_order_preparation_cards (
      id, company_id, status, bsale_nv_id, bsale_nv_folio, canonical_bsale_token, current_bsale_nv_id
    ) VALUES
      ('${CARD_PREP_ID}', '${COMPANY_CAYLO}', 'IN_PREPARATION', 7001, '5501', 'tok-card-7001', 7001),
      ('${CARD_INCIDENT_ID}', '${COMPANY_CAYLO}', 'IN_PREPARATION', 7002, '5502', 'tok-inc-7002', 7002),
      ('${CARD_AUDIT_ID}', '${COMPANY_CAYLO}', 'IN_AUDIT', 7003, '5503', 'tok-aud-7003', 7003);

    CREATE VIEW logistica.vw_sales_order_preparation_board AS
      SELECT id AS card_id, company_id, status, COALESCE(current_bsale_nv_id, bsale_nv_id) AS nv_bsale_id
        FROM logistica.sales_order_preparation_cards;

    CREATE TABLE logistica.sales_order_preparation_incidents (
      id uuid PRIMARY KEY,
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      company_id uuid NOT NULL,
      status text NOT NULL,
      verification_status text
    );
    INSERT INTO logistica.sales_order_preparation_incidents (id, card_id, company_id, status, verification_status)
    VALUES ('${INCIDENT_ID}', '${CARD_INCIDENT_ID}', '${COMPANY_CAYLO}', 'OPEN', 'MISMATCH');

    CREATE TABLE logistica.sales_order_audits (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      status text NOT NULL,
      cycle_no int NOT NULL DEFAULT 1,
      locked_by_user_id uuid
    );
    INSERT INTO logistica.sales_order_audits (id, company_id, card_id, status, cycle_no, locked_by_user_id)
    VALUES ('${AUDIT_ID}', '${COMPANY_CAYLO}', '${CARD_AUDIT_ID}', 'OPEN', 1, '${USER_AUDITOR}');

    CREATE OR REPLACE FUNCTION logistica.reconcile_bodega_preparation_cards(p_company_id uuid)
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('discovered', 3, 'created', 0, 'relations_created', 0, 'closed_invoiced', 0, 'closed_cancelled', 0, 'closed_non_operational', 0, 'skipped_invoiced', 0);
    $$;

    CREATE OR REPLACE FUNCTION logistica.verify_open_preparation_incidents_v1(p_company_id uuid, p_bsale_nv_ids bigint[])
    RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE logistica.sales_order_preparation_incidents
         SET status = 'RESOLVED', verification_status = 'MATCHED'
       WHERE company_id = p_company_id
         AND card_id IN (
           SELECT id FROM logistica.sales_order_preparation_cards
            WHERE company_id = p_company_id AND COALESCE(current_bsale_nv_id, bsale_nv_id) = ANY(p_bsale_nv_ids)
         );
      RETURN jsonb_build_object('verified', 1);
    END;
    $$;

    CREATE OR REPLACE FUNCTION mermas.reconcile_worker_bsale_boletas(p_company_id uuid)
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('scanned', 0, 'created', 0, 'already_exists', 0, 'unmatched', 0, 'ambiguous', 0, 'invalid', 0);
    $$;

    CREATE OR REPLACE FUNCTION comercial.refresh_client_metrics_snapshot(p_company_id uuid)
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('refreshed', true);
    $$;
  `)

  const migCoordinator = readFileSync(
    new URL('../supabase/migrations/20261127151840_integraciones_bsale_sync_coordinator.sql', import.meta.url),
    'utf8',
  )
  const migQueue = readFileSync(
    new URL('../supabase/migrations/20261127151858_integraciones_bsale_sync_queue.sql', import.meta.url),
    'utf8',
  )

  await pool.query(migCoordinator)
  await pool.query(migQueue)
}

function createPg15Stores(pool, options = {}) {
  let simulateRenewNetworkFailure = false

  const coordinatorStore = {
    setSimulateRenewNetworkFailure(enabled) {
      simulateRenewNetworkFailure = enabled
    },
    async acquire(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.acquire_bsale_sync_lock_v1($1::uuid, $2::text, $3::text, $4::text, $5::text, $6::text, $7::uuid, $8::int, $9::text[], $10::jsonb) AS res`,
        [
          params.companyId,
          params.lockName,
          params.ownerToken,
          params.operationKind,
          params.credentialScope,
          params.resourceKey,
          params.runId,
          params.ttlSeconds,
          params.incompatibleLockNames,
          JSON.stringify(params.metadata ?? {}),
        ],
      )
      const payload = rows[0].res
      if (payload.acquired) {
        return {
          acquired: true,
          expiresAt: payload.expires_at,
          serverNow: payload.server_now,
        }
      }
      return {
        acquired: false,
        blocking: {
          lockName: payload.blocking_lock_name ?? params.lockName,
          operationKind: payload.blocking_operation_kind ?? null,
          runId: payload.blocking_run_id ?? null,
          resourceKey: payload.blocking_resource_key ?? null,
          expiresAt: payload.blocking_expires_at ?? null,
          reason: payload.reason ?? null,
          retryAfterSeconds: payload.retry_after_seconds ?? null,
        },
      }
    },
    async renew(params) {
      if (simulateRenewNetworkFailure) {
        throw new Error('ECONNREFUSED: pérdida de conexión con PostgreSQL durante renovación del lease')
      }
      const { rows } = await pool.query(
        `SELECT integraciones.renew_bsale_sync_lock_v1($1::uuid, $2::text, $3::text, $4::int, $5::text) AS res`,
        [params.companyId, params.lockName, params.ownerToken, params.ttlSeconds, params.credentialScope],
      )
      const payload = rows[0].res
      return {
        renewed: payload.renewed === true,
        expiresAt: payload.expires_at,
        serverNow: payload.server_now,
        reason: payload.reason,
      }
    },
    async release(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.release_bsale_sync_lock_v1($1::uuid, $2::text, $3::text, $4::text) AS res`,
        [params.companyId, params.lockName, params.ownerToken, params.credentialScope],
      )
      const payload = rows[0].res
      return {
        released: payload.released === true,
        reason: payload.reason,
      }
    },
    async registerCooldown(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.register_bsale_scope_cooldown_v1($1::uuid, $2::text, $3::int, $4::int, $5::text) AS res`,
        [params.companyId, params.credentialScope, params.retryAfterSeconds, params.httpStatus ?? 429, params.reason ?? null],
      )
      return {
        blockedUntil: rows[0].res.blocked_until,
        retryAfterSeconds: rows[0].res.retry_after_seconds,
      }
    },
  }

  const queueStore = {
    coordinatorStore,
    async enqueue(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.enqueue_bsale_sync_request_v1(
          $1::uuid, $2::text, $3::text, $4::text, $5::text[], $6::text,
          $7::text, $8::int, $9::int, $10::int, $11::text, $12::uuid, $13::jsonb, $14::int
        ) AS res`,
        [
          params.companyId,
          params.credentialScope,
          params.operationKind,
          params.lockName,
          params.incompatibleLockNames,
          params.resourceKey,
          params.priority,
          params.priorityWeight,
          params.ttlSeconds,
          params.maxAttempts,
          params.triggerType,
          params.requestedBy,
          JSON.stringify(params.payload ?? {}),
          params.delaySeconds ?? 0,
        ],
      )
      const row = rows[0].res
      return {
        enqueued: row.enqueued !== false,
        alreadyRunning: row.already_running === true,
        deduplicated: row.deduplicated === true,
        requestId: row.request_id ?? null,
        status: row.status,
        dedupeKey: row.dedupe_key,
        credentialScope: row.credential_scope,
        coalescedCount: Number(row.coalesced_count),
        availableAt: row.available_at,
      }
    },
    async recover() {
      const { rows } = await pool.query(`SELECT integraciones.recover_bsale_sync_queue_v1() AS res`)
      const row = rows[0].res
      return {
        recoveredToPending: Number(row.recovered_to_pending),
        failedExhausted: Number(row.failed_exhausted),
        cancelledSuperseded: Number(row.cancelled_superseded),
      }
    },
    async claimNext(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.claim_next_bsale_sync_request_v1($1::text, $2::text, $3::int, $4::int) AS res`,
        [
          params.workerId,
          params.credentialScope ?? null,
          params.maxStarvationSeconds ?? options.maxStarvationSeconds ?? 900,
          params.agingStepSeconds ?? options.agingStepSeconds ?? 180,
        ],
      )
      const payload = rows[0].res
      if (!payload.claimed) {
        return {
          claimed: false,
          serverNow: payload.server_now,
          nextAvailableAt: payload.next_available_at ?? null,
        }
      }
      return {
        claimed: true,
        serverNow: payload.server_now,
        lease: {
          ownerToken: payload.lease.owner_token,
          lockName: payload.lease.lock_name,
          expiresAt: payload.lease.expires_at,
          serverNow: payload.lease.server_now,
        },
        request: {
          id: payload.request.id,
          companyId: payload.request.company_id,
          credentialScope: payload.request.credential_scope,
          operationKind: payload.request.operation_kind,
          lockName: payload.request.lock_name,
          resourceKey: payload.request.resource_key ?? null,
          dedupeKey: payload.request.dedupe_key,
          status: payload.request.status,
          priority: payload.request.priority,
          priorityWeight: Number(payload.request.priority_weight),
          coalescedCount: Number(payload.request.coalesced_count),
          attemptCount: Number(payload.request.attempt_count),
          maxAttempts: Number(payload.request.max_attempts),
          ttlSeconds: Number(payload.request.ttl_seconds),
          triggerType: payload.request.trigger_type,
          requestedBy: payload.request.requested_by ?? null,
          payload: payload.request.payload ?? {},
          enqueuedAt: payload.request.enqueued_at,
          startedAt: payload.request.started_at ?? null,
        },
      }
    },
    async complete(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.complete_bsale_sync_request_v1($1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::bigint, $7::uuid, $8::jsonb) AS res`,
        [
          params.requestId,
          params.companyId,
          params.lockName,
          params.credentialScope,
          params.ownerToken,
          Math.max(0, Math.round(params.durationMs)),
          params.syncRunId ?? null,
          JSON.stringify(params.resultSummary ?? {}),
        ],
      )
      const r = rows[0].res
      return { completed: r.completed === true, status: r.status, reason: r.reason, leaseAssociated: r.lease_associated ?? null }
    },
    async failOrRetry(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.fail_or_retry_bsale_sync_request_v1(
          $1::uuid, $2::uuid, $3::text, $4::text, $5::text, $6::text, $7::text, $8::boolean, $9::int, $10::int, $11::bigint, $12::uuid, $13::jsonb
        ) AS res`,
        [
          params.requestId,
          params.companyId,
          params.lockName,
          params.credentialScope,
          params.ownerToken,
          params.errorCode,
          params.errorMessage,
          params.retryable,
          params.httpStatus ?? null,
          params.retryAfterSeconds ?? null,
          Math.max(0, Math.round(params.durationMs)),
          params.syncRunId ?? null,
          params.resultSummary ? JSON.stringify(params.resultSummary) : null,
        ],
      )
      const r = rows[0].res
      return {
        updated: r.updated === true,
        status: r.status,
        nextAvailableAt: r.next_available_at ?? null,
        backoffSeconds: r.backoff_seconds ?? null,
        reason: r.reason,
      }
    },
    async cancel(params) {
      const { rows } = await pool.query(
        `SELECT integraciones.cancel_bsale_sync_request_v1($1::uuid, $2::uuid, $3::text) AS res`,
        [params.requestId, params.companyId, params.reason ?? null],
      )
      return { cancelled: rows[0].res.cancelled === true, reason: rows[0].res.reason }
    },
  }

  return { coordinatorStore, queueStore }
}

test('SYNC-02 Correcciones Finales de Seguridad y Concurrencia sobre PostgreSQL 15 aislado', async (t) => {
  const prevEnv = {
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    BSALE_API_BASE_URL: process.env.BSALE_API_BASE_URL,
    BSALE_ACCESS_TOKEN: process.env.BSALE_ACCESS_TOKEN,
    BSALE_ACCESS_TOKEN_CAYLO: process.env.BSALE_ACCESS_TOKEN_CAYLO,
    BSALE_ACCESS_TOKEN_AMIMASCOTA: process.env.BSALE_ACCESS_TOKEN_AMIMASCOTA,
    BSALE_SYNC_COORDINATOR_ENABLED: process.env.BSALE_SYNC_COORDINATOR_ENABLED,
    BSALE_SYNC_QUEUE_ENABLED: process.env.BSALE_SYNC_QUEUE_ENABLED,
    BSALE_SYNC_SUPERVISOR_ENABLED: process.env.BSALE_SYNC_SUPERVISOR_ENABLED,
  }

  let pg15 = null
  let localServers = null
  let runtimeMod = null
  let queueMod = null

  t.after(async () => {
    try { runtimeMod?.resetBsaleSyncQueueRuntimeForTests() } catch { /* noop */ }
    try { queueMod?.resetGlobalBsaleSyncQueueManagerForTests() } catch { /* noop */ }
    if (localServers) await localServers.close().catch(() => {})
    if (pg15) await pg15.stop().catch(() => {})
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  pg15 = startIsolatedPostgres15()
  await bootstrapFullIsolatedSchema(pg15.pool)
  localServers = await startLocalPostgrestAndBsaleServers(pg15.pool)

  process.env.NEXT_PUBLIC_SUPABASE_URL = localServers.supabaseUrl
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon-key'
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service-role-key'
  process.env.BSALE_API_BASE_URL = localServers.bsaleBaseUrl
  process.env.BSALE_ACCESS_TOKEN = 'test-token-caylo-isolated'
  process.env.BSALE_ACCESS_TOKEN_CAYLO = 'test-token-caylo-isolated'
  process.env.BSALE_ACCESS_TOKEN_AMIMASCOTA = 'test-token-amimascota-isolated'
  process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'true'
  process.env.BSALE_SYNC_QUEUE_ENABLED = 'true'
  process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'false'

  const coordinatorMod = await import('../src/lib/integraciones/bsale-sync-coordinator.ts')
  queueMod = await import('../src/lib/integraciones/bsale-sync-queue.ts')
  runtimeMod = await import('../src/lib/integraciones/bsale-sync-queue-runtime.ts')
  const bsaleSyncMod = await import('../src/app/actions/integraciones/bsale-sync.ts')
  const incidentSyncMod = await import('../src/app/actions/logistica/sales-order-preparation-incident-sync.ts')

  const versionRow = await pg15.pool.query('SHOW server_version')
  assert.match(versionRow.rows[0].server_version, /^15\./)

  await t.test('1 y 2. Retry-After > 300s (ej. 750s) se conserva íntegro y aplica cooldown tanto a adquisición directa como a cola', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
    const { coordinatorStore, queueStore } = createPg15Stores(pg15.pool)

    // A) Ejecución directa recibe HTTP 429 con Retry-After = 750s (> 300s)
    const directRes = await coordinatorMod.runWithBsaleSyncCoordinator({
      companyId: COMPANY_CAYLO,
      operationKind: 'WAREHOUSE_MANUAL',
      credentialScope: 'cred:shared-429-scope',
      store: coordinatorStore,
      execute: async () => {
        throw new coordinatorMod.BsaleRateLimitError('Bsale 429', 750)
      },
    })
    assert.equal(directRes.status, 'TECHNICAL_ERROR')

    const cdRow = (await pg15.pool.query(
      `SELECT retry_after_seconds, EXTRACT(EPOCH FROM (blocked_until - clock_timestamp())) AS remaining_secs
         FROM integraciones.bsale_sync_scope_cooldowns
        WHERE credential_scope = 'cred:shared-429-scope'`,
    )).rows[0]
    assert.equal(Number(cdRow.retry_after_seconds), 750)
    assert.equal(Number(cdRow.remaining_secs) > 740, true)

    // B) Adquisición directa subsiguiente (incluso de otra empresa con misma credencial) es rechazada por COOLDOWN_ACTIVE
    const directBlocked = await coordinatorStore.acquire({
      companyId: COMPANY_AMIMASCOTA,
      lockName: 'bsale_operational_prep_sync',
      ownerToken: 'direct-probe',
      operationKind: 'OPERATIONAL_PREP_SYNC',
      credentialScope: 'cred:shared-429-scope',
      resourceKey: null,
      runId: null,
      ttlSeconds: 60,
      incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('OPERATIONAL_PREP_SYNC'),
      metadata: {},
    })
    assert.equal(directBlocked.acquired, false)
    assert.equal(directBlocked.blocking.reason, 'COOLDOWN_ACTIVE')
    assert.equal(directBlocked.blocking.retryAfterSeconds, 750)

    // C) Solicitud en cola sobre ese mismo alcance tampoco puede reclamarse durante el cooldown de 750s
    const enq = await queueStore.enqueue({
      companyId: COMPANY_CAYLO,
      credentialScope: 'cred:shared-429-scope',
      operationKind: 'WAREHOUSE_MANUAL',
      lockName: 'bsale_operational_prep_sync',
      incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('WAREHOUSE_MANUAL'),
      resourceKey: null,
      priority: 'HIGH',
      priorityWeight: 240,
      ttlSeconds: 60,
      maxAttempts: 3,
      triggerType: 'WAREHOUSE_MANUAL',
      requestedBy: USER_PREP,
      payload: {},
    })
    const claimDuringCooldown = await queueStore.claimNext({ workerId: 'worker-429' })
    assert.equal(claimDuringCooldown.claimed, false)
    assert.ok(claimDuringCooldown.nextAvailableAt)
    assert.equal(
      (Date.parse(claimDuringCooldown.nextAvailableAt) - Date.now()) / 1000 > 700,
      true,
    )

    // D) En fail_or_retry_bsale_sync_request_v1, Retry-After = 900s también se conserva sin truncar a 300s
    await pg15.pool.query('DELETE FROM integraciones.bsale_sync_scope_cooldowns')
    const claimedAfterClear = await queueStore.claimNext({ workerId: 'worker-429' })
    assert.equal(claimedAfterClear.claimed, true)
    assert.equal(claimedAfterClear.request.id, enq.requestId)

    const retry900 = await queueStore.failOrRetry({
      requestId: enq.requestId,
      companyId: COMPANY_CAYLO,
      lockName: 'bsale_operational_prep_sync',
      credentialScope: 'cred:shared-429-scope',
      ownerToken: claimedAfterClear.lease.ownerToken,
      errorCode: 'BSALE_RATE_LIMITED_429',
      errorMessage: 'HTTP 429 Retry-After 900',
      retryable: true,
      httpStatus: 429,
      retryAfterSeconds: 900,
      durationMs: 20,
    })
    assert.equal(retry900.updated, true)
    assert.equal(retry900.backoffSeconds, 900)
    const qRow = (await pg15.pool.query(
      `SELECT retry_after_seconds, EXTRACT(EPOCH FROM (available_at - clock_timestamp())) AS wait_secs
         FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`,
      [enq.requestId],
    )).rows[0]
    assert.equal(Number(qRow.retry_after_seconds), 900)
    assert.equal(Number(qRow.wait_secs) > 890, true)
  })

  await t.test('3. Orden unificado de bloqueos PostgreSQL: carreras masivas renew vs recover vs claim vs enqueue sin deadlocks ni desalineación', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
    const { coordinatorStore, queueStore } = createPg15Stores(pg15.pool)

    const enq = await queueStore.enqueue({
      companyId: COMPANY_CAYLO,
      credentialScope: 'cred:race-scope',
      operationKind: 'WAREHOUSE_MANUAL',
      lockName: 'bsale_operational_prep_sync',
      incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('WAREHOUSE_MANUAL'),
      resourceKey: null,
      priority: 'HIGH',
      priorityWeight: 240,
      ttlSeconds: 1,
      maxAttempts: 5,
      triggerType: 'WAREHOUSE_MANUAL',
      requestedBy: USER_PREP,
      payload: {},
    })

    const initialClaim = await queueStore.claimNext({ workerId: 'race-w1' })
    assert.equal(initialClaim.claimed, true)

    // Esperar cerca del borde de expiración (900ms de 1000ms) y lanzar simultáneamente 12 operaciones cruzadas
    // (renew, recover, claimNext, enqueue duplicado) sobre conexiones independientes del pool PG15
    await new Promise(resolve => setTimeout(resolve, 900))

    const concurrentOps = await Promise.all([
      ...Array.from({ length: 4 }, () =>
        coordinatorStore.renew({
          companyId: COMPANY_CAYLO,
          lockName: 'bsale_operational_prep_sync',
          credentialScope: 'cred:race-scope',
          ownerToken: initialClaim.lease.ownerToken,
          ttlSeconds: 5,
        }),
      ),
      ...Array.from({ length: 4 }, () => queueStore.recover()),
      ...Array.from({ length: 2 }, (_, idx) => queueStore.claimNext({ workerId: `race-contender-${idx}` })),
      ...Array.from({ length: 2 }, () =>
        queueStore.enqueue({
          companyId: COMPANY_CAYLO,
          credentialScope: 'cred:race-scope',
          operationKind: 'WAREHOUSE_MANUAL',
          lockName: 'bsale_operational_prep_sync',
          incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('WAREHOUSE_MANUAL'),
          resourceKey: null,
          priority: 'HIGH',
          priorityWeight: 240,
          ttlSeconds: 5,
          maxAttempts: 5,
          triggerType: 'WAREHOUSE_MANUAL',
          requestedBy: USER_PREP,
          payload: {},
        }),
      ),
    ])
    assert.equal(concurrentOps.length, 12)

    // Verificar invariante fuerte: toda fila RUNNING debe coincidir exactamente con el owner_token activo en bsale_sync_locks
    const runningRows = (await pg15.pool.query(
      `SELECT id, owner_token, lease_expires_at FROM integraciones.bsale_sync_queue WHERE status = 'RUNNING'`,
    )).rows
    const lockRows = (await pg15.pool.query(
      `SELECT owner_token, expires_at FROM integraciones.bsale_sync_locks WHERE credential_scope = 'cred:race-scope' AND expires_at > clock_timestamp()`,
    )).rows
    assert.equal(runningRows.length <= 1, true)
    assert.equal(lockRows.length, runningRows.length)
    if (runningRows.length === 1) {
      assert.equal(runningRows[0].owner_token, lockRows[0].owner_token)
    }
    assert.ok(enq.requestId)
  })

  await t.test('4 y 5. Rechazo de COMPLETED con lease expirado/perdido y prohibición absoluta de liberar bloqueos con solo owner_token', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
    const { coordinatorStore, queueStore } = createPg15Stores(pg15.pool)

    // Parte A (Punto 5): Un bloqueo activo real NO puede liberarse con un request_id inexistente, otra empresa u otro lock_name,
    // aunque el atacante o proceso erróneo envíe el owner_token exacto.
    const enqA = await queueStore.enqueue({
      companyId: COMPANY_CAYLO,
      credentialScope: 'cred:strict-identity',
      operationKind: 'WAREHOUSE_MANUAL',
      lockName: 'bsale_operational_prep_sync',
      incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('WAREHOUSE_MANUAL'),
      resourceKey: null,
      priority: 'HIGH',
      priorityWeight: 240,
      ttlSeconds: 30,
      maxAttempts: 3,
      triggerType: 'WAREHOUSE_MANUAL',
      requestedBy: USER_PREP,
      payload: {},
    })
    const claimedA = await queueStore.claimNext({ workerId: 'worker-strict' })
    assert.equal(claimedA.claimed, true)
    const realOwnerToken = claimedA.lease.ownerToken

    const fakeRequestAttempt = await queueStore.failOrRetry({
      requestId: '99999999-9999-4999-8999-999999999999',
      companyId: COMPANY_CAYLO,
      lockName: 'bsale_operational_prep_sync',
      credentialScope: 'cred:strict-identity',
      ownerToken: realOwnerToken,
      errorCode: 'FAKE',
      errorMessage: 'Intento con request_id inexistente',
      retryable: false,
      durationMs: 5,
    })
    assert.equal(fakeRequestAttempt.updated, false)
    assert.equal(fakeRequestAttempt.reason, 'UNAUTHORIZED_OR_NOT_FOUND')

    const wrongCompanyAttempt = await queueStore.failOrRetry({
      requestId: enqA.requestId,
      companyId: COMPANY_AMIMASCOTA,
      lockName: 'bsale_operational_prep_sync',
      credentialScope: 'cred:strict-identity',
      ownerToken: realOwnerToken,
      errorCode: 'FAKE',
      errorMessage: 'Intento con company_id incorrecto',
      retryable: false,
      durationMs: 5,
    })
    assert.equal(wrongCompanyAttempt.updated, false)

    const wrongScopeRelease = await coordinatorStore.release({
      companyId: COMPANY_CAYLO,
      lockName: 'bsale_operational_prep_sync',
      credentialScope: 'cred:wrong-scope',
      ownerToken: realOwnerToken,
    })
    assert.equal(wrongScopeRelease.released, false)

    // El bloqueo real permanece 100% intacto en PostgreSQL 15
    const activeLocksAfterSpoof = await pg15.pool.query(
      `SELECT owner_token FROM integraciones.bsale_sync_locks WHERE company_id = $1 AND owner_token = $2`,
      [COMPANY_CAYLO, realOwnerToken],
    )
    assert.equal(activeLocksAfterSpoof.rowCount, 1)

    // Liberar legítimamente claimedA y probar Punto 4 (expiración antes de complete)
    const validComplete = await queueStore.complete({
      requestId: enqA.requestId,
      companyId: COMPANY_CAYLO,
      lockName: 'bsale_operational_prep_sync',
      credentialScope: 'cred:strict-identity',
      ownerToken: realOwnerToken,
      durationMs: 10,
    })
    assert.equal(validComplete.completed, true)

    // Parte B (Punto 4): Solicitud con TTL=1s deja vencer su lease antes de llamar a complete_bsale_sync_request_v1
    const enqExpiring = await queueStore.enqueue({
      companyId: COMPANY_CAYLO,
      credentialScope: 'cred:strict-identity',
      operationKind: 'CARD_SYNC',
      lockName: 'bsale_operational_prep_sync',
      incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('CARD_SYNC'),
      resourceKey: `card:${CARD_PREP_ID}`,
      priority: 'HIGH',
      priorityWeight: 300,
      ttlSeconds: 1,
      maxAttempts: 2,
      triggerType: 'MANUAL',
      requestedBy: USER_PREP,
      payload: { cardId: CARD_PREP_ID },
    })
    const claimedExpiring = await queueStore.claimNext({ workerId: 'worker-slow' })
    assert.equal(claimedExpiring.claimed, true)

    await new Promise(resolve => setTimeout(resolve, 1_150))

    const lateComplete = await queueStore.complete({
      requestId: enqExpiring.requestId,
      companyId: COMPANY_CAYLO,
      lockName: 'bsale_operational_prep_sync',
      credentialScope: 'cred:strict-identity',
      ownerToken: claimedExpiring.lease.ownerToken,
      durationMs: 1_200,
    })
    assert.equal(lateComplete.completed, false)
    assert.equal(lateComplete.reason, 'LEASE_EXPIRED_OR_LOST')
    assert.equal(lateComplete.status, 'PENDING')

    const checkNotCompleted = (await pg15.pool.query(
      `SELECT status, last_error_code FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`,
      [enqExpiring.requestId],
    )).rows[0]
    assert.notEqual(checkNotCompleted.status, 'COMPLETED')
    assert.equal(checkNotCompleted.status, 'PENDING')
    assert.equal(checkNotCompleted.last_error_code, 'LEASE_EXPIRED_BEFORE_COMPLETE')
  })

  await t.test('6 y 8. Acciones REALES (general, manual, automáticas e individuales) encolan ante bloqueo y ejecutan sin sesión de navegador conservando empresa/usuario y sin emitir DTE', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
    localServers.bsaleCalls.length = 0

    // Desactivar auto-drenaje en segundo plano únicamente mientras verificamos todas las filas PENDING creadas por las acciones reales
    process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'true'
    process.env.BSALE_SYNC_QUEUE_ENABLED = 'true'
    runtimeMod.resetBsaleSyncQueueRuntimeForTests()
    queueMod.resetGlobalBsaleSyncQueueManagerForTests()
    const realManager = runtimeMod.ensureBsaleSyncQueueRuntimeRegistered()

    const cayloScope = coordinatorMod.resolveBsaleCredentialScope(COMPANY_CAYLO)
    const blockerToken = 'active-blocker-token'
    await pg15.pool.query(
      `SELECT integraciones.acquire_bsale_sync_lock_v1($1::uuid, 'bsale_warehouse_full_refresh', $2::text, 'WAREHOUSE_FULL_REFRESH', $3::text, NULL, NULL, 300, ARRAY['bsale_replenishment_sync','bsale_operational_prep_sync','bsale_warehouse_full_refresh'])`,
      [COMPANY_CAYLO, blockerToken, cayloScope],
    )

    // 1) Invocar acciones REALES por lotes (sin necesidad de sesión de navegador) mientras el lock incompatible está activo
    MOCK_AUTH_STATE.cookieSessionAvailable = false
    MOCK_AUTH_STATE.currentUserId = null

    const [generalBusy, manualBusy, incBusy, opBusy] = await Promise.all([
      bsaleSyncMod.runReplenishmentBsaleSync(COMPANY_CAYLO, 'SCHEDULED'),
      bsaleSyncMod.runManualWarehouseBsaleRefresh(COMPANY_CAYLO),
      bsaleSyncMod.runIncrementalWarehouseBsaleRefresh(COMPANY_CAYLO),
      bsaleSyncMod.runOperationalWarehouseBsaleRefresh(COMPANY_CAYLO),
    ])

    assert.equal(generalBusy.status, 'SKIPPED_LOCKED')
    assert.equal(generalBusy.queued, true)
    assert.ok(generalBusy.queueRequestId)

    assert.equal(manualBusy.status, 'SKIPPED_LOCKED')
    assert.equal(manualBusy.queued, true)
    assert.ok(manualBusy.queueRequestId)

    assert.equal(incBusy.status, 'SKIPPED_LOCKED')
    assert.equal(incBusy.queued, true)
    assert.ok(incBusy.queueRequestId)

    assert.equal(opBusy.status, 'SKIPPED_LOCKED')
    assert.equal(opBusy.queued, true)
    assert.ok(opBusy.queueRequestId)

    // 2) Invocar acciones REALES individuales (con sesión de usuario al solicitar) mientras el lock incompatible está activo
    MOCK_AUTH_STATE.cookieSessionAvailable = true
    MOCK_AUTH_STATE.currentUserId = USER_PREP
    MOCK_AUTH_STATE.activeCompanyId = COMPANY_CAYLO

    const cardBusy = await incidentSyncMod.syncSalesOrderPreparationCardFromBsale(CARD_PREP_ID)
    assert.equal(cardBusy.status, 'CONFLICT')
    assert.equal(cardBusy.queued, true)
    assert.ok(cardBusy.queueRequestId)

    const incSyncBusy = await incidentSyncMod.syncSalesOrderPreparationIncident(INCIDENT_ID)
    assert.equal(incSyncBusy.status, 'UNABLE_TO_VERIFY')
    assert.equal(incSyncBusy.queued, true)
    assert.ok(incSyncBusy.queueRequestId)

    MOCK_AUTH_STATE.currentUserId = USER_AUDITOR
    const auditBusy = await incidentSyncMod.syncSalesOrderAuditCardFromBsale(CARD_AUDIT_ID)
    assert.equal(auditBusy.status, 'CONFLICT')
    assert.equal(auditBusy.queued, true)
    assert.ok(auditBusy.queueRequestId)

    // Verificar que las 7 solicitudes reales quedaron registradas en PENDING con company_id y requested_by correctos
    const pendingRows = (await pg15.pool.query(
      `SELECT operation_kind, status, company_id, requested_by FROM integraciones.bsale_sync_queue ORDER BY priority_weight DESC`,
    )).rows
    assert.equal(pendingRows.length, 7)
    for (const r of pendingRows) {
      assert.equal(r.status, 'PENDING')
      assert.equal(r.company_id, COMPANY_CAYLO)
    }

    // 3) Cerrar completamente la sesión del navegador (simulando usuario que cerró pestaña)
    //    y liberar el bloqueo incompatible para que el servidor procese la cola de extremo a extremo.
    MOCK_AUTH_STATE.cookieSessionAvailable = false
    MOCK_AUTH_STATE.currentUserId = null

    await pg15.pool.query(
      `SELECT integraciones.release_bsale_sync_lock_v1($1::uuid, 'bsale_warehouse_full_refresh', $2::text, $3::text)`,
      [COMPANY_CAYLO, blockerToken, cayloScope],
    )

    const drainSummary = await realManager.drain()
    assert.equal(drainSummary.completedIds.length, 5)
    assert.equal(drainSummary.failedIds.length, 2)
    // Este fixture reducido no incluye el esquema de conciliación individual;
    // CARD_SYNC y AUDIT_SYNC deben fallar cerrados en vez de informar éxito parcial.
    const unreconciled = (await pg15.pool.query(
      `SELECT operation_kind, last_error_message FROM integraciones.bsale_sync_queue WHERE id = ANY($1::uuid[]) ORDER BY operation_kind`,
      [drainSummary.failedIds],
    )).rows
    assert.deepEqual(unreconciled.map(row => row.operation_kind), ['AUDIT_SYNC', 'CARD_SYNC'])
    for (const row of unreconciled) assert.match(row.last_error_message, /reconciliación individual/)

    // Verificar resultados persistidos en espejo local e incidencia resuelta
    const mirroredDocs = (await pg15.pool.query(
      `SELECT bsale_id FROM integraciones.bsale_documents WHERE company_id = $1 ORDER BY bsale_id ASC`,
      [COMPANY_CAYLO],
    )).rows.map(r => Number(r.bsale_id))
    assert.deepEqual(mirroredDocs, [7001, 7002, 7003])

    const resolvedIncident = (await pg15.pool.query(
      `SELECT status, verification_status FROM logistica.sales_order_preparation_incidents WHERE id = $1::uuid`,
      [INCIDENT_ID],
    )).rows[0]
    assert.equal(resolvedIncident.status, 'RESOLVED')
    assert.equal(resolvedIncident.verification_status, 'MATCHED')

    // Verificar Punto 8: si la auditoría cambia a otro auditor o se revoca acceso antes de ejecutar en cola, se protege el alcance
    await pg15.pool.query(
      `UPDATE logistica.sales_order_audits SET locked_by_user_id = $1::uuid WHERE id = $2::uuid`,
      [USER_OTHER_AUDITOR, AUDIT_ID],
    )
    const reassignedAuditReq = await realManager.enqueue({
      companyId: COMPANY_CAYLO,
      operationKind: 'AUDIT_SYNC',
      resourceKey: `card:${CARD_AUDIT_ID}`,
      requestedBy: USER_AUDITOR,
      payload: { cardId: CARD_AUDIT_ID, auditId: AUDIT_ID },
      autoTriggerDrain: false,
    })
    await realManager.drain()
    const reassignedRow = (await pg15.pool.query(
      `SELECT status, result_summary FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`,
      [reassignedAuditReq.requestId],
    )).rows[0]
    assert.equal(reassignedRow.status, 'COMPLETED')
    assert.equal(reassignedRow.result_summary.skipped, 'AUDIT_ASSIGNED_TO_OTHER_USER')

    // Revocar acceso de empresa a USER_PREP -> una solicitud encolada suya falla cerrado (BSALE_QUEUE_USER_COMPANY_REVOKED)
    await pg15.pool.query(
      `UPDATE core.user_company_access SET is_active = false WHERE user_id = $1::uuid AND company_id = $2::uuid`,
      [USER_PREP, COMPANY_CAYLO],
    )
    const revokedUserReq = await realManager.enqueue({
      companyId: COMPANY_CAYLO,
      operationKind: 'CARD_SYNC',
      resourceKey: `card:${CARD_PREP_ID}`,
      requestedBy: USER_PREP,
      maxAttempts: 1,
      payload: { cardId: CARD_PREP_ID },
      autoTriggerDrain: false,
    })
    await realManager.drain()
    const revokedRow = (await pg15.pool.query(
      `SELECT status, last_error_message FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`,
      [revokedUserReq.requestId],
    )).rows[0]
    assert.equal(revokedRow.status, 'FAILED')
    assert.match(revokedRow.last_error_message, /BSALE_QUEUE_USER_COMPANY_REVOKED/)

    // Restaurar acceso y verificar que JAMÁS se ejecutó ningún método distinto de GET hacia Bsale
    await pg15.pool.query(
      `UPDATE core.user_company_access SET is_active = true WHERE user_id = $1::uuid AND company_id = $2::uuid`,
      [USER_PREP, COMPANY_CAYLO],
    )
    assert.equal(localServers.bsaleCalls.length > 0, true)
    assert.equal(localServers.bsaleCalls.every(c => c.method === 'GET'), true)
  })

  await t.test('7. Activación controlada, reversible y compatible en transición con versión publicada (d99eaf2)', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')

    // Etapa 1: Modo LEGACY (BSALE_SYNC_COORDINATOR_ENABLED=false) -> compatible con filas sin owner_token y sin tocar cola
    process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'false'
    const legacyAcq = await bsaleSyncMod.acquireSyncLock(COMPANY_CAYLO, 'bsale_operational_prep_sync', '11111111-1111-4111-8111-000000000099', 10)
    assert.equal(legacyAcq, true)

    const legacyLockRow = (await pg15.pool.query(
      `SELECT owner_token, credential_scope FROM integraciones.bsale_sync_locks WHERE company_id = $1`,
      [COMPANY_CAYLO],
    )).rows[0]
    assert.equal(legacyLockRow.owner_token, null)

    // Transición en caliente: una instancia nueva (COORDINATOR_ENABLED=true, QUEUE_ENABLED=false) respeta el bloqueo legacy activo de d99eaf2
    process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'true'
    process.env.BSALE_SYNC_QUEUE_ENABLED = 'false'

    const busyWithoutQueue = await bsaleSyncMod.runManualWarehouseBsaleRefresh(COMPANY_CAYLO)
    assert.equal(busyWithoutQueue.status, 'SKIPPED_LOCKED')
    assert.equal(busyWithoutQueue.queued, false)
    const queueCountWhileDisabled = (await pg15.pool.query(`SELECT count(*)::int AS cnt FROM integraciones.bsale_sync_queue`)).rows[0].cnt
    assert.equal(queueCountWhileDisabled, 0)

    // Liberar bloqueo legacy desde modo legacy y reactivar cola completa
    process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'false'
    await bsaleSyncMod.releaseSyncLock(COMPANY_CAYLO, 'bsale_operational_prep_sync', '11111111-1111-4111-8111-000000000099')
    process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'true'
    process.env.BSALE_SYNC_QUEUE_ENABLED = 'true'

    const cleanManualRun = await bsaleSyncMod.runManualWarehouseBsaleRefresh(COMPANY_CAYLO)
    assert.equal(cleanManualRun.success, true)
  })

  // ─── SYNC-02 Cierre definitivo (escenarios acumulativos adicionales) ──────────

  const enqueueCard = (queueStore, { companyId, scope, resource, weight = 200, ttlSeconds = 60, maxAttempts = 3, operationKind = 'CARD_SYNC' }) =>
    queueStore.enqueue({
      companyId,
      credentialScope: scope,
      operationKind,
      lockName: 'bsale_operational_prep_sync',
      incompatibleLockNames: coordinatorMod.getIncompatibleLockNames(operationKind),
      resourceKey: resource,
      priority: 'NORMAL',
      priorityWeight: weight,
      ttlSeconds,
      maxAttempts,
      triggerType: 'MANUAL',
      requestedBy: USER_PREP,
      payload: {},
    })

  const lockSnapshot = async (companyId) => (await pg15.pool.query(
    `SELECT owner_token, credential_scope, expires_at, metadata, lease_count
       FROM integraciones.bsale_sync_locks
      WHERE company_id = $1::uuid AND lock_name = 'bsale_operational_prep_sync'`,
    [companyId],
  )).rows

  await t.test('9. complete con request_id incorrecto y owner_token válido de otra solicitud (misma empresa, credencial y lock_name) jamás modifica el bloqueo; lease no asociado al request_id tampoco', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
    const { queueStore } = createPg15Stores(pg15.pool)
    const scope = 'cred:complete-identity'

    // Solicitud D previamente COMPLETED (misma empresa, credencial y lock_name)
    const enqD = await enqueueCard(queueStore, { companyId: COMPANY_CAYLO, scope, resource: 'card:D' })
    const claimD = await queueStore.claimNext({ workerId: 'w-d', credentialScope: scope })
    assert.equal(claimD.request.id, enqD.requestId)
    const doneD = await queueStore.complete({
      requestId: enqD.requestId, companyId: COMPANY_CAYLO, lockName: 'bsale_operational_prep_sync',
      credentialScope: scope, ownerToken: claimD.lease.ownerToken, durationMs: 5,
    })
    assert.equal(doneD.completed, true)

    // Solicitud A en RUNNING con lease vigente
    const enqA = await enqueueCard(queueStore, { companyId: COMPANY_CAYLO, scope, resource: 'card:A' })
    const claimA = await queueStore.claimNext({ workerId: 'w-a', credentialScope: scope })
    assert.equal(claimA.claimed, true)
    assert.equal(claimA.request.id, enqA.requestId)
    const tokenA = claimA.lease.ownerToken

    // Solicitud B PENDING (misma empresa, credencial y lock_name)
    const enqB = await enqueueCard(queueStore, { companyId: COMPANY_CAYLO, scope, resource: 'card:B' })

    const before = await lockSnapshot(COMPANY_CAYLO)
    assert.equal(before.length, 1)
    assert.equal(before[0].owner_token, tokenA)
    assert.equal(before[0].metadata.queue_request_id, enqA.requestId)

    const baseIdentity = { companyId: COMPANY_CAYLO, lockName: 'bsale_operational_prep_sync', credentialScope: scope, ownerToken: tokenA, durationMs: 5 }
    const wrongPending = await queueStore.complete({ ...baseIdentity, requestId: enqB.requestId })
    assert.equal(wrongPending.completed, false)
    assert.equal(wrongPending.reason, 'NOT_OWNER_OR_NOT_RUNNING')

    const wrongCompleted = await queueStore.complete({ ...baseIdentity, requestId: enqD.requestId })
    assert.equal(wrongCompleted.completed, false)
    assert.equal(wrongCompleted.reason, 'NOT_OWNER_OR_NOT_RUNNING')

    const nonExistent = await queueStore.complete({ ...baseIdentity, requestId: '99999999-9999-4999-8999-999999999998' })
    assert.equal(nonExistent.completed, false)

    const wrongFail = await queueStore.failOrRetry({
      ...baseIdentity, requestId: enqB.requestId, errorCode: 'FAKE', errorMessage: 'request_id ajeno', retryable: false,
    })
    assert.equal(wrongFail.updated, false)

    // Ningún bloqueo fue eliminado ni modificado
    const after = await lockSnapshot(COMPANY_CAYLO)
    assert.deepEqual(after, before)
    const states = Object.fromEntries((await pg15.pool.query(
      `SELECT id, status, owner_token FROM integraciones.bsale_sync_queue`,
    )).rows.map(r => [r.id, r]))
    assert.equal(states[enqA.requestId].status, 'RUNNING')
    assert.equal(states[enqA.requestId].owner_token, tokenA)
    assert.equal(states[enqB.requestId].status, 'PENDING')
    assert.equal(states[enqD.requestId].status, 'COMPLETED')

    // Lease vigente con owner_token correcto pero NO asociado al request_id: no se modifica ni se completa
    const client = await pg15.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('integraciones.bsale_sync_coord_bypass', 'on', true)`)
      await client.query(
        `UPDATE integraciones.bsale_sync_locks
            SET metadata = jsonb_set(metadata, '{queue_request_id}', to_jsonb($2::text))
          WHERE company_id = $1::uuid AND lock_name = 'bsale_operational_prep_sync'`,
        [COMPANY_CAYLO, enqB.requestId],
      )
      await client.query('COMMIT')
    } finally {
      client.release()
    }
    const beforeUnassociated = await lockSnapshot(COMPANY_CAYLO)
    const unassociated = await queueStore.complete({ ...baseIdentity, requestId: enqA.requestId })
    assert.equal(unassociated.completed, false)
    assert.equal(unassociated.reason, 'LEASE_EXPIRED_OR_LOST')
    assert.equal(unassociated.leaseAssociated, false)
    assert.deepEqual(await lockSnapshot(COMPANY_CAYLO), beforeUnassociated)
    const aAfter = (await pg15.pool.query(`SELECT status FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`, [enqA.requestId])).rows[0]
    assert.notEqual(aAfter.status, 'COMPLETED')
  })

  await t.test('10. recover y claim_next no bloquean entre credential_scope distintos: ciclo cruzado de advisory locks sin deadlock', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
    const { queueStore } = createPg15Stores(pg15.pool)
    const scopeA = 'cred:xscope-a'
    const scopeB = 'cred:xscope-b'
    const lockKey = scope => `hashtextextended('bsale_sync_coord:${scope}', 0)`

    // RUNNING vencido en el alcance B para forzar a recover a recorrer varios alcances
    const enqStale = await enqueueCard(queueStore, { companyId: COMPANY_INDEPENDENT, scope: scopeB, resource: 'stale:B', ttlSeconds: 1, operationKind: 'WAREHOUSE_MANUAL' })
    const claimStale = await queueStore.claimNext({ workerId: 'stale', credentialScope: scopeB })
    assert.equal(claimStale.request.id, enqStale.requestId)
    await new Promise(resolve => setTimeout(resolve, 1_150))

    const enqA1 = await enqueueCard(queueStore, { companyId: COMPANY_CAYLO, scope: scopeA, resource: 'card:a1', weight: 100 })
    const enqB1 = await enqueueCard(queueStore, { companyId: COMPANY_AMIMASCOTA, scope: scopeB, resource: 'card:b1', weight: 300 })

    const t1 = await pg15.pool.connect()
    const t2 = await pg15.pool.connect()
    const errors = []
    try {
      await t1.query(`SET statement_timeout = '5000'`)
      await t2.query(`SET statement_timeout = '8000'`)

      // T2 retiene el alcance B
      await t2.query('BEGIN')
      await t2.query(`SELECT pg_advisory_xact_lock(${lockKey(scopeB)})`)

      // T1 (transacción abierta) reclama en A: retiene el alcance A hasta su commit
      await t1.query('BEGIN')
      const firstClaim = (await t1.query(`SELECT integraciones.claim_next_bsale_sync_request_v1('t1', $1, 900, 180) AS res`, [scopeA])).rows[0].res
      assert.equal(firstClaim.claimed, true)
      assert.equal(firstClaim.request.id, enqA1.requestId)

      // T2 ahora espera el alcance A (retenido por T1) mientras conserva B
      const t2WaitsForA = t2.query(`SELECT pg_advisory_xact_lock(${lockKey(scopeA)})`).catch(err => { errors.push(err); throw err })
      await new Promise(resolve => setTimeout(resolve, 150))

      // T1 recorre el alcance B (recover + claim sin filtro). Con bloqueos bloqueantes esto formaba un ciclo.
      const started = Date.now()
      const recoverRes = (await t1.query('SELECT integraciones.recover_bsale_sync_queue_v1() AS res')).rows[0].res
      const crossClaim = (await t1.query(`SELECT integraciones.claim_next_bsale_sync_request_v1('t1', NULL, 900, 180) AS res`)).rows[0].res
      const elapsed = Date.now() - started
      assert.equal(elapsed < 1_000, true, `T1 no debe esperar advisory locks de otro alcance (tardó ${elapsed}ms)`)
      assert.equal(Number(recoverRes.skipped_contended) >= 1, true)
      assert.equal(crossClaim.claimed, false)
      assert.ok(crossClaim.next_available_at, 'debe programar reintento breve ante contención')
      assert.equal(Date.parse(crossClaim.next_available_at) - Date.parse(crossClaim.server_now) <= 1_500, true)

      await t1.query('COMMIT')
      await t2WaitsForA
      await t2.query('ROLLBACK')
    } catch (err) {
      errors.push(err)
      await t1.query('ROLLBACK').catch(() => {})
      await t2.query('ROLLBACK').catch(() => {})
      throw err
    } finally {
      t1.release()
      t2.release()
    }
    assert.equal(errors.filter(e => e?.code === '40P01').length, 0)

    // Sin contención: recover recupera el RUNNING vencido de B y claim reclama B por prioridad
    const afterClaim = await queueStore.claimNext({ workerId: 'after', credentialScope: null })
    assert.equal(afterClaim.claimed, true)
    assert.equal(afterClaim.request.id, enqB1.requestId)
    const staleRow = (await pg15.pool.query(`SELECT status FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`, [enqStale.requestId])).rows[0]
    assert.equal(staleRow.status, 'PENDING')
  })

  await t.test('11. Concurrencia real: 8 workers + recover + enqueue cruzado sobre 3 credential_scope sin deadlocks ni dobles ejecuciones', async () => {
    await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
    const { coordinatorStore, queueStore } = createPg15Stores(pg15.pool)
    const tenants = [
      { companyId: COMPANY_CAYLO, scope: 'cred:mw-a' },
      { companyId: COMPANY_AMIMASCOTA, scope: 'cred:mw-b' },
      { companyId: COMPANY_INDEPENDENT, scope: 'cred:mw-c' },
    ]
    const PER_TENANT = 10
    for (let i = 0; i < PER_TENANT; i += 1) {
      for (const tenant of tenants) {
        await enqueueCard(queueStore, { ...tenant, resource: `card:${i}`, weight: 100 + (i % 4) * 50, ttlSeconds: 30, maxAttempts: 5 })
      }
    }

    const errors = []
    const completedIds = []
    const invariantViolations = []
    let extraEnqueued = 0
    let stop = false
    const deadline = Date.now() + 45_000
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

    const pendingOrRunning = async () => Number((await pg15.pool.query(
      `SELECT count(*)::int AS c FROM integraciones.bsale_sync_queue WHERE status IN ('PENDING','RUNNING')`,
    )).rows[0].c)

    const worker = async (idx) => {
      while (!stop && Date.now() < deadline) {
        try {
          const claim = await queueStore.claimNext({ workerId: `mw-${idx}` })
          if (!claim.claimed) {
            await sleep(15 + Math.floor(Math.random() * 20))
            continue
          }
          await sleep(Math.floor(Math.random() * 15))
          const renewed = await coordinatorStore.renew({
            companyId: claim.request.companyId,
            lockName: claim.request.lockName,
            credentialScope: claim.request.credentialScope,
            ownerToken: claim.lease.ownerToken,
            ttlSeconds: 30,
          })
          if (!renewed.renewed) invariantViolations.push(`renew perdido ${claim.request.id}`)
          const done = await queueStore.complete({
            requestId: claim.request.id,
            companyId: claim.request.companyId,
            lockName: claim.request.lockName,
            credentialScope: claim.request.credentialScope,
            ownerToken: claim.lease.ownerToken,
            durationMs: 5,
          })
          if (done.completed) completedIds.push(claim.request.id)
          else invariantViolations.push(`complete rechazado ${claim.request.id}: ${done.reason}`)
        } catch (err) {
          errors.push(err)
        }
      }
    }

    const chaosRecover = async () => {
      while (!stop && Date.now() < deadline) {
        try { await queueStore.recover() } catch (err) { errors.push(err) }
        await sleep(5)
      }
    }

    const chaosEnqueueReverse = async () => {
      for (let round = 0; round < 4 && !stop; round += 1) {
        for (const tenant of [...tenants].reverse()) {
          try {
            await enqueueCard(queueStore, { ...tenant, resource: `extra:${round}`, weight: 250, ttlSeconds: 30, maxAttempts: 5 })
            extraEnqueued += 1
          } catch (err) {
            errors.push(err)
          }
        }
        await sleep(30)
      }
    }

    const sampler = async () => {
      while (!stop && Date.now() < deadline) {
        try {
          const dup = (await pg15.pool.query(
            `SELECT company_id, lock_name, count(*)::int AS c
               FROM integraciones.bsale_sync_queue
              WHERE status = 'RUNNING'
              GROUP BY company_id, lock_name
             HAVING count(*) > 1`,
          )).rows
          if (dup.length > 0) invariantViolations.push(`RUNNING duplicado: ${JSON.stringify(dup)}`)
          if ((await pendingOrRunning()) === 0 && extraEnqueued === tenants.length * 4) stop = true
        } catch (err) {
          errors.push(err)
        }
        await sleep(25)
      }
    }

    await Promise.all([
      ...Array.from({ length: 8 }, (_, idx) => worker(idx)),
      chaosRecover(),
      chaosRecover(),
      chaosEnqueueReverse(),
      sampler(),
    ])

    const deadlocks = errors.filter(e => e?.code === '40P01')
    assert.equal(deadlocks.length, 0, `deadlocks detectados: ${deadlocks.map(e => e.message).join(' | ')}`)
    assert.deepEqual(errors.map(e => e?.message ?? String(e)), [])
    assert.deepEqual(invariantViolations, [])

    const totals = (await pg15.pool.query(
      `SELECT status, count(*)::int AS c FROM integraciones.bsale_sync_queue GROUP BY status`,
    )).rows
    const expectedTotal = tenants.length * PER_TENANT + tenants.length * 4
    assert.deepEqual(totals, [{ status: 'COMPLETED', c: expectedTotal }])
    assert.equal(completedIds.length, expectedTotal)
    assert.equal(new Set(completedIds).size, expectedTotal)
    const leftoverLocks = (await pg15.pool.query(
      `SELECT count(*)::int AS c FROM integraciones.bsale_sync_locks WHERE credential_scope LIKE 'cred:mw-%'`,
    )).rows[0].c
    assert.equal(leftoverLocks, 0)
  })
})
