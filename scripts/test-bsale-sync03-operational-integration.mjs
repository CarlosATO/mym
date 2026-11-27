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
  hasPrepManagePermission: true,
  createSupabase: createSupabaseJsClient,
}

const mockServerUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function createClient() {
  const state = globalThis.__BSALE_SYNC03_TEST_AUTH__
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
  const origRpc = client.rpc.bind(client)
  client.rpc = async (fn, args) => {
    if (fn === 'has_permission') {
      return { data: Boolean(state.hasPrepManagePermission), error: null }
    }
    return origRpc(fn, args)
  }
  return client
}
`)

const mockCompaniesUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function getActiveCompanyId() {
  return globalThis.__BSALE_SYNC03_TEST_AUTH__?.activeCompanyId ?? null
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
    if (specifier === '@/lib/supabase/server') return { url: mockServerUrl, shortCircuit: true }
    if (specifier === '@/app/actions/companies') return { url: mockCompaniesUrl, shortCircuit: true }
    if (specifier === 'next/cache') return { url: mockNextCacheUrl, shortCircuit: true }
    if (specifier === 'next/headers') return { url: mockNextHeadersUrl, shortCircuit: true }
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

globalThis.__BSALE_SYNC03_TEST_AUTH__ = MOCK_AUTH_STATE

const { Pool } = pg
const PG15_BIN = '/opt/homebrew/opt/postgresql@15/bin'

const COMPANY_CAYLO = 'd1000000-0000-0000-0000-000000000001'
const USER_PREP = '11111111-1111-4111-8111-111111111111'
const USER_AUDITOR = '22222222-2222-4222-8222-222222222222'
const CARD_PREP_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const CARD_AUDIT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3'
const AUDIT_ID = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1'

function startIsolatedPostgres15() {
  const dataDir = mkdtempSync('/tmp/pg15-sync03-')
  const socketDir = mkdtempSync('/tmp/pg15-sock03-')
  const port = 55800 + Math.floor(Math.random() * 400)

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
    max: 12,
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

  return { pool, stop }
}

async function startLocalPostgrestAndBsaleServers(pool) {
  const bsaleControl = {
    failDocId: null,
    failStatus: 422,
    delayMs: 0,
  }

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
          if (k === 'p_details') return JSON.stringify(v)
          return v
        })
        const targetFn = schema === 'public' ? `portal.${fnName}` : `${schema}.${fnName}`
        const q = `SELECT ${targetFn}(${argsSql}) AS result`
        const { rows } = await pool.query(q, vals)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(rows[0]?.result ?? null))
        return
      }

      if (url.pathname.startsWith('/rest/v1/')) {
        const table = url.pathname.slice('/rest/v1/'.length)
        const targetSchema = schema === 'public' ? 'portal' : schema
        const fullTable = `${targetSchema}.${table}`

        if (req.method === 'GET' || req.method === 'HEAD') {
          const vals = []
          const whereSql = buildWhereClause(url.searchParams, vals)
          const rawOrder = url.searchParams.get('order')
          let orderSql = ''
          if (rawOrder) {
            const parts = rawOrder.split(',').map(p => {
              const [col, dir] = p.split('.')
              return `${col} ${dir === 'desc' ? 'DESC' : 'ASC'}`
            })
            orderSql = `ORDER BY ${parts.join(', ')}`
          }
          const lim = url.searchParams.get('limit')
          const limitSql = lim ? `LIMIT ${Number(lim)}` : ''
          const { rows } = await pool.query(`SELECT * FROM ${fullTable} ${whereSql} ${orderSql} ${limitSql}`, vals)
          if (req.method === 'HEAD') {
            res.writeHead(200, { 'Content-Range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` })
            res.end()
            return
          }
          res.writeHead(200, {
            'Content-Type': 'application/json',
            ...(prefer.includes('count=exact') ? { 'Content-Range': `0-${Math.max(0, rows.length - 1)}/${rows.length}` } : {}),
          })
          if (wantsSingle) {
            res.end(JSON.stringify(rows[0] ?? null))
          } else {
            res.end(JSON.stringify(rows))
          }
          return
        }

        if (req.method === 'POST') {
          const items = Array.isArray(bodyJson) ? bodyJson : [bodyJson]
          if (items.length === 0) {
            res.writeHead(201, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify([]))
            return
          }
          const cols = Object.keys(items[0])
          const inserted = []
          const onConflict = url.searchParams.get('on_conflict')
          for (const item of items) {
            const vals = cols.map(c => {
              const v = item[c]
              if (v !== null && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v)
              return v
            })
            const placeholders = cols.map((_, idx) => `$${idx + 1}`).join(', ')
            let conflictSql = ''
            if (onConflict && prefer.includes('resolution=merge-duplicates')) {
              const conflictCols = onConflict.split(',').map(s => s.trim())
              const updates = cols.filter(c => !conflictCols.includes(c)).map(c => `${c} = EXCLUDED.${c}`)
              conflictSql = updates.length
                ? `ON CONFLICT (${conflictCols.join(', ')}) DO UPDATE SET ${updates.join(', ')}`
                : `ON CONFLICT (${conflictCols.join(', ')}) DO NOTHING`
            }
            const { rows } = await pool.query(
              `INSERT INTO ${fullTable} (${cols.join(', ')}) VALUES (${placeholders}) ${conflictSql} RETURNING *`,
              vals,
            )
            if (rows[0]) inserted.push(rows[0])
          }
          res.writeHead(201, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(wantsSingle ? (inserted[0] ?? null) : inserted))
          return
        }

        if (req.method === 'PATCH') {
          const cols = Object.keys(bodyJson)
          const vals = cols.map(c => {
            const v = bodyJson[c]
            if (v !== null && typeof v === 'object' && !Array.isArray(v)) return JSON.stringify(v)
            return v
          })
          const setSql = cols.map((c, idx) => `${c} = $${idx + 1}`).join(', ')
          const whereSql = buildWhereClause(url.searchParams, vals)
          const { rows } = await pool.query(`UPDATE ${fullTable} SET ${setSql} ${whereSql} RETURNING *`, vals)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(wantsSingle ? (rows[0] ?? null) : rows))
          return
        }

        if (req.method === 'DELETE') {
          const vals = []
          const whereSql = buildWhereClause(url.searchParams, vals)
          const { rows } = await pool.query(`DELETE FROM ${fullTable} ${whereSql} RETURNING *`, vals)
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(rows))
          return
        }
      }

      res.writeHead(404)
      res.end()
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ message: err.message, code: err.code || 'PGRST_ERR' }))
    }
  })

  const makeNvDoc = (id, folio, token) => ({
    id,
    number: folio,
    token,
    state: 0,
    emissionDate: 1763500000,
    generationDate: 1763500000,
    netAmount: 10000,
    taxAmount: 1900,
    totalAmount: 11900,
    document_type: { id: 23 },
    client: { id: 501 },
    office: { id: 1 },
    details: {
      count: 1,
      items: [{
        id: id * 10 + 1,
        lineNumber: 0,
        quantity: 2,
        netUnitValue: 5000,
        totalUnitValue: 5950,
        netAmount: 10000,
        taxAmount: 1900,
        totalAmount: 11900,
        netDiscount: 0,
        variant: { id: 9001, code: 'SKU-SYNC03', description: 'Alimento Sync03' },
      }],
    },
  })

  const nvById = new Map([
    [7001, makeNvDoc(7001, 5501, 'tok-card-7001')],
    [7003, makeNvDoc(7003, 5503, 'tok-aud-7003')],
  ])

  const bsaleServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (bsaleControl.delayMs > 0) {
      await new Promise(r => setTimeout(r, bsaleControl.delayMs))
    }

    const docMatch = url.pathname.match(/^\/v1\/documents\/(\d+)\.json$/)
    if (docMatch) {
      const docId = Number(docMatch[1])
      if (bsaleControl.failDocId === docId) {
        res.writeHead(bsaleControl.failStatus, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: `Fallo controlado Bsale doc ${docId}` }))
        return
      }
      const doc = nvById.get(docId)
      if (!doc) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Not found' }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(doc))
      return
    }

    const detailMatch = url.pathname.match(/^\/v1\/documents\/(\d+)\/details\.json$/)
    if (detailMatch) {
      const docId = Number(detailMatch[1])
      const doc = nvById.get(docId)
      const items = doc ? doc.details.items : []
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ count: items.length, items }))
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

    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ count: 0, items: [] }))
  })

  await new Promise(resolve => supabaseServer.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => bsaleServer.listen(0, '127.0.0.1', resolve))

  return {
    supabaseUrl: `http://127.0.0.1:${supabaseServer.address().port}`,
    bsaleBaseUrl: `http://127.0.0.1:${bsaleServer.address().port}/v1`,
    bsaleControl,
    async close() {
      await new Promise(resolve => supabaseServer.close(resolve))
      await new Promise(resolve => bsaleServer.close(resolve))
    },
  }
}

async function bootstrapSchema(pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE SCHEMA IF NOT EXISTS portal;
    CREATE SCHEMA IF NOT EXISTS integraciones;
    CREATE SCHEMA IF NOT EXISTS logistica;

    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;

    CREATE TABLE core.companies (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO core.companies (id, name) VALUES ('${COMPANY_CAYLO}', 'PetGroup / Caylo');

    CREATE TABLE portal.users (
      id uuid PRIMARY KEY,
      email text,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz
    );
    INSERT INTO portal.users (id, email) VALUES
      ('${USER_PREP}', 'prep@mym.cl'),
      ('${USER_AUDITOR}', 'auditor@mym.cl');

    CREATE TABLE core.user_company_access (
      user_id uuid NOT NULL,
      company_id uuid NOT NULL REFERENCES core.companies(id),
      role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, company_id)
    );
    INSERT INTO core.user_company_access (user_id, company_id, role) VALUES
      ('${USER_PREP}', '${COMPANY_CAYLO}', 'OPERADOR_BODEGA'),
      ('${USER_AUDITOR}', '${COMPANY_CAYLO}', 'AUDITOR_BODEGA');

    CREATE TABLE portal.test_user_permissions (
      user_id uuid NOT NULL,
      permission_code text NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    );
    INSERT INTO portal.test_user_permissions (user_id, permission_code) VALUES
      ('${USER_PREP}', 'module.logistica.view'),
      ('${USER_PREP}', 'logistica.preparation.manage'),
      ('${USER_AUDITOR}', 'module.logistica.view'),
      ('${USER_AUDITOR}', 'logistica.audit.manage');

    CREATE OR REPLACE FUNCTION portal.user_has_permission(p_user_id uuid, p_permission_code text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM portal.test_user_permissions
         WHERE user_id = p_user_id AND permission_code = p_permission_code
      );
    $$;

    CREATE TABLE integraciones.bsale_sync_locks (
      company_id uuid NOT NULL REFERENCES core.companies(id),
      lock_name text NOT NULL,
      run_id uuid,
      acquired_at timestamptz NOT NULL DEFAULT now(),
      expires_at timestamptz NOT NULL,
      metadata jsonb,
      PRIMARY KEY (company_id, lock_name)
    );

    CREATE TABLE integraciones.bsale_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL REFERENCES core.companies(id),
      status text NOT NULL,
      trigger text,
      date_from text,
      date_to text,
      documents_count int,
      document_details_count int,
      metrics jsonb,
      error_message text,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );

    CREATE TABLE integraciones.sync_errors (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sync_run_id uuid,
      company_id uuid,
      provider text,
      entity text,
      error_code text,
      error_message text
    );

    CREATE TABLE integraciones.bsale_documents (
      company_id uuid NOT NULL,
      bsale_id bigint NOT NULL,
      number bigint,
      emission_date text,
      generation_date timestamptz,
      total_amount numeric,
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
    INSERT INTO integraciones.vw_bsale_sales_order_items_for_preparation VALUES
      ('${COMPANY_CAYLO}', 7001, 9001, 'Alimento Sync03'),
      ('${COMPANY_CAYLO}', 7003, 9001, 'Alimento Sync03');

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
    INSERT INTO logistica.sales_order_preparation_cards VALUES
      ('${CARD_PREP_ID}', '${COMPANY_CAYLO}', 'IN_PREPARATION', 7001, '5501', 'tok-card-7001', 7001),
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

    CREATE TABLE logistica.sales_order_audits (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      status text NOT NULL,
      cycle_no int NOT NULL DEFAULT 1,
      locked_by_user_id uuid
    );
    INSERT INTO logistica.sales_order_audits VALUES
      ('${AUDIT_ID}', '${COMPANY_CAYLO}', '${CARD_AUDIT_ID}', 'OPEN', 1, '${USER_AUDITOR}');

    CREATE OR REPLACE FUNCTION logistica.reconcile_bodega_preparation_cards(p_company_id uuid)
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('discovered', 2, 'created', 1, 'relations_created', 0, 'closed_invoiced', 0, 'closed_cancelled', 0, 'closed_non_operational', 0, 'skipped_invoiced', 0);
    $$;

    CREATE OR REPLACE FUNCTION logistica.verify_open_preparation_incidents_v1(p_company_id uuid, p_bsale_nv_ids bigint[])
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('verified', 0);
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

test('SYNC-03 Cierre definitivo de integración operativa (UI, políticas y cola persistente en PostgreSQL 15)', async (t) => {
  const policyMod = await import('../src/modules/logistica/preparacion-pedidos/preparation-sync-policy.ts')

  await t.test('1. Retiro del botón de sincronización general en Preparación de Pedidos conservando actualización NV e individual', () => {
    const topbarControlSrc = readFileSync(path.join(PROJECT_ROOT, 'src/components/integraciones/bsale-replenishment-topbar-control.tsx'), 'utf8')
    const appTopbarSrc = readFileSync(path.join(PROJECT_ROOT, 'src/components/layout/app-topbar.tsx'), 'utf8')
    const panelSrc = readFileSync(path.join(PROJECT_ROOT, 'src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx'), 'utf8')
    const cardSrc = readFileSync(path.join(PROJECT_ROOT, 'src/modules/logistica/preparacion-pedidos/sales-order-card.tsx'), 'utf8')
    const drawerSrc = readFileSync(path.join(PROJECT_ROOT, 'src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx'), 'utf8')
    const auditDrawerSrc = readFileSync(path.join(PROJECT_ROOT, 'src/modules/logistica/auditoria/sales-order-audit-drawer.tsx'), 'utf8')

    // En Preparación de Pedidos (explícito o landing por defecto), la superficie oculta BsaleReplenishmentTopbarControl
    assert.equal(policyMod.isPreparationOrdersTopbarSurface({
      pathname: '/dashboard/logistica',
      tab: 'preparacion_pedidos',
      roleName: 'SUPER_USUARIO',
      permissions: ['system.admin'],
    }), true)
    assert.equal(policyMod.isPreparationOrdersTopbarSurface({
      pathname: '/dashboard/logistica',
      tab: null,
      roleName: 'SUPER_USUARIO',
      permissions: ['system.admin'],
    }), true)
    assert.equal(policyMod.isPreparationOrdersTopbarSurface({
      pathname: '/dashboard/logistica',
      tab: null,
      roleName: 'OPERADOR_BODEGA',
      permissions: ['module.logistica.view'],
    }), true)

    // Fuera de Preparación de Pedidos se conserva el botón general
    assert.equal(policyMod.isPreparationOrdersTopbarSurface({
      pathname: '/dashboard',
      tab: null,
      roleName: 'SUPER_USUARIO',
      permissions: ['system.admin'],
    }), false)
    assert.equal(policyMod.isPreparationOrdersTopbarSurface({
      pathname: '/dashboard/adquisiciones/ordenes-compra',
      tab: null,
      roleName: 'SUPER_USUARIO',
      permissions: ['system.admin'],
    }), false)
    assert.equal(policyMod.isPreparationOrdersTopbarSurface({
      pathname: '/dashboard/logistica',
      tab: 'movimientos',
      roleName: 'SUPER_USUARIO',
      permissions: ['system.admin'],
    }), false)
    assert.equal(policyMod.isPreparationOrdersTopbarSurface({
      pathname: '/dashboard/logistica/mermas',
      tab: null,
      roleName: 'SUPER_USUARIO',
      permissions: ['system.admin'],
    }), false)

    assert.match(topbarControlSrc, /if \(hiddenOnPreparation\)\s*\{\s*return null\s*\}/)
    assert.match(appTopbarSrc, /roleName=\{profile\.roles\?\.name\}/)
    // Conservación estricta de actualización de NV y sincronización individual
    assert.match(panelSrc, /aria-label="Actualizar Notas de Venta"/)
    assert.doesNotMatch(panelSrc, /forceSyncBsaleReplenishment|runReplenishmentBsaleSync/)
    assert.match(cardSrc, /onSyncCard/)
    assert.match(drawerSrc, /Sincronización puntual Bsale/)
    assert.match(auditDrawerSrc, /Sincronización comercial Bsale/)
  })

  await t.test('2. Máquina de estados reales (espera, ejecución, finalización y error) y refresco exclusivo tras éxito', () => {
    // Estado WAITING (PENDING en cola): incluso si latestRun registró SKIPPED_LOCKED: como FAILED, NO marca ERROR
    const waitingState = policyMod.resolvePreparationBoardSyncUiState({
      isLocalSyncing: false,
      queueStatus: 'PENDING',
      activeLockRunning: false,
      latestRunStatus: 'FAILED',
      latestRunErrorMessage: 'SKIPPED_LOCKED: Sincronización Bsale ocupada',
      syncError: null,
      lastSuccessAgeMinutes: 12,
      hasHealth: true,
    })
    assert.equal(waitingState.phase, 'WAITING')
    assert.equal(waitingState.isWaiting, true)
    assert.equal(waitingState.isError, false)
    assert.equal(waitingState.disableManualRefresh, true)
    assert.equal(waitingState.buttonLabel, 'En espera…')
    assert.equal(waitingState.statusLabel, 'En espera…')

    // Estado RUNNING
    const runningState = policyMod.resolvePreparationBoardSyncUiState({
      isLocalSyncing: false,
      queueStatus: 'RUNNING',
      activeLockRunning: true,
      latestRunStatus: 'STARTED',
      syncError: null,
      lastSuccessAgeMinutes: 12,
      hasHealth: true,
    })
    assert.equal(runningState.phase, 'RUNNING')
    assert.equal(runningState.disableManualRefresh, true)
    assert.equal(runningState.buttonLabel, 'Sincronizando…')

    // Estado ERROR real
    const errorState = policyMod.resolvePreparationBoardSyncUiState({
      isLocalSyncing: false,
      queueStatus: 'FAILED',
      activeLockRunning: false,
      latestRunStatus: 'FAILED',
      latestRunErrorMessage: 'Bsale HTTP 500',
      syncError: 'Bsale HTTP 500',
      lastSuccessAgeMinutes: 12,
      hasHealth: true,
    })
    assert.equal(errorState.phase, 'ERROR')
    assert.equal(errorState.isError, true)
    assert.equal(errorState.disableManualRefresh, false)
    assert.equal(errorState.statusLabel, 'ERROR')

    // Guardia de actualización del tablero: SOLO en COMPLETED sin omisión y nunca dos veces tras recarga
    const processed = new Set()
    assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
      requestId: 'req-1',
      nextStatus: 'PENDING',
      alreadyProcessedIds: processed,
    }), false)
    assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
      requestId: 'req-1',
      nextStatus: 'RUNNING',
      alreadyProcessedIds: processed,
    }), false)
    assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
      requestId: 'req-1',
      nextStatus: 'FAILED',
      alreadyProcessedIds: processed,
    }), false)
    assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
      requestId: 'req-1',
      nextStatus: 'CANCELLED',
      alreadyProcessedIds: processed,
    }), false)
    assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
      requestId: 'req-skip',
      nextStatus: 'COMPLETED',
      skippedReason: 'CARD_LEFT_PREPARATION',
      alreadyProcessedIds: processed,
    }), false)
    assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
      requestId: 'req-1',
      nextStatus: 'COMPLETED',
      alreadyProcessedIds: processed,
    }), true)

    processed.add('req-1')
    // Recarga posterior: no vuelve a refrescar por el mismo requestId ya procesado
    assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
      requestId: 'req-1',
      nextStatus: 'COMPLETED',
      alreadyProcessedIds: processed,
    }), false)
  })

  await t.test('3. Integración E2E sobre PostgreSQL 15: encolado, prevención de duplicados tras recarga (PENDING y RUNNING), ejecución automática y error sin refresco', async () => {
    const prevEnv = {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
      BSALE_API_BASE_URL: process.env.BSALE_API_BASE_URL,
      BSALE_ACCESS_TOKEN: process.env.BSALE_ACCESS_TOKEN,
      BSALE_ACCESS_TOKEN_CAYLO: process.env.BSALE_ACCESS_TOKEN_CAYLO,
      BSALE_SYNC_COORDINATOR_ENABLED: process.env.BSALE_SYNC_COORDINATOR_ENABLED,
      BSALE_SYNC_QUEUE_ENABLED: process.env.BSALE_SYNC_QUEUE_ENABLED,
      BSALE_SYNC_SUPERVISOR_ENABLED: process.env.BSALE_SYNC_SUPERVISOR_ENABLED,
    }

    const pg15 = startIsolatedPostgres15()
    let localServers = null
    let runtimeMod = null
    let queueMod = null

    try {
      await bootstrapSchema(pg15.pool)
      localServers = await startLocalPostgrestAndBsaleServers(pg15.pool)

      process.env.NEXT_PUBLIC_SUPABASE_URL = localServers.supabaseUrl
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'test-anon'
      process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-service'
      process.env.BSALE_API_BASE_URL = localServers.bsaleBaseUrl
      process.env.BSALE_ACCESS_TOKEN = 'test-token-sync03'
      process.env.BSALE_ACCESS_TOKEN_CAYLO = 'test-token-sync03'
      process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'true'
      process.env.BSALE_SYNC_QUEUE_ENABLED = 'true'
      process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'false'

      const coordinatorMod = await import('../src/lib/integraciones/bsale-sync-coordinator.ts')
      queueMod = await import('../src/lib/integraciones/bsale-sync-queue.ts')
      runtimeMod = await import('../src/lib/integraciones/bsale-sync-queue-runtime.ts')
      const prepActionsMod = await import('../src/app/actions/logistica/sales-order-preparation.ts')
      const incSyncMod = await import('../src/app/actions/logistica/sales-order-preparation-incident-sync.ts')
      const queueActionsMod = await import('../src/app/actions/logistica/sales-order-preparation-sync-queue.ts')

      runtimeMod.resetBsaleSyncQueueRuntimeForTests()
      queueMod.resetGlobalBsaleSyncQueueManagerForTests()
      runtimeMod.ensureBsaleSyncQueueRuntimeRegistered()

      // Adquirir bloqueo incompatible para forzar espera real en cola (SYNC-02)
      const cayloScope = coordinatorMod.resolveBsaleCredentialScope(COMPANY_CAYLO)
      const blockerToken = 'sync03-blocker'
      await pg15.pool.query(
        `SELECT integraciones.acquire_bsale_sync_lock_v1($1::uuid, 'bsale_warehouse_full_refresh', $2::text, 'WAREHOUSE_FULL_REFRESH', $3::text, NULL, NULL, 300, ARRAY['bsale_replenishment_sync','bsale_operational_prep_sync','bsale_warehouse_full_refresh'])`,
        [COMPANY_CAYLO, blockerToken, cayloScope],
      )

      MOCK_AUTH_STATE.cookieSessionAvailable = true
      MOCK_AUTH_STATE.currentUserId = USER_PREP
      MOCK_AUTH_STATE.activeCompanyId = COMPANY_CAYLO

      // 1) Solicitar actualización NV + sincronización individual de tarjeta
      const nvFirst = await prepActionsMod.syncOperationalBsaleSalesOrders()
      assert.equal(nvFirst.ok, false)
      assert.equal(nvFirst.status, 'SKIPPED_LOCKED')
      assert.equal(nvFirst.queued, true)
      assert.equal(nvFirst.queueStatus, 'PENDING')
      assert.ok(nvFirst.queueRequestId)

      const cardFirst = await incSyncMod.syncSalesOrderPreparationCardFromBsale(CARD_PREP_ID)
      assert.equal(cardFirst.ok, false)
      assert.equal(cardFirst.status, 'CONFLICT')
      assert.equal(cardFirst.queued, true)
      assert.equal(cardFirst.queueStatus, 'PENDING')
      assert.ok(cardFirst.queueRequestId)

      MOCK_AUTH_STATE.currentUserId = USER_AUDITOR
      const auditFirst = await incSyncMod.syncSalesOrderAuditCardFromBsale(CARD_AUDIT_ID)
      assert.equal(auditFirst.ok, false)
      assert.equal(auditFirst.queued, true)
      assert.equal(auditFirst.queueStatus, 'PENDING')
      assert.ok(auditFirst.queueRequestId)

      // 2) Simular recarga completa de pantalla (sin memoria cliente, ni siquiera trackedRequestIds)
      const reloadSnap = await queueActionsMod.getPreparationSyncQueueSnapshot()
      assert.equal(reloadSnap.error, null)
      assert.equal(reloadSnap.data.queueAvailable, true)
      assert.equal(reloadSnap.data.boardSync.status, 'PENDING')
      assert.equal(reloadSnap.data.boardSync.requestId, nvFirst.queueRequestId)
      assert.equal(reloadSnap.data.cardSyncsByCardId[CARD_PREP_ID].status, 'PENDING')
      assert.equal(reloadSnap.data.cardSyncsByCardId[CARD_PREP_ID].requestId, cardFirst.queueRequestId)
      assert.equal(reloadSnap.data.cardSyncsByCardId[CARD_AUDIT_ID].status, 'PENDING')
      assert.equal(reloadSnap.data.cardSyncsByCardId[CARD_AUDIT_ID].requestId, auditFirst.queueRequestId)

      // 3) Reintentar tras recarga mientras siguen PENDING: deduplicación total, sin filas ni corridas extra
      const runsBeforeDup = (await pg15.pool.query(`SELECT count(*)::int AS c FROM integraciones.bsale_sync_runs`)).rows[0].c
      MOCK_AUTH_STATE.currentUserId = USER_PREP
      const nvDupPending = await prepActionsMod.syncOperationalBsaleSalesOrders()
      assert.equal(nvDupPending.deduplicated, true)
      assert.equal(nvDupPending.queueRequestId, nvFirst.queueRequestId)
      assert.equal(nvDupPending.queueStatus, 'PENDING')

      const cardDupPending = await incSyncMod.syncSalesOrderPreparationCardFromBsale(CARD_PREP_ID)
      assert.equal(cardDupPending.deduplicated, true)
      assert.equal(cardDupPending.queueRequestId, cardFirst.queueRequestId)

      const staleAutoWhilePending = await prepActionsMod.syncOperationalBsaleSalesOrdersIfStale()
      assert.equal(staleAutoWhilePending.ok, true)
      assert.equal(staleAutoWhilePending.skipped, 'running')
      assert.equal(staleAutoWhilePending.queueRequestId, nvFirst.queueRequestId)

      const queueCountPending = (await pg15.pool.query(`SELECT count(*)::int AS c FROM integraciones.bsale_sync_queue`)).rows[0].c
      const runsAfterDup = (await pg15.pool.query(`SELECT count(*)::int AS c FROM integraciones.bsale_sync_runs`)).rows[0].c
      assert.equal(queueCountPending, 3, 'No deben crearse filas duplicadas en cola')
      assert.equal(runsAfterDup, runsBeforeDup, 'No deben crearse bsale_sync_runs huérfanos al deduplicar tras recarga')

      // 4) Activar supervisor y liberar el bloqueo con latencia controlada en Bsale (120ms) para verificar estado RUNNING y deduplicación durante RUNNING
      process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'true'
      localServers.bsaleControl.delayMs = 120
      await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().release({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_warehouse_full_refresh',
        credentialScope: cayloScope,
        ownerToken: blockerToken,
      })
      // El hook de liberación / snapshot impulsa la ejecución automática sin intervención manual
      await queueActionsMod.getPreparationSyncQueueSnapshot({
        trackedRequestIds: [nvFirst.queueRequestId, cardFirst.queueRequestId, auditFirst.queueRequestId],
      })

      await new Promise(r => setTimeout(r, 40))
      const runningSnap = await queueActionsMod.getPreparationSyncQueueSnapshot({
        trackedRequestIds: [nvFirst.queueRequestId, cardFirst.queueRequestId, auditFirst.queueRequestId],
      })
      // CARD_SYNC (peso 300) entra primero a RUNNING
      assert.equal(runningSnap.data.cardSyncsByCardId[CARD_PREP_ID]?.status, 'RUNNING')
      const cardDupWhileRunning = await incSyncMod.syncSalesOrderPreparationCardFromBsale(CARD_PREP_ID)
      assert.equal(cardDupWhileRunning.ok, false)
      assert.equal(cardDupWhileRunning.status, 'IN_PROGRESS')
      assert.equal(cardDupWhileRunning.deduplicated, true)
      assert.equal(cardDupWhileRunning.queueStatus, 'RUNNING')

      // Esperar a que la cola drene automáticamente las 3 solicitudes pendientes
      localServers.bsaleControl.delayMs = 0
      const deadline = Date.now() + 8_000
      let finalSnap = null
      while (Date.now() < deadline) {
        finalSnap = await queueActionsMod.getPreparationSyncQueueSnapshot({
          trackedRequestIds: [nvFirst.queueRequestId, cardFirst.queueRequestId, auditFirst.queueRequestId],
        })
        const tracked = finalSnap.data.trackedRequests
        if (
          tracked[nvFirst.queueRequestId]?.status === 'COMPLETED'
          && tracked[cardFirst.queueRequestId]?.status === 'FAILED'
          && tracked[auditFirst.queueRequestId]?.status === 'FAILED'
        ) {
          break
        }
        await new Promise(r => setTimeout(r, 60))
      }

      assert.equal(finalSnap.data.boardSync, null)
      assert.deepEqual(finalSnap.data.cardSyncsByCardId, {})
      assert.equal(finalSnap.data.trackedRequests[nvFirst.queueRequestId].status, 'COMPLETED')
      // Este fixture deliberadamente no contiene el esquema de reconciliación individual.
      // El worker debe fallar cerrado, nunca comunicar COMPLETED por un espejo parcial.
      assert.equal(finalSnap.data.trackedRequests[cardFirst.queueRequestId].status, 'FAILED')
      assert.equal(finalSnap.data.trackedRequests[auditFirst.queueRequestId].status, 'FAILED')

      const queueCountAfterDrain = (await pg15.pool.query(`SELECT count(*)::int AS c FROM integraciones.bsale_sync_queue`)).rows[0].c
      assert.equal(queueCountAfterDrain, 3, 'Exactamente las 3 solicitudes originales se completaron sin duplicados')

      // 5) Caso de ERROR real en cola: estado FAILED visible y prohibición de refrescar tablero
      localServers.bsaleControl.failDocId = 7001
      localServers.bsaleControl.failStatus = 422
      const failEnq = await queueMod.getGlobalBsaleSyncQueueManager().enqueue({
        companyId: COMPANY_CAYLO,
        operationKind: 'CARD_SYNC',
        resourceKey: `card:${CARD_PREP_ID}`,
        requestedBy: USER_PREP,
        maxAttempts: 1,
        payload: { cardId: CARD_PREP_ID },
        autoTriggerDrain: false,
      })
      await queueMod.getGlobalBsaleSyncQueueManager().drain()

      const failedSnap = await queueActionsMod.getPreparationSyncQueueSnapshot({
        trackedRequestIds: [failEnq.requestId],
      })
      const failedEntry = failedSnap.data.trackedRequests[failEnq.requestId]
      assert.equal(failedEntry.status, 'FAILED')
      assert.ok(failedEntry.lastErrorMessage)
      assert.equal(policyMod.shouldRefreshPreparationBoardOnQueueTransition({
        requestId: failEnq.requestId,
        nextStatus: failedEntry.status,
        alreadyProcessedIds: new Set(),
      }), false)
    } finally {
      try { runtimeMod?.resetBsaleSyncQueueRuntimeForTests() } catch { /* noop */ }
      try { queueMod?.resetGlobalBsaleSyncQueueManagerForTests() } catch { /* noop */ }
      if (localServers) await localServers.close().catch(() => {})
      await pg15.stop().catch(() => {})
      for (const [k, v] of Object.entries(prevEnv)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }
  })
})
