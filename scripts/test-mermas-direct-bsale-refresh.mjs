import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const panelPath = 'src/modules/logistica/mermas/mermas-panel.tsx'

test('direct Bsale success invalidates and refreshes requests and warehouse', async () => {
  const source = await readFile(panelPath, 'utf8')
  const onCreated = source.slice(source.indexOf('onCreated={(requestCode) =>'), source.indexOf('\n            }}', source.indexOf('onCreated={(requestCode) =>')))

  assert.match(onCreated, /setIncidentsOpen\(false\)/)
  assert.match(onCreated, /setMessage\(`/)
  assert.match(onCreated, /await invalidateMermaMovementViews\(\)/)
  assert.match(onCreated, /await Promise\.all\(\[/)
  assert.match(onCreated, /ensureRequestsLoaded\(search, true\)/)
  assert.match(onCreated, /bootstrap\.canViewWarehouse \? ensureWarehouseLoaded\(true\)/)
  assert.doesNotMatch(onCreated, /setTimeout|window\.location\.reload|router\.refresh/)
})
