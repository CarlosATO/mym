import { createClient as createSupabaseJsClient } from '@supabase/supabase-js'
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { constants, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
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
globalThis.__BSALE_SYNC04_TEST_AUTH__ = MOCK_AUTH_STATE

const mockServerUrl = 'data:text/javascript,' + encodeURIComponent(`
export async function createClient() {
  const state = globalThis.__BSALE_SYNC04_TEST_AUTH__
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
  const state = globalThis.__BSALE_SYNC04_TEST_AUTH__
  if (!state || !state.cookieSessionAvailable) {
    throw new Error('NO_BROWSER_SESSION_COOKIES_AVAILABLE')
  }
  return state.activeCompanyId ?? null
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

const mockNextServerUrl = 'data:text/javascript,' + encodeURIComponent(`
export const NextResponse = {
  json(body, init = {}) {
    return new Response(JSON.stringify(body), {
      status: init.status ?? 200,
      headers: { 'content-type': 'application/json', ...(init.headers ?? {}) },
    })
  },
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
      // ignore missing candidate
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
    if (specifier === 'next/server') return { url: mockNextServerUrl, shortCircuit: true }
    if (specifier.startsWith('@/')) {
      const target = path.join(PROJECT_ROOT, 'src', specifier.slice(2))
      const resolved = resolveTsFileCandidate(target)
      if (resolved) return { url: resolved, shortCircuit: true }
    }
    if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL?.startsWith('file://')) {
      const parentDir = path.dirname(fileURLToPath(context.parentURL))
      const target = path.resolve(parentDir, specifier)
      const resolved = resolveTsFileCandidate(target)
      if (resolved) return { url: resolved, shortCircuit: true }
    }
    return nextResolve(specifier, context)
  },
  load(url, context, nextLoad) {
    if (url.startsWith('file://') && (url.endsWith('.ts') || url.endsWith('.tsx')) && !url.includes('/node_modules/')) {
      const filePath = fileURLToPath(url)
      const source = readFileSync(filePath, 'utf8')
      const transpiled = ts.transpileModule(source, {
        fileName: filePath,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
        },
      })
      return { format: 'module', source: transpiled.outputText, shortCircuit: true }
    }
    return nextLoad(url, context)
  },
})

const COMPANY_CAYLO = 'd1000000-0000-0000-0000-000000000001'
const USER_PREP = '00000000-0000-4000-8000-000000000401'
const USER_AUDITOR = '00000000-0000-4000-8000-000000000402'

const CARD_PREP_CONFORMING_ID = '00000000-0000-4000-8000-000000000601'
const CARD_PREP_BLOCKED_ID = '00000000-0000-4000-8000-000000000602'
const CARD_AUDIT_READY_ID = '00000000-0000-4000-8000-000000000603'
const CARD_INCIDENT_ID = '00000000-0000-4000-8000-000000000604'
const AUDIT_READY_ID = '00000000-0000-4000-8000-000000000701'
const INCIDENT_OPEN_ID = '00000000-0000-4000-8000-000000000801'

function findPg15BinDir() {
  const candidates = ['/opt/homebrew/opt/postgresql@15/bin', '/usr/local/opt/postgresql@15/bin']
  for (const dir of candidates) {
    try {
      if (statSync(path.join(dir, 'initdb')).isFile()) return dir
    } catch {
      // ignore
    }
  }
  throw new Error('No se encontró PostgreSQL 15 local (initdb/pg_ctl) para ejecutar pruebas reales.')
}

function startIsolatedPostgres15() {
  const binDir = findPg15BinDir()
  const tmpDir = mkdtempSync('/tmp/mym-sync04-pg15-')
  const dataDir = path.join(tmpDir, 'data')
  const port = 55600 + Math.floor(Math.random() * 800)

  execFileSync(path.join(binDir, 'initdb'), ['-D', dataDir, '-U', 'postgres', '-A', 'trust', '--no-locale', '-E', 'UTF8'], { stdio: 'ignore' })
  execFileSync(
    path.join(binDir, 'pg_ctl'),
    ['-D', dataDir, '-l', path.join(tmpDir, 'pg.log'), '-o', `-p ${port} -k ${tmpDir} -h 127.0.0.1`, '-w', 'start'],
    { stdio: 'ignore' },
  )

  const pool = new pg.Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'postgres',
    max: 24,
  })

  return {
    pool,
    async stop() {
      await pool.end().catch(() => {})
      try {
        execFileSync(path.join(binDir, 'pg_ctl'), ['-D', dataDir, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore' })
      } catch {
        // ignore
      }
      rmSync(tmpDir, { recursive: true, force: true })
    },
  }
}

async function bootstrapFullSchemaFromLegacyMigration(pool) {
  await pool.query(`
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;

    CREATE SCHEMA IF NOT EXISTS auth;
    CREATE SCHEMA IF NOT EXISTS core;
    CREATE SCHEMA IF NOT EXISTS portal;
    CREATE SCHEMA IF NOT EXISTS integraciones;
    CREATE SCHEMA IF NOT EXISTS logistica;

    CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
      SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid;
    $$;
    CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
      SELECT COALESCE(NULLIF(current_setting('request.jwt.claim.role', true), ''), 'service_role');
    $$;

    CREATE TABLE core.companies (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO core.companies (id, name, is_active) VALUES
      ('${COMPANY_CAYLO}', 'Caylo', true);

    CREATE OR REPLACE FUNCTION core.has_company_access(p_user_id uuid, p_company_id uuid)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT p_user_id IS NOT NULL AND p_company_id IS NOT NULL;
    $$;
    CREATE OR REPLACE FUNCTION core.has_permission_for_company(p_user_id uuid, p_company_id uuid, p_perm text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT p_user_id IS NOT NULL AND p_company_id IS NOT NULL AND p_perm IS NOT NULL;
    $$;

    CREATE TABLE portal.roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL UNIQUE);
    INSERT INTO portal.roles (id, name) VALUES ('00000000-0000-4000-8000-000000000010', 'OPERADOR_BODEGA');

    CREATE TABLE portal.users (
      id uuid PRIMARY KEY,
      email text,
      nombre text,
      apellido text,
      is_active boolean NOT NULL DEFAULT true,
      deleted_at timestamptz,
      role_id uuid REFERENCES portal.roles(id)
    );
    INSERT INTO portal.users (id, email, nombre, apellido, is_active, role_id) VALUES
      ('${USER_PREP}', 'prep@mym.cl', 'Operador', 'Prep', true, '00000000-0000-4000-8000-000000000010'),
      ('${USER_AUDITOR}', 'aud@mym.cl', 'Auditor', 'Bodega', true, '00000000-0000-4000-8000-000000000010');

    CREATE TABLE core.user_company_access (
      user_id uuid NOT NULL,
      company_id uuid NOT NULL,
      role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      PRIMARY KEY (user_id, company_id)
    );
    INSERT INTO core.user_company_access (user_id, company_id, role, is_active) VALUES
      ('${USER_PREP}', '${COMPANY_CAYLO}', 'OPERADOR_BODEGA', true),
      ('${USER_AUDITOR}', '${COMPANY_CAYLO}', 'OPERADOR_BODEGA', true);

    CREATE TABLE portal.user_permissions (
      user_id uuid NOT NULL,
      permission_code text NOT NULL,
      PRIMARY KEY (user_id, permission_code)
    );
    INSERT INTO portal.user_permissions (user_id, permission_code) VALUES
      ('${USER_PREP}', 'module.logistica.view'),
      ('${USER_PREP}', 'logistica.preparation.manage'),
      ('${USER_AUDITOR}', 'module.logistica.view'),
      ('${USER_AUDITOR}', 'logistica.audit.manage');

    CREATE OR REPLACE FUNCTION portal.user_has_permission(p_user_id uuid, p_permission_code text)
    RETURNS boolean LANGUAGE sql STABLE AS $$
      SELECT EXISTS (
        SELECT 1 FROM portal.user_permissions
         WHERE user_id = p_user_id AND permission_code = p_permission_code
      );
    $$;

    CREATE OR REPLACE FUNCTION portal.has_permission(p_permission_code text)
    RETURNS boolean LANGUAGE plpgsql STABLE AS $$
    DECLARE v_uid uuid;
    BEGIN
      v_uid := NULLIF(current_setting('app.mock_uid', true), '')::uuid;
      IF v_uid IS NULL THEN RETURN true; END IF;
      RETURN portal.user_has_permission(v_uid, p_permission_code);
    END;
    $$;

    CREATE TABLE integraciones.bsale_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      status text NOT NULL,
      trigger text NOT NULL,
      started_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz,
      date_from text,
      date_to text,
      products_fetched int DEFAULT 0,
      variants_upserted int DEFAULT 0,
      clients_fetched int DEFAULT 0,
      clients_inserted int DEFAULT 0,
      clients_updated int DEFAULT 0,
      documents_count int DEFAULT 0,
      document_errors int DEFAULT 0,
      document_details_count int DEFAULT 0,
      detail_errors int DEFAULT 0,
      costs_upserted int DEFAULT 0,
      stock_rows_upserted int DEFAULT 0,
      error_message text,
      metrics jsonb DEFAULT '{}'::jsonb
    );

    CREATE TABLE integraciones.sync_errors (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      sync_run_id uuid,
      company_id uuid,
      provider text,
      entity text,
      error_code text,
      error_message text,
      created_at timestamptz DEFAULT now()
    );

    CREATE TABLE integraciones.bsale_documents (
      company_id uuid NOT NULL,
      bsale_id bigint NOT NULL,
      number bigint,
      emission_date text,
      generation_date timestamptz,
      expiration_date text,
      total_amount numeric,
      net_amount numeric,
      tax_amount numeric,
      exempt_amount numeric,
      document_type_id int,
      client_id bigint,
      office_id int,
      user_id bigint,
      state int,
      informed_sii int,
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
    ) RETURNS jsonb LANGUAGE plpgsql AS $$
    DECLARE
      v_doc_id bigint := (p_document->>'bsale_id')::bigint;
      v_det jsonb;
    BEGIN
      INSERT INTO integraciones.bsale_documents (
        company_id, bsale_id, number, emission_date, generation_date,
        total_amount, net_amount, tax_amount, exempt_amount, document_type_id,
        client_id, office_id, state, raw_json, bsale_sync_run_id, synced_at
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
      ('${COMPANY_CAYLO}', 9101, 9901, 'Alimento Premium Perro'),
      ('${COMPANY_CAYLO}', 9102, 9901, 'Alimento Premium Perro'),
      ('${COMPANY_CAYLO}', 9103, 9901, 'Alimento Premium Perro'),
      ('${COMPANY_CAYLO}', 9104, 9901, 'Alimento Premium Perro');

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
      ('${CARD_PREP_CONFORMING_ID}', '${COMPANY_CAYLO}', 'IN_PREPARATION', 9101, '7101', 'tok-sync04-9101', 9101),
      ('${CARD_PREP_BLOCKED_ID}', '${COMPANY_CAYLO}', 'IN_PREPARATION', 9102, '7102', 'tok-sync04-9102', 9102),
      ('${CARD_AUDIT_READY_ID}', '${COMPANY_CAYLO}', 'IN_AUDIT', 9103, '7103', 'tok-sync04-9103', 9103),
      ('${CARD_INCIDENT_ID}', '${COMPANY_CAYLO}', 'IN_PREPARATION', 9104, '7104', 'tok-sync04-9104', 9104);

    CREATE VIEW logistica.vw_sales_order_preparation_board AS
      SELECT id AS card_id, company_id, status, COALESCE(current_bsale_nv_id, bsale_nv_id) AS nv_bsale_id
        FROM logistica.sales_order_preparation_cards;
    CREATE VIEW integraciones.vw_bsale_sales_order_documents_canonical AS
      SELECT company_id, canonical_bsale_token, COALESCE(current_bsale_nv_id, bsale_nv_id) AS current_bsale_id
        FROM logistica.sales_order_preparation_cards;

    CREATE TABLE logistica.sales_order_preparation_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      bsale_nv_id bigint NOT NULL,
      bsale_detail_id bigint NOT NULL,
      bsale_variant_id bigint,
      sku text,
      product_name text NOT NULL,
      requested_quantity numeric NOT NULL,
      prepared_quantity numeric,
      line_status text NOT NULL,
      excluded_from_dispatch boolean NOT NULL DEFAULT false,
      confirmed_by uuid,
      confirmed_at timestamptz,
      retired_at timestamptz,
      source_snapshot jsonb
    );

    -- Tarjeta 9101: 100% confirmada y alineada con Bsale -> debe avanzar automáticamente a IN_AUDIT incluso sin navegador
    INSERT INTO logistica.sales_order_preparation_lines (
      company_id, card_id, bsale_nv_id, bsale_detail_id, bsale_variant_id, sku, product_name,
      requested_quantity, prepared_quantity, line_status, excluded_from_dispatch, confirmed_by, confirmed_at, source_snapshot
    ) VALUES
      (
        '${COMPANY_CAYLO}', '${CARD_PREP_CONFORMING_ID}', 9101, 91011, 9901, 'SKU-9901', 'Alimento Premium Perro',
        2, 2, 'CONFIRMED', false, '${USER_PREP}', now(),
        jsonb_build_object(
          'nv_bsale_id', 9101, 'detail_id', 91011, 'variant_id', 9901, 'sku', 'SKU-9901',
          'product_name', 'Alimento Premium Perro', 'quantity', 2, 'unit_value', 10000,
          'line_net_amount', 20000, 'line_tax_amount', 3800, 'line_gross_amount', 23800, 'line_number', 0
        )
      ),
      -- Tarjeta 9102: línea PENDING -> debe permanecer en IN_PREPARATION con razón explícita
      (
        '${COMPANY_CAYLO}', '${CARD_PREP_BLOCKED_ID}', 9102, 91021, 9901, 'SKU-9901', 'Alimento Premium Perro',
        2, NULL, 'PENDING', false, NULL, NULL,
        jsonb_build_object(
          'nv_bsale_id', 9102, 'detail_id', 91021, 'variant_id', 9901, 'sku', 'SKU-9901',
          'product_name', 'Alimento Premium Perro', 'quantity', 2, 'unit_value', 10000,
          'line_net_amount', 20000, 'line_tax_amount', 3800, 'line_gross_amount', 23800, 'line_number', 0
        )
      );

    CREATE TABLE logistica.sales_order_preparation_commercial_versions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      sequence_no int NOT NULL DEFAULT 1,
      version_snapshot jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE logistica.sales_order_preparation_incidents (
      id uuid PRIMARY KEY,
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      company_id uuid NOT NULL,
      status text NOT NULL,
      verification_status text
    );
    INSERT INTO logistica.sales_order_preparation_incidents (id, card_id, company_id, status, verification_status)
    VALUES ('${INCIDENT_OPEN_ID}', '${CARD_INCIDENT_ID}', '${COMPANY_CAYLO}', 'OPEN', 'MISMATCH');

    CREATE TABLE logistica.sales_order_audits (
      id uuid PRIMARY KEY,
      company_id uuid NOT NULL,
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      status text NOT NULL,
      cycle_no int NOT NULL DEFAULT 1,
      package_count int DEFAULT 2,
      locked_by_user_id uuid
    );
    INSERT INTO logistica.sales_order_audits (id, company_id, card_id, status, cycle_no, package_count, locked_by_user_id)
    VALUES ('${AUDIT_READY_ID}', '${COMPANY_CAYLO}', '${CARD_AUDIT_READY_ID}', 'OPEN', 1, 2, '${USER_AUDITOR}');

    CREATE TABLE logistica.sales_order_audit_lines (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      audit_id uuid NOT NULL REFERENCES logistica.sales_order_audits(id),
      card_id uuid NOT NULL REFERENCES logistica.sales_order_preparation_cards(id),
      bsale_detail_id bigint NOT NULL,
      bsale_variant_id bigint,
      sku text,
      product_name text NOT NULL,
      audit_quantity numeric,
      line_status text NOT NULL DEFAULT 'CONFIRMED'
    );
    INSERT INTO logistica.sales_order_audit_lines (
      company_id, audit_id, card_id, bsale_detail_id, bsale_variant_id, sku, product_name, audit_quantity, line_status
    ) VALUES (
      '${COMPANY_CAYLO}', '${AUDIT_READY_ID}', '${CARD_AUDIT_READY_ID}', 91031, 9901, 'SKU-9901', 'Alimento Premium Perro', 2, 'CONFIRMED'
    );

    CREATE TABLE logistica.sales_order_audit_incidents (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      audit_id uuid NOT NULL REFERENCES logistica.sales_order_audits(id),
      status text NOT NULL DEFAULT 'OPEN'
    );

    CREATE TABLE logistica.sales_order_audit_commercial_verifications (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id uuid NOT NULL,
      card_id uuid NOT NULL,
      audit_id uuid NOT NULL,
      status text NOT NULL,
      current_bsale_nv_id bigint,
      canonical_bsale_token text,
      reason text NOT NULL,
      fingerprint text NOT NULL,
      snapshot jsonb NOT NULL,
      differences jsonb NOT NULL,
      is_current boolean NOT NULL DEFAULT true,
      verified_at timestamptz NOT NULL DEFAULT now()
    );

    CREATE OR REPLACE FUNCTION logistica.move_sales_order_preparation_card(
      p_company_id uuid,
      p_card_id uuid,
      p_to_status text,
      p_observation text,
      p_user_id uuid,
      p_user_name text
    ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER AS $$
    BEGIN
      UPDATE logistica.sales_order_preparation_cards
         SET status = p_to_status,
             updated_at = clock_timestamp()
       WHERE id = p_card_id
         AND company_id = p_company_id;
      RETURN jsonb_build_object('ok', true, 'card_id', p_card_id, 'status', p_to_status, 'moved_by', p_user_id, 'moved_by_name', p_user_name);
    END;
    $$;

    CREATE OR REPLACE FUNCTION logistica.reconcile_bodega_preparation_cards(p_company_id uuid)
    RETURNS jsonb LANGUAGE sql AS $$
      SELECT jsonb_build_object('discovered', 4, 'created', 0, 'relations_created', 0, 'closed_invoiced', 0, 'closed_cancelled', 0, 'closed_non_operational', 0, 'skipped_invoiced', 0);
    $$;

    CREATE OR REPLACE FUNCTION logistica.verify_open_preparation_incidents_v1(p_company_id uuid, p_bsale_nv_ids bigint[])
    RETURNS jsonb LANGUAGE plpgsql AS $$
    BEGIN
      UPDATE logistica.sales_order_preparation_incidents
         SET status = 'RESOLVED', verification_status = 'MATCHED'
       WHERE company_id = p_company_id
         AND status = 'OPEN'
         AND (p_bsale_nv_ids IS NULL OR card_id IN (
           SELECT id FROM logistica.sales_order_preparation_cards
            WHERE company_id = p_company_id AND COALESCE(current_bsale_nv_id, bsale_nv_id) = ANY(p_bsale_nv_ids)
         ));
      RETURN jsonb_build_object('checked', 1, 'resolved', 1);
    END;
    $$;
  `)

  // Aplicar migración histórica REAL de bsale_sync_locks (pre-SYNC)
  const legacyLocksSql = readFileSync(
    path.join(PROJECT_ROOT, 'supabase/migrations/20260710000013_create_bsale_sync_locks.sql'),
    'utf8',
  )
  await pool.query(legacyLocksSql)

  // Aplicar RPC REAL de verificación comercial de Auditoría
  const auditVerSql1 = readFileSync(
    path.join(PROJECT_ROOT, 'supabase/migrations/20261109090000_logistica_audit_commercial_verification_rpc.sql'),
    'utf8',
  )
  const auditVerSql2 = readFileSync(
    path.join(PROJECT_ROOT, 'supabase/migrations/20261110140000_logistica_audit_verification_accepted_version_guard.sql'),
    'utf8',
  )
  await pool.query(auditVerSql1)
  await pool.query(auditVerSql2)
}

function parsePostgrestFilterVal(raw) {
  if (raw.startsWith('eq.')) return { op: '=', val: raw.slice(3) }
  if (raw.startsWith('gt.')) return { op: '>', val: raw.slice(3) }
  if (raw.startsWith('lt.')) return { op: '<', val: raw.slice(3) }
  if (raw.startsWith('is.')) return { op: 'IS', val: raw.slice(3) }
  if (raw.startsWith('in.(') && raw.endsWith(')')) {
    const inner = raw.slice(4, -1)
    const items = inner ? inner.split(',').map(s => s.replace(/^"|"$/g, '')) : []
    return { op: 'IN', val: items }
  }
  if (raw.startsWith('not.in.(') && raw.endsWith(')')) {
    const inner = raw.slice(8, -1)
    const items = inner ? inner.split(',').map(s => s.replace(/^"|"$/g, '')) : []
    return { op: 'NOT_IN', val: items }
  }
  return null
}

function buildWhereClause(searchParams, startParamIdx = 1) {
  const clauses = []
  const values = []
  let idx = startParamIdx

  for (const [key, raw] of searchParams.entries()) {
    if (['select', 'order', 'limit', 'offset', 'on_conflict'].includes(key)) continue
    const parsed = parsePostgrestFilterVal(raw)
    if (!parsed) continue
    const col = `"${key.replace(/"/g, '')}"`
    if (parsed.op === 'IS') {
      if (parsed.val === 'null') clauses.push(`${col} IS NULL`)
      else if (parsed.val === 'true') clauses.push(`${col} IS TRUE`)
      else if (parsed.val === 'false') clauses.push(`${col} IS FALSE`)
    } else if (parsed.op === 'IN') {
      if (parsed.val.length === 0) clauses.push('FALSE')
      else {
        const ph = parsed.val.map(() => `$${idx++}`)
        values.push(...parsed.val)
        clauses.push(`${col} IN (${ph.join(', ')})`)
      }
    } else if (parsed.op === 'NOT_IN') {
      if (parsed.val.length > 0) {
        const ph = parsed.val.map(() => `$${idx++}`)
        values.push(...parsed.val)
        clauses.push(`${col} NOT IN (${ph.join(', ')})`)
      }
    } else {
      clauses.push(`${col} ${parsed.op} $${idx++}`)
      values.push(parsed.val)
    }
  }

  return {
    sql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
    nextIdx: idx,
  }
}

async function startLocalPostgrestAndBsaleServers(pool) {
  const bsaleCalls = []
  const rpcHooks = {
    onBeforeMoveCard: null,
    onBeforeAuditVerification: null,
  }
  const bsaleControl = {
    delayMs: 0,
  }

  const pgServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const bodyText = Buffer.concat(chunks).toString('utf8')
      const bodyJson = bodyText ? JSON.parse(bodyText) : {}

      const isRead = req.method === 'GET' || req.method === 'HEAD'
      const rawSchema = isRead ? req.headers['accept-profile'] : req.headers['content-profile']
      const schema = (typeof rawSchema === 'string' && rawSchema ? rawSchema : 'portal').replace(/[^a-z0-9_]/gi, '')
      const prefer = String(req.headers.prefer ?? '')
      const accept = String(req.headers.accept ?? '')
      const isSingleObject = accept.includes('application/vnd.pgrst.object+json')

      if (url.pathname.startsWith('/rest/v1/rpc/')) {
        const fnName = url.pathname.slice('/rest/v1/rpc/'.length).replace(/[^a-z0-9_]/gi, '')
        if (fnName === 'move_sales_order_preparation_card' && rpcHooks.onBeforeMoveCard) {
          await rpcHooks.onBeforeMoveCard(bodyJson)
        }
        if (fnName === 'record_sales_order_audit_commercial_verification_v1' && rpcHooks.onBeforeAuditVerification) {
          await rpcHooks.onBeforeAuditVerification(bodyJson)
        }

        const argEntries = Object.entries(bodyJson ?? {})
        const placeholders = []
        const values = []
        argEntries.forEach(([k, v], i) => {
          const cleanKey = k.replace(/[^a-z0-9_]/gi, '')
          const isJsonObj = v !== null && typeof v === 'object' && !Array.isArray(v)
          const isJsonObjArray = Array.isArray(v) && v.some(item => item !== null && typeof item === 'object')
          if (isJsonObj || isJsonObjArray || k === 'p_differences') {
            placeholders.push(`${cleanKey} := $${i + 1}::jsonb`)
            values.push(JSON.stringify(v))
          } else {
            placeholders.push(`${cleanKey} := $${i + 1}`)
            values.push(v)
          }
        })

        const client = await pool.connect()
        try {
          await client.query('BEGIN')
          if (MOCK_AUTH_STATE.currentUserId) {
            await client.query(`SELECT set_config('app.mock_uid', $1, true)`, [MOCK_AUTH_STATE.currentUserId])
          }
          const sql = `SELECT "${schema}"."${fnName}"(${placeholders.join(', ')}) AS result`
          const queryRes = await client.query(sql, values)
          await client.query('COMMIT')
          const out = queryRes.rows[0]?.result ?? null
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(out))
          return
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {})
          res.writeHead(400, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ message: err.message, code: err.code ?? 'P0001', details: null, hint: null }))
          return
        } finally {
          client.release()
        }
      }

      const table = url.pathname.replace(/^\/rest\/v1\//, '').replace(/[^a-z0-9_]/gi, '')
      const fqTable = `"${schema}"."${table}"`

      if (req.method === 'GET' || req.method === 'HEAD') {
        const where = buildWhereClause(url.searchParams)
        const wantCount = prefer.includes('count=exact')
        let orderSql = ''
        const orderParam = url.searchParams.get('order')
        if (orderParam) {
          const parts = orderParam.split(',').map(part => {
            const [col, dir] = part.split('.')
            return `"${col.replace(/[^a-z0-9_]/gi, '')}" ${dir === 'desc' ? 'DESC' : 'ASC'}`
          })
          orderSql = `ORDER BY ${parts.join(', ')}`
        }
        const limitParam = url.searchParams.get('limit')
        const limitSql = limitParam ? `LIMIT ${Number(limitParam)}` : ''

        const queryRes = await pool.query(`SELECT * FROM ${fqTable} ${where.sql} ${orderSql} ${limitSql}`, where.values)
        const totalCount = wantCount
          ? Number((await pool.query(`SELECT count(*)::int AS c FROM ${fqTable} ${where.sql}`, where.values)).rows[0].c)
          : queryRes.rows.length

        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-range': `0-${Math.max(0, totalCount - 1)}/${totalCount}` })
          res.end()
          return
        }

        if (isSingleObject) {
          if (queryRes.rows.length === 0) {
            res.writeHead(406, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: 'The result contains 0 rows' }))
            return
          }
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(queryRes.rows[0]))
          return
        }

        const headers = { 'content-type': 'application/json' }
        if (wantCount) headers['content-range'] = `0-${Math.max(0, queryRes.rows.length - 1)}/${totalCount}`
        res.writeHead(200, headers)
        res.end(JSON.stringify(queryRes.rows))
        return
      }

      if (req.method === 'POST') {
        const rows = Array.isArray(bodyJson) ? bodyJson : [bodyJson]
        const cols = Object.keys(rows[0] ?? {})
        const colList = cols.map(c => `"${c.replace(/[^a-z0-9_]/gi, '')}"`).join(', ')
        const values = []
        const valueTuples = rows.map(row => {
          const tuple = cols.map(c => {
            const v = row[c]
            values.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
            return `$${values.length}`
          })
          return `(${tuple.join(', ')})`
        })

        const onConflict = url.searchParams.get('on_conflict')
        let conflictSql = ''
        if (onConflict && prefer.includes('resolution=merge-duplicates')) {
          const conflictCols = onConflict.split(',').map(c => `"${c.trim().replace(/[^a-z0-9_]/gi, '')}"`).join(', ')
          const updateSet = cols.map(c => {
            const clean = `"${c.replace(/[^a-z0-9_]/gi, '')}"`
            return `${clean} = EXCLUDED.${clean}`
          }).join(', ')
          conflictSql = `ON CONFLICT (${conflictCols}) DO UPDATE SET ${updateSet}`
        }

        const queryRes = await pool.query(
          `INSERT INTO ${fqTable} (${colList}) VALUES ${valueTuples.join(', ')} ${conflictSql} RETURNING *`,
          values,
        )
        const payload = isSingleObject ? queryRes.rows[0] : queryRes.rows
        res.writeHead(201, { 'content-type': 'application/json' })
        res.end(JSON.stringify(payload))
        return
      }

      if (req.method === 'PATCH') {
        const cols = Object.keys(bodyJson ?? {})
        const values = []
        const setParts = cols.map(c => {
          const v = bodyJson[c]
          values.push(v !== null && typeof v === 'object' ? JSON.stringify(v) : v)
          return `"${c.replace(/[^a-z0-9_]/gi, '')}" = $${values.length}`
        })
        const where = buildWhereClause(url.searchParams, values.length + 1)
        values.push(...where.values)
        const queryRes = await pool.query(
          `UPDATE ${fqTable} SET ${setParts.join(', ')} ${where.sql} RETURNING *`,
          values,
        )
        if (isSingleObject) {
          res.writeHead(queryRes.rows.length ? 200 : 406, { 'content-type': 'application/json' })
          res.end(JSON.stringify(queryRes.rows[0] ?? { code: 'PGRST116', message: '0 rows' }))
          return
        }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(queryRes.rows))
        return
      }

      if (req.method === 'DELETE') {
        const where = buildWhereClause(url.searchParams)
        const queryRes = await pool.query(`DELETE FROM ${fqTable} ${where.sql} RETURNING *`, where.values)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(queryRes.rows))
        return
      }

      res.writeHead(405)
      res.end()
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ message: err.message, code: err.code ?? 'XX000' }))
    }
  })

  const docsById = new Map([
    [9101, { id: 9101, number: 7101, token: 'tok-sync04-9101', detailId: 91011 }],
    [9102, { id: 9102, number: 7102, token: 'tok-sync04-9102', detailId: 91021 }],
    [9103, { id: 9103, number: 7103, token: 'tok-sync04-9103', detailId: 91031 }],
    [9104, { id: 9104, number: 7104, token: 'tok-sync04-9104', detailId: 91041 }],
  ])

  const makeBsaleDoc = (entry) => ({
    id: entry.id,
    number: entry.number,
    token: entry.token,
    emissionDate: 1763000000,
    generationDate: 1763000000,
    totalAmount: 23800,
    netAmount: 20000,
    taxAmount: 3800,
    exemptAmount: 0,
    state: 0,
    informedSii: 0,
    documentTypeId: 23,
    document_type: { id: 23 },
    client: { id: 501 },
    office: { id: 1 },
    user: { id: 11 },
    details: {
      count: 1,
      items: [
        {
          id: entry.detailId,
          lineNumber: 0,
          quantity: 2,
          netUnitValue: 10000,
          totalUnitValue: 11900,
          netAmount: 20000,
          taxAmount: 3800,
          totalAmount: 23800,
          netDiscount: 0,
          variant: { id: 9901, code: 'SKU-9901', description: 'Alimento Premium Perro' },
        },
      ],
    },
  })

  const bsaleServer = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    bsaleCalls.push({ method: req.method, pathname: url.pathname, search: url.search })

    if (bsaleControl.delayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, bsaleControl.delayMs))
    }

    const docDetailMatch = url.pathname.match(/\/v1\/documents\/(\d+)\/details\.json$/)
    if (docDetailMatch) {
      const id = Number(docDetailMatch[1])
      const entry = docsById.get(id)
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ count: entry ? 1 : 0, items: entry ? makeBsaleDoc(entry).details.items : [] }))
      return
    }

    const singleDocMatch = url.pathname.match(/\/v1\/documents\/(\d+)\.json$/)
    if (singleDocMatch) {
      const id = Number(singleDocMatch[1])
      const entry = docsById.get(id)
      if (!entry) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'not found' }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(makeBsaleDoc(entry)))
      return
    }

    if (url.pathname.endsWith('/v1/documents.json')) {
      const docType = Number(url.searchParams.get('documenttypeid') ?? '0')
      const numberFilter = url.searchParams.get('number')
      if (numberFilter) {
        const match = [...docsById.values()].find(d => String(d.number) === String(numberFilter))
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ count: match ? 1 : 0, items: match ? [makeBsaleDoc(match)] : [] }))
        return
      }
      if (docType === 23) {
        const all = [...docsById.values()].map(makeBsaleDoc)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ count: all.length, items: all }))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ count: 0, items: [] }))
      return
    }

    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ count: 0, items: [] }))
  })

  await new Promise(resolve => pgServer.listen(0, '127.0.0.1', resolve))
  await new Promise(resolve => bsaleServer.listen(0, '127.0.0.1', resolve))

  return {
    supabaseUrl: `http://127.0.0.1:${pgServer.address().port}`,
    bsaleBaseUrl: `http://127.0.0.1:${bsaleServer.address().port}/v1`,
    bsaleCalls,
    bsaleControl,
    rpcHooks,
    async stop() {
      await new Promise(resolve => pgServer.close(resolve))
      await new Promise(resolve => bsaleServer.close(resolve))
    },
  }
}

test('SYNC-04 — Validación final previa a publicación (PostgreSQL 15 + Aislamiento sobre origin/main)', async (t) => {
  const prevEnv = { ...process.env }
  const pg15 = startIsolatedPostgres15()
  let localServers = null
  let runtimeMod = null
  let queueMod = null

  try {
    await bootstrapFullSchemaFromLegacyMigration(pg15.pool)
    localServers = await startLocalPostgrestAndBsaleServers(pg15.pool)

    process.env.NEXT_PUBLIC_SUPABASE_URL = localServers.supabaseUrl
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = 'sync04-anon'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'sync04-service'
    process.env.BSALE_API_BASE_URL = localServers.bsaleBaseUrl
    process.env.BSALE_ACCESS_TOKEN = 'sync04-bsale-token'
    process.env.BSALE_ACCESS_TOKEN_CAYLO = 'sync04-bsale-token'
    process.env.CRON_SECRET = 'sync04-cron-secret'
    process.env.BSALE_SYNC_COORDINATOR_ENABLED = 'true'
    process.env.BSALE_SYNC_QUEUE_ENABLED = 'true'
    process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'false'

    const coordinatorMod = await import('../src/lib/integraciones/bsale-sync-coordinator.ts')
    queueMod = await import('../src/lib/integraciones/bsale-sync-queue.ts')
    runtimeMod = await import('../src/lib/integraciones/bsale-sync-queue-runtime.ts')
    const prepActionsMod = await import('../src/app/actions/logistica/sales-order-preparation.ts')
    const incSyncMod = await import('../src/app/actions/logistica/sales-order-preparation-incident-sync.ts')
    const queueActionsMod = await import('../src/app/actions/logistica/sales-order-preparation-sync-queue.ts')
    const workerRouteMod = await import('../src/app/api/cron/bsale-sync-worker/route.ts')

    // ─── 1. COMPATIBILIDAD DE MIGRACIONES Y APLICACIÓN PUBLICADA ───────────
    await t.test('1. Compatibilidad de las dos migraciones SYNC con la estructura anterior (20260710000013) y la app publicada', async () => {
      // Pre-poblar fila legacy en bsale_sync_locks (owner_token IS NULL) tal como hace la app publicada actual
      await pg15.pool.query(
        `INSERT INTO integraciones.bsale_sync_locks (company_id, lock_name, run_id, acquired_at, expires_at, metadata)
         VALUES ($1::uuid, 'bsale_replenishment_sync', gen_random_uuid(), now(), now() + interval '5 minutes', '{"legacy":true}'::jsonb)`,
        [COMPANY_CAYLO],
      )

      // Aplicar las dos migraciones SYNC reales en orden sobre la tabla legacy con datos activos
      const coordSql = readFileSync(
        path.join(PROJECT_ROOT, 'supabase/migrations/20261127151840_integraciones_bsale_sync_coordinator.sql'),
        'utf8',
      )
      const queueSql = readFileSync(
        path.join(PROJECT_ROOT, 'supabase/migrations/20261127151858_integraciones_bsale_sync_queue.sql'),
        'utf8',
      )
      await pg15.pool.query(coordSql)
      await pg15.pool.query(queueSql)

      const grants = (await pg15.pool.query(`SELECT
        has_table_privilege('service_role', 'integraciones.bsale_sync_scope_cooldowns', 'SELECT') AS cooldown_select,
        has_table_privilege('service_role', 'integraciones.bsale_sync_queue', 'SELECT') AS queue_select`)).rows[0]
      assert.equal(grants.cooldown_select, true)
      assert.equal(grants.queue_select, true)

      // Re-ejecución idempotente (IF NOT EXISTS / CREATE OR REPLACE)
      await pg15.pool.query(coordSql)
      await pg15.pool.query(queueSql)

      // 1A: El coordinador nuevo respeta el lock legacy activo (rolling deploy seguro)
      const scope = coordinatorMod.resolveBsaleCredentialScope(COMPANY_CAYLO)
      const blockedByLegacy = await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().acquire({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_operational_prep_sync',
        ownerToken: 'coord-during-legacy',
        operationKind: 'WAREHOUSE_MANUAL',
        credentialScope: scope,
        resourceKey: null,
        runId: null,
        ttlSeconds: 60,
        incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('WAREHOUSE_MANUAL'),
        metadata: {},
      })
      assert.equal(blockedByLegacy.acquired, false, 'Coordinador debe respetar lock legacy vigente')

      // 1B: Instancia legacy publicada puede liberar su propio lock (owner_token IS NULL) sin error
      await pg15.pool.query(
        `DELETE FROM integraciones.bsale_sync_locks WHERE company_id = $1::uuid AND lock_name = 'bsale_replenishment_sync'`,
        [COMPANY_CAYLO],
      )

      // 1C: Instancia legacy publicada puede INSERT/UPDATE/DELETE en modo pre-rollout cuando no hay lock del coordinador
      await pg15.pool.query(
        `INSERT INTO integraciones.bsale_sync_locks (company_id, lock_name, run_id, acquired_at, expires_at)
         VALUES ($1::uuid, 'bsale_operational_prep_sync', gen_random_uuid(), now(), now() + interval '5 minutes')`,
        [COMPANY_CAYLO],
      )
      await pg15.pool.query(
        `DELETE FROM integraciones.bsale_sync_locks WHERE company_id = $1::uuid AND lock_name = 'bsale_operational_prep_sync'`,
        [COMPANY_CAYLO],
      )

      // 1D: Si el coordinador adquiere un lock (owner_token IS NOT NULL), un INSERT legacy de otra operación recibe 23505 (manejado como ocupado por la app publicada)
      const acq = await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().acquire({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_replenishment_sync',
        ownerToken: 'coord-owner-1',
        operationKind: 'REPLENISHMENT_SYNC',
        credentialScope: scope,
        resourceKey: null,
        runId: null,
        ttlSeconds: 60,
        incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('REPLENISHMENT_SYNC'),
        metadata: {},
      })
      assert.equal(acq.acquired, true)

      let legacyInsertErrCode = null
      try {
        await pg15.pool.query(
          `INSERT INTO integraciones.bsale_sync_locks (company_id, lock_name, run_id, acquired_at, expires_at)
           VALUES ($1::uuid, 'bsale_operational_prep_sync', gen_random_uuid(), now(), now() + interval '5 minutes')`,
          [COMPANY_CAYLO],
        )
      } catch (err) {
        legacyInsertErrCode = err.code
      }
      assert.equal(legacyInsertErrCode, '23505', 'Trigger debe emitir 23505 compatible con manejo legacy de lock ocupado')

      await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().release({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_replenishment_sync',
        credentialScope: scope,
        ownerToken: 'coord-owner-1',
      })
    })

    // ─── 2. DEDUPLICACIÓN ANTE SOLICITUDES REALMENTE SIMULTÁNEAS ──────────
    await t.test('2. Deduplicación efectiva ante solicitudes realmente simultáneas (IDLE multi-pestaña, PENDING y RUNNING)', async () => {
      await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
      runtimeMod.resetBsaleSyncQueueRuntimeForTests()
      queueMod.resetGlobalBsaleSyncQueueManagerForTests()
      runtimeMod.ensureBsaleSyncQueueRuntimeRegistered()

      MOCK_AUTH_STATE.cookieSessionAvailable = true
      MOCK_AUTH_STATE.currentUserId = USER_PREP
      MOCK_AUTH_STATE.activeCompanyId = COMPANY_CAYLO

      // 2A: 6 pestañas disparan simultáneamente actualización de NV desde REPOSO (con latencia de red en Bsale)
      localServers.bsaleCalls.length = 0
      localServers.bsaleControl.delayMs = 80
      const idleTabsNv = await Promise.all(
        Array.from({ length: 6 }, () => prepActionsMod.syncOperationalBsaleSalesOrders()),
      )
      localServers.bsaleControl.delayMs = 0

      const nvWinners = idleTabsNv.filter(r => r.ok === true)
      const nvLosers = idleTabsNv.filter(r => r.ok === false)
      assert.equal(nvWinners.length, 1, `Exactamente 1 pestaña debe ejecutar WAREHOUSE_MANUAL desde reposo: ${JSON.stringify(idleTabsNv)}`)
      assert.equal(nvLosers.length, 5)
      for (const loser of nvLosers) {
        assert.equal(loser.queued, false, 'Las pestañas perdedoras en reposo NO deben encolar una segunda ejecución detrás')
        assert.equal(loser.queueStatus, 'RUNNING')
        assert.equal(loser.deduplicated, true)
      }
      const queueAfterIdleNv = (await pg15.pool.query(`SELECT count(*)::int AS c FROM integraciones.bsale_sync_queue`)).rows[0].c
      assert.equal(queueAfterIdleNv, 0, 'Cero filas residuales en bsale_sync_queue tras carrera desde reposo')

      // 2B: Mientras un bloqueo incompatible está activo, 6 pestañas solicitan simultáneamente CARD_SYNC y 6 solicitan WAREHOUSE_MANUAL -> 1 sola fila PENDING por operación
      const scope = coordinatorMod.resolveBsaleCredentialScope(COMPANY_CAYLO)
      await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().acquire({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_replenishment_sync',
        ownerToken: 'blocker-simul',
        operationKind: 'REPLENISHMENT_SYNC',
        credentialScope: scope,
        resourceKey: null,
        runId: null,
        ttlSeconds: 120,
        incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('REPLENISHMENT_SYNC'),
        metadata: {},
      })

      // También probamos 6 llamadas simultáneas directas al manager.enqueue (simulando múltiples instancias serverless sin memoria compartida)
      const manager = runtimeMod.ensureBsaleSyncQueueRuntimeRegistered()
      const [simulCardEnqueues, simulNvTabs] = await Promise.all([
        Promise.all(
          Array.from({ length: 6 }, () =>
            manager.enqueue({
              companyId: COMPANY_CAYLO,
              operationKind: 'CARD_SYNC',
              lockName: 'bsale_operational_prep_sync',
              resourceKey: `card:${CARD_PREP_BLOCKED_ID}`,
              requestedBy: USER_PREP,
              triggerType: 'MANUAL',
              ttlSeconds: 600,
              payload: { cardId: CARD_PREP_BLOCKED_ID },
            }),
          ),
        ),
        Promise.all(Array.from({ length: 6 }, () => prepActionsMod.syncOperationalBsaleSalesOrders())),
      ])

      const uniqueCardIds = new Set(simulCardEnqueues.map(r => r.requestId))
      assert.equal(uniqueCardIds.size, 1, '6 encolados simultáneos de la misma tarjeta deben converger al mismo requestId')
      assert.equal(Math.max(...simulCardEnqueues.map(r => r.coalescedCount)), 6)

      const uniqueNvIds = new Set(simulNvTabs.map(r => r.queueRequestId).filter(Boolean))
      assert.equal(uniqueNvIds.size, 1, '6 pestañas simultáneas de NV deben converger al mismo requestId PENDING')
      assert.equal(simulNvTabs.filter(r => r.deduplicated === true).length, 5)

      const pendingRows = (await pg15.pool.query(
        `SELECT id, operation_kind, status, coalesced_count FROM integraciones.bsale_sync_queue ORDER BY operation_kind`,
      )).rows
      assert.equal(pendingRows.length, 2, 'Exactamente 2 filas PENDING (1 CARD_SYNC + 1 WAREHOUSE_MANUAL)')

      // 2C: Liberar blocker y reclamar CARD_SYNC a RUNNING -> 6 solicitudes simultáneas mientras está RUNNING (tanto vía Server Action como vía enqueue directo multi-instancia)
      await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().release({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_replenishment_sync',
        credentialScope: scope,
        ownerToken: 'blocker-simul',
      })

      const claimRunning = await manager.store.claimNext({ workerId: 'w-simul-running' })
      assert.equal(claimRunning.claimed, true)
      assert.equal(claimRunning.request.operationKind, 'CARD_SYNC')

      const [runningActionTabs, runningDirectEnqueues] = await Promise.all([
        Promise.all(
          Array.from({ length: 4 }, () => incSyncMod.syncSalesOrderPreparationCardFromBsale(CARD_PREP_BLOCKED_ID)),
        ),
        Promise.all(
          Array.from({ length: 4 }, () =>
            manager.enqueue({
              companyId: COMPANY_CAYLO,
              operationKind: 'CARD_SYNC',
              lockName: 'bsale_operational_prep_sync',
              resourceKey: `card:${CARD_PREP_BLOCKED_ID}`,
              requestedBy: USER_PREP,
              triggerType: 'MANUAL',
              ttlSeconds: 600,
              payload: { cardId: CARD_PREP_BLOCKED_ID },
            }),
          ),
        ),
      ])

      for (const act of runningActionTabs) {
        assert.equal(act.status, 'IN_PROGRESS')
        assert.equal(act.deduplicated, true)
        assert.equal(act.queueStatus, 'RUNNING')
      }
      for (const direct of runningDirectEnqueues) {
        assert.equal(direct.enqueued, false, 'No debe insertar nueva fila PENDING mientras la misma solicitud está RUNNING')
        assert.equal(direct.alreadyRunning, true)
        assert.equal(direct.deduplicated, true)
        assert.equal(direct.status, 'RUNNING')
        assert.equal(direct.requestId, claimRunning.request.id)
      }

      const cardQueueRowsCount = (await pg15.pool.query(
        `SELECT count(*)::int AS c FROM integraciones.bsale_sync_queue WHERE operation_kind = 'CARD_SYNC'`,
      )).rows[0].c
      assert.equal(cardQueueRowsCount, 1, 'Cero filas PENDING adicionales creadas detrás de la fila RUNNING')

      await manager.store.complete({
        requestId: claimRunning.request.id,
        companyId: COMPANY_CAYLO,
        lockName: claimRunning.request.lockName,
        credentialScope: claimRunning.request.credentialScope,
        ownerToken: claimRunning.lease.ownerToken,
        durationMs: 10,
      })
    })

    // ─── 3 Y 4. EJECUCIÓN SIN NAVEGADOR, RECUPERACIÓN Y RECONCILIACIÓN PREVIA A COMPLETED ───
    await t.test('3 y 4. Ejecución automática + recuperación con navegador cerrado + reconciliación individual COMPLETA antes de COMPLETED', async () => {
      await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
      await pg15.pool.query("UPDATE logistica.sales_order_preparation_incidents SET status = 'OPEN', verification_status = 'MISMATCH' WHERE id = $1", [INCIDENT_OPEN_ID])
      const { createBsalePreparationCommercialProvider } = await import('../src/lib/logistica/preparation-commercial-bsale-provider.ts')
      const baseline = await createBsalePreparationCommercialProvider().getCurrentVersion({
        companyId: COMPANY_CAYLO, cardId: CARD_PREP_CONFORMING_ID, status: 'IN_PREPARATION',
        canonicalToken: 'tok-sync04-9101', historicalBsaleId: 9101, currentBsaleId: 9101, folio: '7101',
      }, AbortSignal.timeout(5000))
      await pg15.pool.query('INSERT INTO logistica.sales_order_preparation_commercial_versions (company_id, card_id, version_snapshot) VALUES ($1, $2, $3::jsonb)', [COMPANY_CAYLO, CARD_PREP_CONFORMING_ID, JSON.stringify(baseline)])
      runtimeMod.resetBsaleSyncQueueRuntimeForTests()
      queueMod.resetGlobalBsaleSyncQueueManagerForTests()
      const manager = runtimeMod.ensureBsaleSyncQueueRuntimeRegistered()

      // Retener lock temporalmente mientras el usuario encola sus solicitudes y cierra el navegador
      const scope = coordinatorMod.resolveBsaleCredentialScope(COMPANY_CAYLO)
      await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().acquire({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_warehouse_full_refresh',
        ownerToken: 'browser-close-blocker',
        operationKind: 'WAREHOUSE_FULL_REFRESH',
        credentialScope: scope,
        resourceKey: null,
        runId: null,
        ttlSeconds: 120,
        incompatibleLockNames: coordinatorMod.getIncompatibleLockNames('WAREHOUSE_FULL_REFRESH'),
        metadata: {},
      })

      MOCK_AUTH_STATE.cookieSessionAvailable = true
      MOCK_AUTH_STATE.activeCompanyId = COMPANY_CAYLO
      MOCK_AUTH_STATE.currentUserId = USER_PREP

      const cardConformingQueued = await incSyncMod.syncSalesOrderPreparationCardFromBsale(CARD_PREP_CONFORMING_ID)
      const cardBlockedQueued = await incSyncMod.syncSalesOrderPreparationCardFromBsale(CARD_PREP_BLOCKED_ID)
      const incidentQueued = await incSyncMod.syncSalesOrderPreparationIncident(INCIDENT_OPEN_ID)
      const nvQueued = await prepActionsMod.syncOperationalBsaleSalesOrders()

      MOCK_AUTH_STATE.currentUserId = USER_AUDITOR
      const auditQueued = await incSyncMod.syncSalesOrderAuditCardFromBsale(CARD_AUDIT_READY_ID)

      assert.equal(cardConformingQueued.queued, true)
      assert.equal(cardBlockedQueued.queued, true)
      assert.equal(incidentQueued.queued, true, JSON.stringify(incidentQueued))
      assert.equal(nvQueued.queued, true)
      assert.equal(auditQueued.queued, true)

      // USUARIO CIERRA EL NAVEGADOR COMPLETAMENTE (cualquier intento de usar cookies/createClient fallará)
      MOCK_AUTH_STATE.cookieSessionAvailable = false
      MOCK_AUTH_STATE.currentUserId = null
      MOCK_AUTH_STATE.activeCompanyId = null

      await coordinatorMod.createSupabaseBsaleSyncCoordinatorStore().release({
        companyId: COMPANY_CAYLO,
        lockName: 'bsale_warehouse_full_refresh',
        credentialScope: scope,
        ownerToken: 'browser-close-blocker',
      })

      // Simular caída abrupta de un worker en mitad de ejecución (fila RUNNING con lease vencido)
      const crashedClaim = await manager.store.claimNext({ workerId: 'crashed-worker' })
      assert.equal(crashedClaim.claimed, true)
      const pgClient = await pg15.pool.connect()
      try {
        await pgClient.query('BEGIN')
        await pgClient.query("SELECT set_config('integraciones.bsale_sync_coord_bypass', 'on', true)")
        await pgClient.query(`UPDATE integraciones.bsale_sync_locks SET expires_at = clock_timestamp() - interval '5 seconds' WHERE owner_token = $1`, [crashedClaim.lease.ownerToken])
        await pgClient.query('COMMIT')
      } finally {
        pgClient.release()
      }
      await pg15.pool.query(`UPDATE integraciones.bsale_sync_queue SET lease_expires_at = clock_timestamp() - interval '5 seconds' WHERE id = $1::uuid`, [crashedClaim.request.id])

      // Instrumentar hooks para demostrar el Punto 4: durante la reconciliación individual (move_sales_order_preparation_card y record_sales_order_audit_commercial_verification_v1),
      // el estado en integraciones.bsale_sync_queue TODAVÍA es RUNNING (jamás COMPLETED antes de reconciliar).
      let queueStatusDuringCardMove = null
      let queueStatusDuringAuditVerify = null

      localServers.rpcHooks.onBeforeMoveCard = async () => {
        const r = (await pg15.pool.query(
          `SELECT status FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`,
          [cardConformingQueued.queueRequestId],
        )).rows[0]
        queueStatusDuringCardMove = r?.status ?? null
      }

      localServers.rpcHooks.onBeforeAuditVerification = async () => {
        const r = (await pg15.pool.query(
          `SELECT status FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`,
          [auditQueued.queueRequestId],
        )).rows[0]
        queueStatusDuringAuditVerify = r?.status ?? null
      }

      // Ejecutar drenaje completo del servidor SIN NAVEGADOR
      const drainSummary = await manager.drain()
      localServers.rpcHooks.onBeforeMoveCard = null
      localServers.rpcHooks.onBeforeAuditVerification = null

      assert.equal(drainSummary.recoveredToPending, 1, 'Debe recuperar automáticamente la solicitud RUNNING huérfana')
      const queueDiagnostics = (await pg15.pool.query('SELECT operation_kind, status, last_error_message FROM integraciones.bsale_sync_queue')).rows
      assert.equal(drainSummary.completedIds.length, 5, `Las 5 solicitudes deben completarse sin navegador: ${JSON.stringify(queueDiagnostics)}`)
      assert.equal(drainSummary.failedIds.length, 0)

      // Evidencia Punto 4: la cola seguía en RUNNING mientras ocurría la reconciliación individual
      const cardDiagnostics = (await pg15.pool.query('SELECT result_summary FROM integraciones.bsale_sync_queue WHERE id = $1', [cardConformingQueued.queueRequestId])).rows[0]
      assert.equal(queueStatusDuringCardMove, 'RUNNING', `CARD_SYNC no puede marcarse COMPLETED antes de ejecutar la transición a Auditoría: ${JSON.stringify(cardDiagnostics)}`)
      assert.equal(queueStatusDuringAuditVerify, 'RUNNING', 'AUDIT_SYNC no puede marcarse COMPLETED antes de persistir la verificación comercial')

      // Evidencia Punto 3 + 4 en BD (sin que el navegador haya vuelto a abrirse):
      const cardConformingDb = (await pg15.pool.query(
        `SELECT status FROM logistica.sales_order_preparation_cards WHERE id = $1::uuid`,
        [CARD_PREP_CONFORMING_ID],
      )).rows[0]
      assert.equal(cardConformingDb.status, 'IN_AUDIT', 'Tarjeta 100% conforme avanzó a IN_AUDIT en servidor con navegador cerrado')

      const cardBlockedDb = (await pg15.pool.query(
        `SELECT status FROM logistica.sales_order_preparation_cards WHERE id = $1::uuid`,
        [CARD_PREP_BLOCKED_ID],
      )).rows[0]
      assert.equal(cardBlockedDb.status, 'IN_PREPARATION', 'Tarjeta con líneas pendientes permaneció en IN_PREPARATION')

      const auditVerDb = (await pg15.pool.query(
        `SELECT status, reason, is_current FROM logistica.sales_order_audit_commercial_verifications WHERE audit_id = $1::uuid AND is_current = true`,
        [AUDIT_READY_ID],
      )).rows[0]
      assert.ok(auditVerDb, 'Verificación comercial de Auditoría persistida en servidor con navegador cerrado')
      assert.equal(auditVerDb.status, 'READY_TO_INVOICE')

      const incidentDb = (await pg15.pool.query(
        `SELECT status, verification_status FROM logistica.sales_order_preparation_incidents WHERE id = $1::uuid`,
        [INCIDENT_OPEN_ID],
      )).rows[0]
      assert.equal(incidentDb.status, 'RESOLVED')
      assert.equal(incidentDb.verification_status, 'MATCHED')

      // Al reabrir navegador después, finalizeCompletedQueuedPreparationSync entrega el resultado ya reconciliado
      MOCK_AUTH_STATE.cookieSessionAvailable = true
      MOCK_AUTH_STATE.activeCompanyId = COMPANY_CAYLO
      MOCK_AUTH_STATE.currentUserId = USER_PREP
      const finCardOk = await queueActionsMod.finalizeCompletedQueuedPreparationSync(cardConformingQueued.queueRequestId)
      assert.equal(finCardOk.ok, true)
      assert.equal(finCardOk.cardResult.status, 'SYNCED_AND_MOVED_TO_AUDIT')
      assert.equal(finCardOk.cardResult.autoMovedToAudit, true)

      const finCardBlocked = await queueActionsMod.finalizeCompletedQueuedPreparationSync(cardBlockedQueued.queueRequestId)
      assert.equal(finCardBlocked.ok, true)
      assert.equal(finCardBlocked.cardResult.status, 'SYNCED')
      assert.equal(finCardBlocked.cardResult.autoMovedToAudit, false)
      assert.equal(finCardBlocked.cardResult.blockReason, 'PENDING_LINES')

      MOCK_AUTH_STATE.currentUserId = USER_AUDITOR
      const finAuditOk = await queueActionsMod.finalizeCompletedQueuedPreparationSync(auditQueued.queueRequestId)
      assert.equal(finAuditOk.ok, true)
      assert.equal(finAuditOk.auditResult.status, 'SYNCED_READY')
      assert.equal(finAuditOk.auditResult.canFinalize, true)
    })

    // ─── 5. ACTIVACIÓN Y DESACTIVACIÓN DEL SUPERVISOR DURANTE DESPLIEGUE ───
    await t.test('5. Configuración de activación y desactivación del supervisor evitando ejecuciones accidentales en despliegue', async () => {
      await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
      runtimeMod.resetBsaleSyncQueueRuntimeForTests()
      queueMod.resetGlobalBsaleSyncQueueManagerForTests()
      const manager = runtimeMod.ensureBsaleSyncQueueRuntimeRegistered()

      // 5A: Durante next build (NEXT_PHASE=phase-production-build), supervisorEnabled es estrictamente false aunque la variable diga true
      process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'true'
      process.env.NEXT_PHASE = 'phase-production-build'
      assert.equal(coordinatorMod.getBsaleSyncRolloutConfig().supervisorEnabled, false)
      runtimeMod.startBsaleSyncQueueServerSupervisor()
      delete process.env.NEXT_PHASE

      // 5B: Con BSALE_SYNC_SUPERVISOR_ENABLED=false (modo despliegue seguro), ni enqueue, ni snapshot, ni release, ni cron ejecutan drenajes
      process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'false'
      assert.equal(coordinatorMod.getBsaleSyncRolloutConfig().supervisorEnabled, false)

      const enqDeploy = await manager.enqueue({
        companyId: COMPANY_CAYLO,
        operationKind: 'WAREHOUSE_MANUAL',
        lockName: 'bsale_operational_prep_sync',
        triggerType: 'WAREHOUSE_MANUAL',
        ttlSeconds: 300,
      })
      assert.equal(enqDeploy.enqueued, true)

      MOCK_AUTH_STATE.cookieSessionAvailable = true
      MOCK_AUTH_STATE.activeCompanyId = COMPANY_CAYLO
      MOCK_AUTH_STATE.currentUserId = USER_PREP
      await queueActionsMod.getPreparationSyncQueueSnapshot({ trackedRequestIds: [enqDeploy.requestId] })

      const cronDisabledRes = await workerRouteMod.POST(
        new Request('http://localhost/api/cron/bsale-sync-worker', {
          method: 'POST',
          headers: { authorization: 'Bearer sync04-cron-secret' },
        }),
      )
      const cronDisabledJson = await cronDisabledRes.json()
      assert.equal(cronDisabledJson.success, true)
      assert.equal(cronDisabledJson.skipped, 'SUPERVISOR_DISABLED_BY_ROLLOUT_FLAG')

      await new Promise(resolve => setTimeout(resolve, 120))
      const stillPending = (await pg15.pool.query(
        `SELECT status FROM integraciones.bsale_sync_queue WHERE id = $1::uuid`,
        [enqDeploy.requestId],
      )).rows[0]
      assert.equal(stillPending.status, 'PENDING', 'Cero ejecuciones accidentales mientras BSALE_SYNC_SUPERVISOR_ENABLED=false')

      // 5C: Al activar BSALE_SYNC_SUPERVISOR_ENABLED=true tras migraciones y smoke check, drena automáticamente
      process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'true'
      assert.equal(coordinatorMod.getBsaleSyncRolloutConfig().supervisorEnabled, true)

      const cronEnabledRes = await workerRouteMod.POST(
        new Request('http://localhost/api/cron/bsale-sync-worker', {
          method: 'POST',
          headers: { authorization: 'Bearer sync04-cron-secret' },
        }),
      )
      const cronEnabledJson = await cronEnabledRes.json()
      assert.equal(cronEnabledJson.success, true)
      assert.deepEqual(cronEnabledJson.completedIds, [enqDeploy.requestId], JSON.stringify(cronEnabledJson))

      // 5D: Desactivar en caliente detiene inmediatamente el supervisor
      runtimeMod.startBsaleSyncQueueServerSupervisor()
      process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'false'
      await queueActionsMod.getPreparationSyncQueueSnapshot({ trackedRequestIds: [] })
      runtimeMod.stopBsaleSyncQueueServerSupervisor()
    })

    // ─── 6. PUBLICACIÓN INDEPENDIENTE DE SYNC SOBRE origin/main ────────────
    await t.test('6. Publicación independiente de SYNC sobre origin/main (8ed538e): compila con 0 errores TypeScript y excluye COM-01, Adquisiciones, CxP, Recepciones y Mermas', async () => {
      const tmpWorktree = mkdtempSync('/tmp/mym-sync04-pub-')
      rmSync(tmpWorktree, { recursive: true, force: true })
      let keepManualWorktree = false

      try {
        execFileSync('git', ['worktree', 'add', '--detach', tmpWorktree, 'origin/main'], {
          cwd: PROJECT_ROOT,
          stdio: 'pipe',
        })

        // Enlazar node_modules para ejecutar tsc --noEmit real sobre el árbol aislado de origin/main
        symlinkSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(tmpWorktree, 'node_modules'))

        // A) Archivos nuevos y modificados 100% exclusivos de SYNC
        const syncDirectFiles = [
          'supabase/migrations/20261127151840_integraciones_bsale_sync_coordinator.sql',
          'supabase/migrations/20261127151858_integraciones_bsale_sync_queue.sql',
          'src/lib/integraciones/bsale-sync-coordinator.ts',
          'src/lib/integraciones/bsale-sync-queue.ts',
          'src/lib/integraciones/bsale-sync-queue-runtime.ts',
          'src/lib/integraciones/bsale-sync-queue-status.ts',
          'src/app/api/cron/bsale-sync-worker/route.ts',
          'src/app/actions/logistica/sales-order-preparation-sync-queue.ts',
          'src/instrumentation.ts',
          'src/middleware.ts',
          'src/lib/bsale/client.ts',
          'src/lib/integraciones/bsale-document-hydration.ts',
          'src/lib/integraciones/bsale-sync-types.ts',
          'src/app/actions/integraciones/bsale-sync.ts',
          'src/components/integraciones/bsale-replenishment-topbar-control.tsx',
          'src/app/actions/logistica/sales-order-preparation-incident-sync.ts',
          'src/modules/logistica/preparacion-pedidos/preparation-sync-policy.ts',
          'src/modules/logistica/preparacion-pedidos/sales-order-card.tsx',
          'src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx',
          'src/modules/logistica/auditoria/sales-order-audit-drawer.tsx',
          'scripts/test-bsale-sync-coordinator.mjs',
          'scripts/test-bsale-sync-queue.mjs',
          'scripts/test-bsale-sync03-operational-integration.mjs',
          'scripts/test-bsale-sync04-prepublish-validation.mjs',
        ]

        for (const rel of syncDirectFiles) {
          const dest = path.join(tmpWorktree, rel)
          mkdirSync(path.dirname(dest), { recursive: true })
          copyFileSync(path.join(PROJECT_ROOT, rel), dest)
        }

        // B) Aplicar ÚNICAMENTE los hunks de SYNC en los 3 archivos compartidos con COM-01 / Adquisiciones:
        // 1. src/components/layout/app-topbar.tsx (preservando href '/dashboard/adquisiciones' de origin/main)
        const originTopbar = readFileSync(path.join(tmpWorktree, 'src/components/layout/app-topbar.tsx'), 'utf8')
        const patchedTopbar = originTopbar.replace(
          `<BsaleReplenishmentTopbarControl\n            isSuperUsuario={profile.roles?.name === 'SUPER_USUARIO'}\n          />`,
          `<BsaleReplenishmentTopbarControl\n            isSuperUsuario={profile.roles?.name === 'SUPER_USUARIO'}\n            roleName={profile.roles?.name}\n            permissions={permissions}\n          />`,
        )
        assert.notEqual(patchedTopbar, originTopbar, 'Hunk SYNC aplicado en app-topbar.tsx')
        assert.equal(patchedTopbar.includes("href: '/dashboard/adquisiciones'"), true, 'Se conserva href original de Adquisiciones')
        writeFileSync(path.join(tmpWorktree, 'src/components/layout/app-topbar.tsx'), patchedTopbar)

        // 2. src/app/actions/logistica/sales-order-preparation.ts (tomar base origin/main y reemplazar solo desde OperationalBsaleSyncResult hasta EOF)
        const originPrepActions = readFileSync(path.join(tmpWorktree, 'src/app/actions/logistica/sales-order-preparation.ts'), 'utf8')
        const currentPrepActions = readFileSync(path.join(PROJECT_ROOT, 'src/app/actions/logistica/sales-order-preparation.ts'), 'utf8')
        const marker = 'export type OperationalBsaleSyncResult ='
        assert.equal(originPrepActions.includes(marker), true)
        assert.equal(currentPrepActions.includes(marker), true)
        const patchedPrepActions = originPrepActions.slice(0, originPrepActions.indexOf(marker))
          + currentPrepActions.slice(currentPrepActions.indexOf(marker))
        assert.equal(patchedPrepActions.includes('executeVerifiedPreparationStartRoute'), false, 'COM-01 excluido de sales-order-preparation.ts')
        assert.equal(patchedPrepActions.includes('move_audit_to_preparation_guarded_v1'), false, 'COM-01 excluido de sales-order-preparation.ts')
        writeFileSync(path.join(tmpWorktree, 'src/app/actions/logistica/sales-order-preparation.ts'), patchedPrepActions)

        // 3. src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx (excluir las 3 adiciones locales de COM-01)
        let panelSource = readFileSync(
          path.join(PROJECT_ROOT, 'src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx'),
          'utf8',
        )
        panelSource = panelSource.replace(
          /const preparationStartOperations = new Map<string, string>\(\)[\s\S]*?function completePreparationStartOperation\(cardId: string\) \{\n  preparationStartOperations\.delete\(cardId\)\n  try \{ sessionStorage\.removeItem\(`preparation-start:\$\{cardId\}`\) \} catch \{ \/\* storage is optional \*\/ \}\n\}\n\n/,
          '',
        )
        panelSource = panelSource.replace(
          `      const operationId = fromStatus === 'PENDING_ROUTE_PREP' && toStatus === 'IN_PREPARATION' ? preparationStartOperation(card.card_id) : undefined\n      const res = await moveSalesOrderPreparationCard({ cardId: card.card_id, toStatus, observation, operationId })`,
          `      const res = await moveSalesOrderPreparationCard({ cardId: card.card_id, toStatus, observation })`,
        )
        panelSource = panelSource.replace(
          `      if (operationId) completePreparationStartOperation(card.card_id)\n`,
          '',
        )
        panelSource = panelSource.replace(
          `        const operationId = preparationStartOperation(card.card_id)\n        const res = await moveSalesOrderPreparationCard({ cardId: card.card_id, toStatus: 'IN_PREPARATION', operationId })\n        if (res.ok) completePreparationStartOperation(card.card_id)`,
          `        const res = await moveSalesOrderPreparationCard({ cardId: card.card_id, toStatus: 'IN_PREPARATION' })`,
        )
        assert.equal(panelSource.includes('preparationStartOperation'), false, 'COM-01 excluido de sales-order-preparation-panel.tsx')
        writeFileSync(
          path.join(tmpWorktree, 'src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx'),
          panelSource,
        )

        // Verificar lista exacta de archivos tocados respecto de origin/main
        const statusLines = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: tmpWorktree, encoding: 'utf8' })
          .split('\n')
          .map(l => l.trim())
          .filter(Boolean)
          .filter(l => !l.endsWith('node_modules'))

        const expectedPaths = new Set([
          ...syncDirectFiles,
          'src/components/layout/app-topbar.tsx',
          'src/app/actions/logistica/sales-order-preparation.ts',
          'src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx',
        ])
        assert.equal(statusLines.length, expectedPaths.size, `Sólo deben existir los ${expectedPaths.size} archivos exclusivos de SYNC`)
        for (const line of statusLines) {
          const filePath = line.replace(/^[MADRCU?!]{1,2}\s+/, '')
          assert.equal(expectedPaths.has(filePath), true, `Archivo inesperado en publicación SYNC: ${filePath}`)
          assert.equal(/adquisiciones|cuentas-por-pagar|recepciones|mermas|globals\.css|verified_start|commercial_version_unification/.test(filePath), false)
        }

        // Ejecutar TypeScript compiler real sobre origin/main + SYNC aislado
        execFileSync(path.join(PROJECT_ROOT, 'node_modules/.bin/tsc'), ['--noEmit'], {
          cwd: tmpWorktree,
          stdio: 'pipe',
        })

        if (process.env.SYNC04_KEEP_MANUAL_WORKTREE === 'true') {
          rmSync(path.join(tmpWorktree, 'node_modules'))
          cpSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(tmpWorktree, 'node_modules'), {
            recursive: true, mode: constants.COPYFILE_FICLONE,
          })
          symlinkSync(path.join(PROJECT_ROOT, '.env.local'), path.join(tmpWorktree, '.env.local'))
          keepManualWorktree = true
          console.log(`SYNC04_MANUAL_WORKTREE=${tmpWorktree}`)
          return
        }

        // Compilar y arrancar Next real sobre el árbol aislado, con servicios exclusivamente locales.
        // El entorno explícito evita heredar credenciales o URLs de la máquina anfitriona.
        const isolatedEnv = {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR || '/tmp',
          NODE_ENV: 'production',
          NEXT_TELEMETRY_DISABLED: '1',
          NEXT_PUBLIC_SUPABASE_URL: localServers.supabaseUrl,
          NEXT_PUBLIC_SUPABASE_ANON_KEY: 'sync04-anon',
          SUPABASE_SERVICE_ROLE_KEY: 'sync04-service',
          BSALE_API_BASE_URL: localServers.bsaleBaseUrl,
          BSALE_ACCESS_TOKEN: 'sync04-bsale-token',
          BSALE_ACCESS_TOKEN_CAYLO: 'sync04-bsale-token',
          CRON_SECRET: 'sync04-cron-secret',
          BSALE_SYNC_COORDINATOR_ENABLED: 'true',
          BSALE_SYNC_QUEUE_ENABLED: 'true',
          BSALE_SYNC_SUPERVISOR_ENABLED: 'false',
        }
        rmSync(path.join(tmpWorktree, 'node_modules'))
        cpSync(path.join(PROJECT_ROOT, 'node_modules'), path.join(tmpWorktree, 'node_modules'), {
          recursive: true, mode: constants.COPYFILE_FICLONE,
        })
        const nextBin = path.join(tmpWorktree, 'node_modules/next/dist/bin/next')
        execFileSync(process.execPath, [nextBin, 'build'], {
          cwd: tmpWorktree, env: isolatedEnv, stdio: 'pipe', timeout: 180_000,
        })

        await pg15.pool.query('TRUNCATE integraciones.bsale_sync_queue, integraciones.bsale_sync_locks, integraciones.bsale_sync_scope_cooldowns')
        process.env.BSALE_SYNC_SUPERVISOR_ENABLED = 'false'
        runtimeMod.resetBsaleSyncQueueRuntimeForTests()
        queueMod.resetGlobalBsaleSyncQueueManagerForTests()
        const manager = runtimeMod.ensureBsaleSyncQueueRuntimeRegistered()
        const pending = await manager.enqueue({ companyId: COMPANY_CAYLO, operationKind: 'WAREHOUSE_MANUAL', ttlSeconds: 300 })

        const portProbe = http.createServer()
        await new Promise(resolve => portProbe.listen(0, '127.0.0.1', resolve))
        const port = portProbe.address().port
        await new Promise(resolve => portProbe.close(resolve))
        let child = null
        let childOutput = ''
        const startNext = async (flags) => {
          childOutput = ''
          child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
            cwd: tmpWorktree,
            env: { ...isolatedEnv, ...flags },
            stdio: ['ignore', 'pipe', 'pipe'],
          })
          child.stdout.on('data', data => { childOutput += data.toString() })
          child.stderr.on('data', data => { childOutput += data.toString() })
          const deadline = Date.now() + 20_000
          while (!/Ready in/i.test(childOutput) && Date.now() < deadline && child.exitCode === null) {
            await new Promise(resolve => setTimeout(resolve, 50))
          }
          assert.match(childOutput, /Ready in/i, `Next no arrancó: ${childOutput}`)
        }
        const stopNext = async () => {
          if (!child) return
          const proc = child
          child = null
          if (proc.exitCode !== null) return
          const exited = new Promise(resolve => proc.once('exit', resolve))
          proc.kill('SIGTERM')
          await exited
        }
        try {
          // Cada flag debe desactivar el drenaje incluso con los demás habilitados.
          for (const disabledFlag of ['BSALE_SYNC_COORDINATOR_ENABLED', 'BSALE_SYNC_QUEUE_ENABLED', 'BSALE_SYNC_SUPERVISOR_ENABLED']) {
            await startNext({
              BSALE_SYNC_COORDINATOR_ENABLED: 'true',
              BSALE_SYNC_QUEUE_ENABLED: 'true',
              BSALE_SYNC_SUPERVISOR_ENABLED: 'true',
              [disabledFlag]: 'false',
            })
            await new Promise(resolve => setTimeout(resolve, 2500))
            const disabled = (await pg15.pool.query('SELECT status FROM integraciones.bsale_sync_queue WHERE id = $1', [pending.requestId])).rows[0]
            assert.equal(disabled.status, 'PENDING', `${disabledFlag}=false procesó la cola: ${childOutput}`)
            await stopNext()
          }

          // Reinicio real: instrumentation debe arrancar el supervisor y recuperar la fila persistente.
          await startNext({ BSALE_SYNC_SUPERVISOR_ENABLED: 'true' })
          const deadline = Date.now() + 20_000
          let row
          do {
            row = (await pg15.pool.query('SELECT status, last_error_message FROM integraciones.bsale_sync_queue WHERE id = $1', [pending.requestId])).rows[0]
            if (row.status === 'COMPLETED' || row.status === 'FAILED') break
            await new Promise(resolve => setTimeout(resolve, 100))
          } while (Date.now() < deadline)
          assert.equal(row.status, 'COMPLETED', `No se drenó tras reiniciar Next sin HTTP: ${JSON.stringify(row)} ${childOutput}`)
        } finally {
          await stopNext()
        }
      } finally {
        if (!keepManualWorktree) {
          try {
            execFileSync('git', ['worktree', 'remove', '--force', tmpWorktree], { cwd: PROJECT_ROOT, stdio: 'ignore' })
          } catch {
            rmSync(tmpWorktree, { recursive: true, force: true })
          }
        }
      }
    })
  } finally {
    runtimeMod?.resetBsaleSyncQueueRuntimeForTests?.()
    queueMod?.resetGlobalBsaleSyncQueueManagerForTests?.()
    await localServers?.stop().catch(() => {})
    await pg15.stop()
    for (const k of Object.keys(process.env)) {
      if (!(k in prevEnv)) delete process.env[k]
    }
    Object.assign(process.env, prevEnv)
  }
})
