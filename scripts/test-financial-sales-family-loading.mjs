import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'
import ts from 'typescript'

const require = createRequire(import.meta.url)
// Exercise the installed Next deduper with a cache scoped to one server render.
function renderFetch(transport) {
  const path = require.resolve('next/dist/server/lib/dedupe-fetch.js')
  const localRequire = createRequire(path)
  const module = { exports: {} }
  vm.runInNewContext(readFileSync(path, 'utf8'), {
    module, exports: module.exports, Request, URL,
    require: name => name === 'react' ? { cache: fn => {
      const entries = new Map()
      return key => {
        if (!entries.has(key)) entries.set(key, fn(key))
        return entries.get(key)
      }
    } } : localRequire(name),
  })
  return module.exports.createDedupeFetch(transport)
}

function api(fetch) {
  const source = readFileSync(new URL('../src/lib/control-financiero/finance-api.ts', import.meta.url), 'utf8')
  const module = { exports: {} }
  vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText, {
    module, exports: module.exports, fetch, AbortController, Error, TypeError,
    process: { env: { FINANCE_API_BASE_URL: 'https://finance.test' } },
    console: { error() {} },
    require: name => {
      if (name === '@/lib/supabase/server') return { createClient: async () => ({ auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) } }) }
      if (name === '@/app/actions/companies') return { getActiveCompanyId: async () => 'company-a' }
      throw new Error(`Unexpected import ${name}`)
    },
  })
  return module.exports
}

test('Next memoizes even a failed no-store GET in one render', async () => {
  let calls = 0
  const fetch = renderFetch(async () => { calls++; return Response.json({}, { status: 503 }) })
  await fetch('https://finance.test/families', { cache: 'no-store' })
  await fetch('https://finance.test/families', { cache: 'no-store' })
  assert.equal(calls, 1)
})

test('a transient provider failure makes one real retry and awaits the complete payload', async () => {
  let calls = 0
  let finish
  const complete = new Promise(resolve => { finish = resolve })
  const payload = { company_id: 'company-a', year: 2026, families: [{ family_key: 'a' }, { family_key: 'b' }], totals: { ytd: '100.00' } }
  const fetch = renderFetch(async (_url, options) => {
    assert.equal(options.headers['X-Company-Id'], 'company-a')
    calls++
    if (calls === 1) return Response.json({ detail: 'temporarily unavailable' }, { status: 503 })
    await complete
    return Response.json(payload)
  })
  let settled = false
  const pending = api(fetch).getFinanceSalesNetByFamily(2026).then(result => { settled = true; return result })
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 2)
  assert.equal(settled, false)
  finish()
  const result = await pending
  assert.equal(result.ok, true)
  assert.deepEqual(result.data, payload)
})

test('persistent and permission errors terminate without repeated retries', async () => {
  for (const [status, expected] of [[503, 2], [403, 1]]) {
    let calls = 0
    const result = await api(renderFetch(async () => { calls++; return Response.json({ detail: 'unavailable' }, { status }) })).getFinanceSalesNetByFamily(2026)
    assert.equal(result.ok, false)
    assert.equal(result.status, status)
    assert.equal(calls, expected)
  }
})

test('only a transport failure is retried; malformed JSON is not a transient network error', async () => {
  let calls = 0
  const recovered = await api(renderFetch(async () => {
    calls++
    if (calls === 1) throw new TypeError('fetch failed')
    return Response.json({ families: [{ family_key: 'a' }] })
  })).getFinanceSalesNetByFamily(2026)
  assert.equal(recovered.ok, true)
  assert.equal(calls, 2)

  calls = 0
  const invalid = await api(renderFetch(async () => {
    calls++
    return new Response('{broken-json')
  })).getFinanceSalesNetByFamily(2026)
  assert.equal(invalid.ok, false)
  assert.equal(calls, 1)
})

test('EERR waits for providers and blocks a finished report/export when loading failed', () => {
  const page = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/page.tsx', import.meta.url), 'utf8')
  const loading = readFileSync(new URL('../src/app/dashboard/analisis-comercial/control-financiero/estado-resultados/loading.tsx', import.meta.url), 'utf8')
  assert.match(page, /await Promise\.all\(/)
  assert.match(page, /getFinanceSalesNetByFamily\(2026\)/)
  const guard = page.indexOf('if (!familyResult.ok)')
  assert.ok(guard > page.indexOf('await Promise.all('))
  assert.ok(guard < page.indexOf('const sales ='))
  assert.match(page.slice(guard, page.indexOf('const sales =')), /return <main[\s\S]*<ApiError/)
  assert.match(loading, /role="status"/)
  assert.doesNotMatch(page, /window\.location\.reload|router\.refresh|setInterval/)
})
