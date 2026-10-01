import assert from 'node:assert/strict'
import test from 'node:test'
import {
  blocksRegularizationSubmit,
  regularizationOutcomeMessage,
  resolveStockExitSubmitMode,
} from '../src/modules/logistica/mermas/mermas-stock-exit-submit.ts'

test('destruction remains on the legacy exit path and regularization uses Bsale', () => {
  assert.equal(resolveStockExitSubmitMode('SALIDA_DESTRUCCION'), 'LEGACY_DESTRUCTION')
  assert.equal(resolveStockExitSubmitMode('SALIDA_REGULACION'), 'BSALE_REGULARIZATION')
})

test('regularization outcomes block duplicate submission with exact messages', () => {
  for (const status of ['SENDING', 'RECONCILIATION_REQUIRED']) {
    assert.equal(blocksRegularizationSubmit(status), true)
    assert.match(regularizationOutcomeMessage(status), /operación|recepción/)
  }
  assert.equal(blocksRegularizationSubmit('LOCAL_APPLICATION_PENDING'), false)
  assert.equal(blocksRegularizationSubmit(null), false)
})
