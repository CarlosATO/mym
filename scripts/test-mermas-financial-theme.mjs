import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const root = process.cwd()
const wmsShell = join(root, 'src/app/dashboard/logistica/wms-shell.tsx')
const mermasDir = join(root, 'src/modules/logistica/mermas')

test('WMS and Mermas use the financial shell while retaining Mermas identity', async () => {
  const source = await readFile(wmsShell, 'utf8')
  assert.match(source, /identity=\{isMermasContext \? \{ id: 'mermas'/)
  assert.match(source, /surfaceMode="none"/)
  assert.match(source, /sidebarVariant="financial"/)
  assert.match(source, /themeVariant="financial"/)
})

test('Mermas has no legacy blue or cyan utility colors', async () => {
  const files = (await readdir(mermasDir)).filter(file => file.endsWith('.tsx'))
  const legacyColor = /(?:bg|text|border)-(?:blue|sky|cyan)-/g
  const matches = []
  for (const file of files) {
    const source = await readFile(join(mermasDir, file), 'utf8')
    if (legacyColor.test(source)) matches.push(file)
    legacyColor.lastIndex = 0
  }
  assert.deepEqual(matches, [])
})
