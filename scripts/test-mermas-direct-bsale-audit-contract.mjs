import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'

const migrationsDir = join(process.cwd(), 'supabase', 'migrations')
const directAction = 'MERMA_DIR_BSALE_REG'

test('direct Bsale regularization action fits audit_logs.action varchar(20)', () => {
  assert.ok(directAction.length <= 20)
})

test('all static MERMA audit actions fit audit_logs.action varchar(20)', async () => {
  const files = (await readdir(migrationsDir)).filter(file => file.includes('mermas') && file.endsWith('.sql'))
  const actions = new Set()
  const legacyOversizedActions = new Set(['MERMA_DIRECT_BSALE_REGULARIZED'])
  for (const file of files) {
    const sql = await readFile(join(migrationsDir, file), 'utf8')
    for (const match of sql.matchAll(/'((?:MERMA|MERMAS)_[A-Z0-9_]+)'/g)) actions.add(match[1])
  }
  assert.ok(actions.has(directAction))
  assert.deepEqual(
    [...actions].filter(action => action.length > 20),
    [...legacyOversizedActions],
    'Only the superseded direct Bsale action may remain in historical migrations',
  )

  const currentMigration = await readFile(
    join(migrationsDir, '20261002130000_mermas_direct_bsale_audit_action_contract.sql'),
    'utf8',
  )
  assert.doesNotMatch(currentMigration, /'((?:MERMA|MERMAS)_[A-Z0-9_]{20,})'/)
})
