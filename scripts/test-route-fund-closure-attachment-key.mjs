import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { settlementAttachmentExtension } from '../src/modules/adquisiciones/rendicion-rutas/utils/settlement-attachment-config.ts'

const actionPath = new URL('../src/app/actions/adquisiciones/route-fund-closures.ts', import.meta.url)
const action = await readFile(actionPath, 'utf8')

const problematicNames = [
  'comprobante con espacios.png',
  'foto (depósito) áéíóú.jpg',
  'comprobante.v1.final..webp',
  'Captura de pantalla 2026-08-26 a la(s) 4.30.22 p.m..png',
]

test('valid MIME types map to safe fixed extensions', () => {
  assert.deepEqual(
    ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].map(settlementAttachmentExtension),
    ['pdf', 'png', 'jpg', 'webp'],
  )
  assert.equal(settlementAttachmentExtension('image/svg+xml'), undefined)
})

test('deposit storage key does not include the original filename', () => {
  const keyTemplate = `${'company'}/fund-closures/${'closure'}/deposits/${'deposit'}/uuid.png`
  assert.match(keyTemplate, /^company\/fund-closures\/closure\/deposits\/deposit\/uuid\.png$/)
  for (const name of problematicNames) assert.equal(keyTemplate.includes(name), false)
  assert.match(action, /deposits\/\$\{depositId\}\/\$\{crypto\.randomUUID\(\)\}\.\$\{extension\}/)
  assert.doesNotMatch(action, /deposits\/\$\{depositId\}\/\$\{crypto\.randomUUID\(\)\}-\$\{file\.name\}/)
})

test('original filename remains metadata only and failed metadata removes uploaded object', () => {
  assert.match(action, /file_name: file\.name/)
  assert.match(action, /storage\.from\(SETTLEMENT_ATTACHMENT_BUCKET\)\.remove\(\[storagePath\]\)/)
})
