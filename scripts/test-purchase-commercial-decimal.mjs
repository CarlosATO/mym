import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(new URL('../src/lib/adquisiciones/purchase-commercial-decimal.ts', import.meta.url), 'utf8')
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText
const { convertPurchaseDecimal: convert, isPurchaseMultiple: multiple, commercialGrossCents, commercialReceiptGrossCents } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`)

test('513135: quantity conversion and immediate multiple validation', () => {
  assert.deepEqual(convert('60', 6, 'divide', false), { ok: true, value: '10' })
  assert.deepEqual(convert('20', 6, 'multiply', true), { ok: true, value: '120' })
  assert.equal(multiple('60', 6), true)
  assert.equal(multiple('65', 6), false)
  assert.equal(multiple('6.0001', 6), false)
})
test('prices convert exactly and refuse unrepresentable internal precision', () => {
  assert.deepEqual(convert('3624', 6, 'multiply', false), { ok: true, value: '21744' })
  assert.deepEqual(convert('18000', 6, 'divide', true), { ok: true, value: '3000' })
  assert.deepEqual(convert('0.1234', 6, 'multiply', false), { ok: true, value: '0.7404' })
  assert.deepEqual(convert('0.7404', 6, 'divide', true), { ok: true, value: '0.1234' })
  assert.deepEqual(convert('1', 6, 'divide', true), { ok: false, error: 'PRECISION' })
})
test('factor one, invalid values, and numeric(14,4) overflow', () => {
  assert.deepEqual(convert('12,5', 1, 'divide', true), { ok: true, value: '12.5' })
  assert.equal(multiple('12.5', 1), true)
  assert.deepEqual(convert('2.00001', 6, 'multiply', true), { ok: false, error: 'INVALID' })
  assert.deepEqual(convert('9999999999.9999', 6, 'multiply', true), { ok: false, error: 'OVERFLOW' })
  assert.equal(multiple('12', 0), false)
})

test('exact commercial price reconciles full and split receipts without accumulated rounding', () => {
  assert.equal(commercialGrossCents('6', '10000', 6), 1000000n)
  assert.equal(commercialGrossCents('600', '10000', 6), 100000000n)
  const splits = [['0', '1'], ['1', '2'], ['2', '6']]
  const amounts = splits.map(([before, after]) => commercialReceiptGrossCents(before, after, '10000', 6))
  assert.deepEqual(amounts, [166667n, 166666n, 666667n])
  assert.equal(amounts.reduce((a, b) => a + b, 0n), commercialGrossCents('6', '10000', 6))
  assert.equal(commercialReceiptGrossCents('2', '1', '10000', 6), null)
})
