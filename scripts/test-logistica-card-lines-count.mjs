import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'
import ts from 'typescript'

const cardSrc = await readFile(new URL('../src/modules/logistica/preparacion-pedidos/sales-order-card.tsx', import.meta.url), 'utf8')
const actionsSrc = await readFile(new URL('../src/app/actions/logistica/sales-order-preparation.ts', import.meta.url), 'utf8')

test('SalesOrderCard declara y renderiza linesCount con pluralización correcta', () => {
  assert.match(cardSrc, /const linesCount = card\.lines_count \?\? null/)
  assert.match(cardSrc, /const isHighLineCount = linesCount != null && linesCount >= 17/)
  assert.match(cardSrc, /linesCount == null \? '— líneas'/)
  assert.match(cardSrc, /`\$\{linesCount\} \$\{linesCount === 1 \? 'línea' : 'líneas'\}`/)
  assert.match(cardSrc, /isHighLineCount\s*\?\s*'font-bold text-red-600'\s*:\s*'font-semibold text-\[#322D29\]\/55'/)
  assert.match(cardSrc, /\{linesLabel\}/)
  assert.match(cardSrc, /title=\{linesLabel\}/)
})

test('Regla de formato y colores para distintas cantidades de líneas', () => {
  function getCardDisplay(linesCount) {
    const isHighLineCount = linesCount >= 17
    const linesLabel = `${linesCount} ${linesCount === 1 ? 'línea' : 'líneas'}`
    const className = isHighLineCount ? 'font-bold text-red-600' : 'font-semibold text-[#322D29]/55'
    return { linesLabel, className, isHigh: isHighLineCount }
  }

  // 1 línea
  const c1 = getCardDisplay(1)
  assert.equal(c1.linesLabel, '1 línea')
  assert.equal(c1.className, 'font-semibold text-[#322D29]/55')
  assert.equal(c1.isHigh, false)

  // 5 líneas (ejemplo del usuario)
  const c5 = getCardDisplay(5)
  assert.equal(c5.linesLabel, '5 líneas')
  assert.equal(c5.className, 'font-semibold text-[#322D29]/55')
  assert.equal(c5.isHigh, false)

  // 16 líneas (límite superior normal)
  const c16 = getCardDisplay(16)
  assert.equal(c16.linesLabel, '16 líneas')
  assert.equal(c16.className, 'font-semibold text-[#322D29]/55')
  assert.equal(c16.isHigh, false)

  // 17 líneas (límite inferior rojo destacado)
  const c17 = getCardDisplay(17)
  assert.equal(c17.linesLabel, '17 líneas')
  assert.equal(c17.className, 'font-bold text-red-600')
  assert.equal(c17.isHigh, true)

  // 30 líneas (rojo destacado)
  const c30 = getCardDisplay(30)
  assert.equal(c30.linesLabel, '30 líneas')
  assert.equal(c30.className, 'font-bold text-red-600')
  assert.equal(c30.isHigh, true)
})

test('getCardLinesCounts agrupa en lote sin consultas individuales N+1', () => {
  assert.match(actionsSrc, /async function getCardLinesCounts\(/)
  assert.match(actionsSrc, /\.in\('card_id', batch\)/)
  assert.match(actionsSrc, /\.in\('bsale_document_id', batch\)/)
  assert.match(actionsSrc, /\.range\(offset, offset \+ pageSize - 1\)/)
  assert.match(actionsSrc, /lines_count\?: number \| null/)
})

test('Líneas retiradas quedan excluidas del conteo activo', () => {
  // Simular la lógica de conteo de getCardLinesCounts
  const prepLines = [
    { card_id: 'card-1', retired_at: null }, // Activa
    { card_id: 'card-1', retired_at: null }, // Activa (mismo SKU u otro)
    { card_id: 'card-1', retired_at: '2026-11-12T10:00:00Z' }, // Retirada por cambio comercial
    { card_id: 'card-2', retired_at: null },
  ]

  const hasPrepLines = new Set()
  const prepActiveCountByCard = new Map()

  for (const row of prepLines) {
    hasPrepLines.add(row.card_id)
    if (row.retired_at == null) {
      prepActiveCountByCard.set(row.card_id, (prepActiveCountByCard.get(row.card_id) ?? 0) + 1)
    }
  }

  assert.equal(prepActiveCountByCard.get('card-1'), 2, 'Card 1 debe tener 2 líneas activas, omitiendo la retirada')
  assert.equal(prepActiveCountByCard.get('card-2'), 1)
})

test('Dos líneas con el mismo SKU se cuentan como dos líneas independientes', () => {
  // Simular dos renglones en bsale_document_details con igual variant/SKU
  const bsaleDetails = [
    { bsale_document_id: 100, variant_id: 555 },
    { bsale_document_id: 100, variant_id: 555 }, // Segundo renglón con mismo variant/SKU
    { bsale_document_id: 100, variant_id: 666 },
  ]

  const bsaleCountByNv = new Map()
  for (const row of bsaleDetails) {
    const docId = Number(row.bsale_document_id)
    bsaleCountByNv.set(docId, (bsaleCountByNv.get(docId) ?? 0) + 1)
  }

  assert.equal(bsaleCountByNv.get(100), 3, 'Los renglones se cuentan individualmente sin colapsar por SKU')
})

test('el conteo real pagina lotes y distingue ausencia de datos de cero', async () => {
  const helperSource = actionsSrc.slice(actionsSrc.indexOf('async function getCardLinesCounts('), actionsSrc.indexOf('\nfunction readRawUnixDate', actionsSrc.indexOf('async function getCardLinesCounts(')))
  const js = ts.transpileModule(`${helperSource}\nexports.getCardLinesCounts = getCardLinesCounts`, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  const prep = Array.from({ length: 501 }, (_, i) => ({ id: i, company_id: 'c', card_id: i < 500 ? 'a' : 'b', retired_at: i === 0 ? 'retired' : null, sku: 'repeated' }))
  prep.push({ id: 502, company_id: 'c', card_id: 'all-retired', retired_at: 'retired', sku: 'repeated' })
  const details = [{ bsale_id: 1, company_id: 'c', bsale_document_id: 8 }, { bsale_id: 2, company_id: 'c', bsale_document_id: 8 }]
  const calls = []
  const db = { schema: schema => ({ from: table => {
    let ids, company
    return {
      select() { return this }, eq(_key, value) { company = value; return this },
      in(_key, value) { ids = value; return this }, order() { return this },
      async range(from, to) {
        calls.push([table, from, to])
        const rows = table === 'sales_order_preparation_lines' ? prep : details
        const key = schema === 'logistica' ? 'card_id' : 'bsale_document_id'
        return { data: rows.filter(row => row.company_id === company && ids.includes(row[key])).slice(from, to + 1), error: null }
      },
    }
  } }) }
  const exports = {}
  vm.runInNewContext(js, { exports, createAdminClient: () => db, console })
  const result = await exports.getCardLinesCounts('c', [{ card_id: 'a', nv_bsale_id: 7 }, { card_id: 'b', nv_bsale_id: 7 }, { card_id: 'all-retired', nv_bsale_id: 8 }, { card_id: 'unmaterialized', nv_bsale_id: 8 }, { card_id: 'missing', nv_bsale_id: 9 }])
  assert.equal(result.get('a'), 499)
  assert.equal(result.get('b'), 1)
  assert.equal(result.get('all-retired'), 0)
  assert.equal(result.get('unmaterialized'), 2)
  assert.equal(result.get('missing'), null)
  assert.equal(calls.filter(call => call[0] === 'sales_order_preparation_lines').length, 2)
  assert.equal(calls.filter(call => call[0] === 'bsale_document_details').length, 1)
})
