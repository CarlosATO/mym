import fs from 'fs'
import os from 'os'
import path from 'path'
import { pathToFileURL } from 'url'
import { execFileSync } from 'child_process'
import Module from 'module'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'

const repoRoot = process.cwd()
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'campaign-excel-desc-'))
process.env.NODE_PATH = path.join(repoRoot, 'node_modules')
Module._initPaths()

execFileSync(
  'npx',
  [
    'tsc',
    '--module',
    'commonjs',
    '--target',
    'es2020',
    '--moduleResolution',
    'node',
    '--esModuleInterop',
    '--skipLibCheck',
    '--outDir',
    tmpRoot,
    'src/modules/inventarios/lib/excel-import.ts',
    'src/modules/inventarios/lib/campaign-excel.ts',
    'src/modules/inventarios/lib/campaign-excel-template.ts',
  ],
  { cwd: repoRoot, stdio: 'inherit' }
)

const buildCampaignImportTemplatePath = resolveCompiledPath('campaign-excel-template.js')
const parseCampaignImportPath = resolveCompiledPath('campaign-excel.js')
const { buildCampaignImportTemplate } = await import(pathToFileURL(buildCampaignImportTemplatePath).href)
const { parseCampaignImportBuffer } = await import(pathToFileURL(parseCampaignImportPath).href)

function sheetRows(buffer, sheetName = 'Datos') {
  const wb = XLSX.read(buffer, { type: 'buffer' })
  return XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: false })
}

function makeWorkbook(rows) {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Datos')
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }))
}

function resolveCompiledPath(filename) {
  const candidates = [
    path.join(tmpRoot, 'src/modules/inventarios/lib', filename),
    path.join(tmpRoot, 'modules/inventarios/lib', filename),
    path.join(tmpRoot, filename),
  ]
  const found = candidates.find(candidate => fs.existsSync(candidate))
  if (!found) {
    throw new Error(`No se encontro el archivo compilado ${filename}`)
  }
  return found
}

function headerRow(buffer) {
  return sheetRows(buffer)[0]
}

function assertNoIssues(result) {
  assert.equal(result.issues.length, 0)
}

const totalTemplate = buildCampaignImportTemplate({ scope: 'TOTAL_CAMPAIGN' })
const siteTemplate = buildCampaignImportTemplate({ scope: 'BY_SITE' })
const locationTemplate = buildCampaignImportTemplate({ scope: 'BY_LOCATION' })

assert.deepEqual(headerRow(totalTemplate), ['SKU', 'DESCRIPCION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'])
assert.deepEqual(headerRow(siteTemplate), ['SKU', 'DESCRIPCION', 'CODIGO_UNIDAD', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'])
assert.deepEqual(headerRow(locationTemplate), ['SKU', 'DESCRIPCION', 'CODIGO_UNIDAD', 'CODIGO_UBICACION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'])

const totalInstructions = sheetRows(totalTemplate, 'Instrucciones').flat().map(value => String(value ?? ''))
assert(totalInstructions.some(line => line.includes('Descripcion: sirve como referencia humana')))
assert(totalInstructions.some(line => line.includes('PetGroup utilizara la descripcion oficial del catalogo despues de validar')))

const descWorkbook = makeWorkbook([
  ['SKU', 'DESCRIPCIÓN', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
  ['SKU-001', '  Descripcion  legible  ', 3, 10],
])
const descResult = parseCampaignImportBuffer(descWorkbook.buffer.slice(descWorkbook.byteOffset, descWorkbook.byteOffset + descWorkbook.byteLength), 'TOTAL_CAMPAIGN')
assert.equal(descResult.rows[0].enteredDescription, 'Descripcion  legible')
assert.equal(descResult.rows[0].rawValues.DESCRIPCION, 'Descripcion  legible')
assertNoIssues(descResult)

const blankDescWorkbook = makeWorkbook([
  ['SKU', 'DESCRIPCION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
  ['SKU-001', '   ', 3, 10],
])
const blankDescResult = parseCampaignImportBuffer(blankDescWorkbook.buffer.slice(blankDescWorkbook.byteOffset, blankDescWorkbook.byteOffset + blankDescWorkbook.byteLength), 'TOTAL_CAMPAIGN')
assert.equal(blankDescResult.rows[0].enteredDescription, null)
assertNoIssues(blankDescResult)

const noDescWorkbook = makeWorkbook([
  ['SKU', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
  ['SKU-001', 3, 10],
])
const noDescResult = parseCampaignImportBuffer(noDescWorkbook.buffer.slice(noDescWorkbook.byteOffset, noDescWorkbook.byteOffset + noDescWorkbook.byteLength), 'TOTAL_CAMPAIGN')
assert.equal(noDescResult.rows[0].enteredDescription, null)
assertNoIssues(noDescResult)

console.log('campaign-excel-description: PASS')
