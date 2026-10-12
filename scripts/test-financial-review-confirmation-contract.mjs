import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const auditMigration = await readFile(new URL('../supabase/migrations/20261010170000_expand_audit_log_action_length.sql', import.meta.url), 'utf8')
const reviewMigration = await readFile(new URL('../supabase/migrations/20261003210000_financial_daily_review_control.sql', import.meta.url), 'utf8')
const cashFlow = await readFile(new URL('../src/modules/analisis-comercial/control-financiero/components/cash-flow-client.tsx', import.meta.url), 'utf8')

test('audit action length supports confirmation without truncation', () => {
  assert.match(auditMigration, /ALTER TABLE portal\.audit_logs/i)
  assert.match(auditMigration, /ALTER COLUMN action TYPE varchar\(64\)/i)
  assert.doesNotMatch(auditMigration, /varchar\(20\)/i)
  assert.match(reviewMigration, /CONFIRM_CLASSIFICATION/)
  assert.match(reviewMigration, /review_status = 'REVIEWED'/)
  assert.match(reviewMigration, /reviewed_by = p_actor_user_id/)
  assert.match(reviewMigration, /reviewed_at = now\(\)/)
  assert.match(reviewMigration, /action, old_data, new_data/)
})

test('bulk classification does not share the audit action failure', () => {
  const bulkSection = reviewMigration.slice(reviewMigration.indexOf('create or replace function comercial.classify_financial_bank_movements'))
  assert.doesNotMatch(bulkSection, /portal\.audit_logs/)
  assert.match(cashFlow, /saveMovement\(true\)/)
})

test('pending movements are visually marked from the single review_status source', () => {
  assert.match(cashFlow, /row\.review_status === "PENDING"/)
  assert.match(cashFlow, /border-l-4 border-l-\[#A23E48\]/)
  assert.match(cashFlow, /Clasificación pendiente de confirmación/)
  assert.match(cashFlow, /Pendiente/)
  assert.match(cashFlow, /value=\{classificationFilter\}/)
  assert.match(cashFlow, /<option value="PENDING">Pendientes<\/option>/)
  assert.match(cashFlow, /updateFinancialMovementCategoryAction/)
})
