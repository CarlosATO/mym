import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const require = createRequire(import.meta.url)
const source = readFileSync(new URL('../src/app/actions/control-financiero/bank-statements.ts', import.meta.url), 'utf8')
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const exports = {}
const mockedModule = new Proxy({}, { get: () => () => null })
new Function('require', 'exports', compiled)((name) => {
  if (name.startsWith('node:')) return require(name)
  return mockedModule
}, exports)

test('paginates all bank movements beyond 1,000 and 5,000 without duplicates', async () => {
  const movements = Array.from({ length: 6122 }, (_, index) => ({
    id: `movement-${index + 1}`,
    bank_account_id: index < 3810 ? 'chile' : 'itau',
  }))
  const requests = []
  const loaded = await exports.paginateFinancialRows(async (from, to) => {
    requests.push([from, to])
    return movements.slice(from, to + 1)
  })

  assert.equal(loaded.length, 6122)
  assert.equal(new Set(loaded.map((movement) => movement.id)).size, 6122)
  assert.deepEqual(requests, [[0, 999], [1000, 1999], [2000, 2999], [3000, 3999], [4000, 4999], [5000, 5999], [6000, 6999]])
  assert.equal(loaded.filter((movement) => movement.bank_account_id === 'chile').length, 3810)
  assert.equal(loaded.filter((movement) => movement.bank_account_id === 'itau').length, 2312)
})

test('deduplicates IDs returned at a page boundary', async () => {
  const pages = [
    [{ id: 'one' }, { id: 'two' }],
    [{ id: 'two' }, { id: 'three' }],
  ]
  let page = 0
  const loaded = await exports.paginateFinancialRows(async () => pages[page++] ?? [], 2)
  assert.deepEqual(loaded.map((row) => row.id), ['one', 'two', 'three'])
})
