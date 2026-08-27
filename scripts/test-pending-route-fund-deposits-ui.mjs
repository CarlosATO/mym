import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const navigation = await readFile(new URL('../src/modules/adquisiciones/lib/navigation.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/adquisiciones/rendicion-rutas/route-settlements-panel.tsx', import.meta.url), 'utf8')
const workspace = await readFile(new URL('../src/modules/adquisiciones/rendicion-rutas/components/pending-fund-deposits-workspace.tsx', import.meta.url), 'utf8')
const dialog = await readFile(new URL('../src/modules/adquisiciones/rendicion-rutas/components/register-fund-closure-deposit-dialog.tsx', import.meta.url), 'utf8')

test('Depósitos tiene acceso directo y sincronización con la URL', () => {
  assert.match(navigation, /label: 'Depósitos'/)
  assert.match(navigation, /query: \{ tab: 'deposits' \}/)
  assert.match(panel, /tab === 'deposits'/)
  assert.match(panel, /DEPOSITS: 'deposits'/)
  assert.match(panel, /setMainTab\('DEPOSITS'\)/)
})

test('la bandeja consume el read-model y abre el formulario único', () => {
  assert.match(workspace, /getPendingRouteFundDeposits/)
  assert.match(workspace, /cash_pending/)
  assert.match(workspace, /checks_pending_count/)
  assert.match(workspace, /total_pending/)
  assert.match(workspace, /Crear depósito/)
  assert.match(workspace, /RegisterFundClosureDepositDialog/)
  assert.match(workspace, /availableChecks=\{selectedRow\.available_checks\}/)
  assert.match(workspace, /No hay fondos pendientes de depósito\./)
})

test('el diálogo reutilizable propone efectivo y cheques disponibles', () => {
  assert.match(dialog, /useState\(\(\) => String\(initialCash\)\)/)
  assert.match(dialog, /new Set\(availableChecks\.map\(check => check\.payment_id\)\)/)
  assert.match(dialog, /checkPaymentIds: \[\.\.\.selectedCheckIds\]/)
  assert.match(dialog, /cashAmount \+ selectedCheckTotal/)
  assert.match(dialog, /cashAmount > initialCash/)
})
