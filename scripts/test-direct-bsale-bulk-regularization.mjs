import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  applyBulkExpiration,
  applyBulkObservation,
  applyBulkReason,
  getIncompleteLineCount,
  validateDirectBsaleReview,
} from '../src/lib/integraciones/direct-bsale-regularization-core.ts'

const migration = await readFile(new URL('../supabase/migrations/20261001180000_mermas_direct_bsale_bulk_regularization.sql', import.meta.url), 'utf8')
const action = await readFile(new URL('../src/app/actions/logistica/mermas.ts', import.meta.url), 'utf8')
const dialog = await readFile(new URL('../src/modules/logistica/mermas/direct-bsale-incidents-dialog.tsx', import.meta.url), 'utf8')
const normalForm = await readFile(new URL('../src/modules/logistica/mermas/new-merma-form-with-evidence.tsx', import.meta.url), 'utf8')

function lines(count = 10) {
  return Array.from({ length: count }, (_, index) => ({
    detail_id: index + 1,
    variant_id: index + 100,
    quantity: 1,
    reason: 'Regularización consumo directo Bsale',
    expiration_date: '2027-12-31',
  }))
}

test('DIRECTO_BSALE accepts ten lines without photographs when reviewed', () => {
  assert.equal(validateDirectBsaleReview(lines(), true), null)
})

test('common values and one exception remain valid', () => {
  const reviewed = lines()
  reviewed[4].expiration_date = '2028-01-15'
  reviewed[6].reason = 'Daño de empaque'
  assert.equal(validateDirectBsaleReview(reviewed, true), null)
})

test('bulk controls preserve YYYY-MM-DD and allow an individual override', () => {
  const initial = lines(8).map((line) => ({ ...line, observation: '' }))
  const withReason = applyBulkReason(initial, 'Vencido')
  const withExpiration = applyBulkExpiration(withReason, '2026-11-29')
  assert.ok(withExpiration)
  const withObservation = applyBulkObservation(withExpiration, 'Regularización histórica')
  assert.equal(getIncompleteLineCount(withObservation), 0)
  const overridden = withObservation.map((line, index) => index === 3 ? { ...line, expiration_date: '2027-01-15' } : line)
  assert.equal(overridden[3].expiration_date, '2027-01-15')
  assert.equal(overridden.every((line) => /^\d{4}-\d{2}-\d{2}$/.test(line.expiration_date)), true)
  assert.equal(applyBulkExpiration(overridden, '29/11/2026'), null)
})

test('difference, missing line, duplicate line, and unchecked review are blocked', () => {
  const different = lines()
  different[0].has_difference = true
  assert.match(validateDirectBsaleReview(different, true), /diferencia/)
  assert.match(validateDirectBsaleReview(lines().slice(0, 9), true, lines().map((line) => line.detail_id)), /coinciden exactamente/)
  const duplicate = lines()
  duplicate[1].detail_id = duplicate[0].detail_id
  assert.match(validateDirectBsaleReview(duplicate, true), /una sola vez/)
  assert.match(validateDirectBsaleReview(lines(), false), /Confirma/)
})

test('the atomic RPC keeps the direct exception isolated from normal evidence rules', () => {
  assert.match(migration, /CREATE OR REPLACE FUNCTION mermas\.regularize_and_authorize_bsale_incident/)
  assert.match(migration, /p_confirmed_review boolean/)
  assert.match(migration, /consumption_type_id <> 2/)
  assert.match(migration, /FOR UPDATE/)
  assert.match(migration, /DIRECTO_BSALE_BULK/)
  assert.match(migration, /MERMA_DIRECT_BSALE_REGULARIZED/)
  assert.match(migration, /evidence_required.*false/s)
  assert.match(migration, /authorization_status, authorized_by, authorized_at/s)
  assert.match(migration, /request_id = v_request_id, match_method = 'DIRECTO_BSALE_BULK'/)
  assert.match(action, /requireWmsPermission\("logistica\.mermas\.authorize"\)/)
  assert.match(action, /regularize_and_authorize_bsale_incident/)
  assert.match(dialog, /Sin evidencia disponible/)
  assert.match(dialog, /REGULARIZAR E INGRESAR A BODEGA/)
  assert.match(dialog, /Marcar diferencia/)
  assert.match(dialog, /Vencimiento aplicado a/)
  assert.match(dialog, /Faltan vencimientos en/)
  assert.match(dialog, /<tr className=\"bg-theme-accent\/5\"/)
  assert.match(normalForm, /Debes adjuntar al menos una fotografía/)
})

test('the direct action does not weaken existing normal evidence action', () => {
  assert.match(action, /prepareMermaIncidentEvidenceUploads[\s\S]*Cada línea requiere al menos una fotografía/)
  assert.match(action, /regularizeMermaBsaleIncident[\s\S]*regularize_bsale_incident/)
})
