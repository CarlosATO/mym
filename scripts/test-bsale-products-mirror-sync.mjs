import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const source = await readFile(new URL('../src/lib/integraciones/bsale-products-sync.ts', import.meta.url), 'utf8')
const importBlock = source.slice(source.indexOf("import { createClient }"), source.indexOf('const sleep'))
const harnessSource = source.replace(importBlock, `
const createClient = () => ({})
const planUniqueSafeProductUpdates = () => ({ toUpdate: [], toInsert: [] })
const collectBsaleBrandRecords = () => []
const extractBsaleBrand = () => ({ id: null, href: null, name: null })
const executeSequentialBatches = async () => ({ batchesProcessed: 0, itemsProcessed: 0 })
const crypto = { createHash: () => ({ update: () => ({ digest: () => 'hash' }) }) }
const createSyncRun = async () => 'run-1'
const finishSyncRun = async () => undefined
const recordSyncError = async () => undefined
const tryAcquireSyncLock = async () => true
const releaseSyncLock = async () => undefined
const getBsaleConfigForCompany = () => ({ baseUrl: '', accessToken: '' })
const normalizeSku = value => String(value || '').trim().toUpperCase()
`)
const harnessDirectory = await mkdtemp(join(tmpdir(), 'bsale-products-mirror-'))
const harnessPath = join(harnessDirectory, 'bsale-products-sync.ts')
await writeFile(harnessPath, harnessSource)
const { buildBsaleIntegrationMirrorRecords } = await import(pathToFileURL(harnessPath).href)
await rm(harnessDirectory, { recursive: true, force: true })

const variants = [
  { id: 7135, code: 'ck1004', description: '80GR', barCode: '765066765293', state: 0, unlimitedStock: 0, allowNegativeStock: 0, product: { id: 4426, name: 'CATS POLLO', state: 0, classification: 9, stockControl: 1, product_type: { id: 9, name: 'MARBEN/SNACK' } } },
  { id: 7140, code: 'ck1008', description: '80GR', barCode: '765066768492', state: 0, unlimitedStock: 0, allowNegativeStock: 0, product: { id: 4430, name: 'CATS POLLO CON CAMARON', state: 0, classification: 9, stockControl: 1, product_type: { id: 9, name: 'MARBEN/SNACK' } } },
  { id: 7141, code: 'mp005', description: '500GR', barCode: '', state: 0, unlimitedStock: 0, allowNegativeStock: 0, product: { id: 4431, name: 'MIX SEMILLAS', state: 0, classification: 9, stockControl: 1, product_type: { id: 9, name: 'MARBEN/SNACK' } } },
]

test('A. conserva el flujo existente hacia adquisiciones.products', () => {
  assert.match(source, /from\('products'\)\.insert\(chunk\)/)
  assert.match(source, /apply_bsale_product_updates/)
})

test('B. ahora hace upsert en integraciones.bsale_products', () => {
  assert.match(source, /schema\('integraciones'\)\.from\('bsale_products'\)\.upsert/)
  assert.match(source, /onConflict: 'company_id,bsale_id'/)
})

test('C. ahora hace upsert en integraciones.bsale_variants', () => {
  assert.match(source, /schema\('integraciones'\)\.from\('bsale_variants'\)\.upsert/)
})

test('D. una variante nueva aparece en el espejo', () => {
  const result = buildBsaleIntegrationMirrorRecords(variants, 'company-1')
  const variant = result.variants.find(row => row.bsale_id === 7140)
  assert.ok(variant)
  assert.equal(variant.bsale_product_id, 4430)
  assert.equal(variant.code, 'CK1008')
  assert.equal(variant.description, '80GR')
  assert.equal('bsale_sync_run_id' in variant, false)
})

test('E. una variante existente se actualiza sin duplicarse', () => {
  const result = buildBsaleIntegrationMirrorRecords(variants, 'company-1')
  assert.equal(result.variants.filter(row => row.bsale_id === 7135).length, 1)
  assert.equal(result.variants.find(row => row.bsale_id === 7135).code, 'CK1004')
})

test('F. segunda construcción es idempotente en contenido', () => {
  const first = buildBsaleIntegrationMirrorRecords(variants, 'company-1')
  const second = buildBsaleIntegrationMirrorRecords(variants, 'company-1')
  assert.deepEqual(second.variants.map(row => row.bsale_id), first.variants.map(row => row.bsale_id))
  assert.deepEqual(second.products.map(row => row.bsale_id), first.products.map(row => row.bsale_id))
})

test('G. no existe una segunda descarga del catálogo para el espejo', () => {
  const beforeMirror = source.slice(source.indexOf('while (hasMore)'), source.indexOf('const mirror ='))
  const afterMirror = source.slice(source.indexOf('const mirror ='), source.indexOf("// Evaluate against existing"))
  assert.match(beforeMirror, /variants\.json/)
  assert.doesNotMatch(afterMirror, /fetch\(|variants\.json|products\.json/)
})

test('H. no destruye mappings existentes', () => {
  assert.doesNotMatch(source, /delete\(\).*adquisiciones|delete\(\).*supplier|delete\(\).*mapping/i)
  assert.doesNotMatch(source, /delete\(\)[^\n]*mapping|delete\(\)[^\n]*supplier/i)
})

test('H2. productos del expand se deduplican antes del upsert', () => {
  const result = buildBsaleIntegrationMirrorRecords([
    ...variants,
    { id: 7999, code: 'DUP', description: '', product: { id: 4430, name: 'CATS POLLO CON CAMARON', state: 0, stockControl: 1 } },
  ], 'company-1')
  assert.equal(result.products.filter(row => row.bsale_id === 4430).length, 1)
  assert.equal(result.products.find(row => row.bsale_id === 4430).name, 'CATS POLLO CON CAMARON')
})
