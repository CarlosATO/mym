import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const script = await readFile(new URL('scripts/preflight-bsale-legacy-datafix-jit.mjs', root), 'utf8')

test('universo fijo de 61 y especiales ausentes', () => {
  assert.match(script, /CANDIDATE_IDS = Object\.freeze/) 
  assert.match(script, /CANDIDATE_IDS\.length !== 61/)
  assert.match(script, /new Set\(CANDIDATE_IDS\)\.size !== 61/)
  for (const id of [83326, 83327, 83878, 90045, 91741, 92172]) assert.match(script, new RegExp(String(id)))
  assert.match(script, /CANDIDATE_IDS\.some\(\(id\) => SPECIAL_IDS\.includes\(id\)\)/)
})

test('API oficial GET-only, token no imprimido y retries fail-closed', () => {
  assert.match(script, /https:\/\/api\.bsale\.cl\/v1/)
  assert.match(script, /method: 'GET'/)
  assert.doesNotMatch(script, /method:\s*'(POST|PUT|DELETE)'/)
  assert.doesNotMatch(script, /report-stock\.bsale\.app|bsale-session|playwright|puppeteer|cookie/i)
  assert.match(script, /access_token: token/)
  assert.doesNotMatch(script, /console\.log\([^\n]*token|process\.stdout[^\n]*token/)
  assert.match(script, /429|MAX_RETRIES|API_ERROR/)
})

test('revalida 61 NV, type23/state0, details completos y cantidades', () => {
  assert.match(script, /\/documents\/\$\{id\}\.json/)
  assert.match(script, /\/documents\/\$\{id\}\/details\.json/)
  assert.match(script, /document_type_id: documentType\(doc\)/)
  assert.match(script, /document_type\?\.id/)
  assert.match(script, /state: documentState\(doc\)/)
  assert.match(script, /details\.length > 0/)
  assert.match(script, /detailId\(row\) !== null && detailQuantity\(row\) !== null/)
})

test('scan mensual completo desde 2026-02-01 sin filtro de estado', () => {
  assert.match(script, /const START_DATE = '2026-02-01'/)
  assert.match(script, /monthly_windows: true/)
  assert.match(script, /generationdaterange/)
  assert.match(script, /document_types: CLOSURE_TYPES/)
  assert.match(script, /no_state_filter: true/)
  assert.match(script, /CLOSURE_TYPES = \[1, 5, 7\]/)
  assert.match(script, /MAX_PAGES/)
})

test('match canónico relatedDetailId y ambos estados bloquean', () => {
  assert.match(script, /relatedDetailId\s*\?\?\s*row\?\.related_detail_bsale_id/)
  assert.match(script, /row\?\.bsale_id\s*\?\?\s*row\?\.bsale_detail_id/)
  assert.match(script, /sourceDetailIds\.has\(related\)/)
  assert.match(script, /ACTIVE_CHILD_STATE_0/)
  assert.match(script, /INACTIVE_OR_OTHER_STATE_CHILD/)
  assert.match(script, /reasons\.push\(`RELATED_CHILD_/)
  assert.match(script, /relatedMatches\.length === 0/)
})

test('evidencia, DB read-only, drift y autorización fail-closed', () => {
  assert.match(script, /createHash\('sha256'\)/)
  assert.match(script, /CSV_SHA256/)
  assert.match(script, /JSON_SHA256/)
  assert.match(script, /db\.from\(table\)\.select\('\*'\)/)
  assert.doesNotMatch(script, /\.from\([^)]*\)\.(insert|update|delete)\(|\.rpc\(/)
  assert.match(script, /db\.available && db\.drift\.length === 0/)
  assert.match(script, /DATA_FIX_AUTHORIZED: authorized/)
})

test('salida temporal no contiene secretos y reporta matches completos', () => {
  assert.match(script, /tmpdir\(\)/)
  assert.match(script, /writeFileSync\(outputPath, `\$\{JSON\.stringify\(report/)
  assert.match(script, /source_detail/)
  assert.match(script, /child_detail/)
  assert.match(script, /reasons_not_authorized/)
  assert.doesNotMatch(script, /JSON\.stringify\([^)]*token/)
})

test('no altera data-fix ni usa referencias como prueba principal', () => {
  assert.doesNotMatch(script, /20261019100000_logistica_archive_legacy_backfill_cards\.sql/)
  assert.doesNotMatch(script, /references\.json/i)
})
