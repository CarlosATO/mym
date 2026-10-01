import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMermaSubmitOutcome } from '../src/modules/logistica/mermas/merma-submit-outcome.ts'

const persisted = { requestPersisted: true, requestId: 'request-1', requestCode: 'MER-0001', operationId: 'operation-1' }

test('finalized navigates to the merma list without cleanup', () => {
  assert.deepEqual(resolveMermaSubmitOutcome({ ...persisted, outcome: 'FINALIZED', consumptionId: 10 }), {
    cleanupEvidence: false,
    destination: '/dashboard/logistica/mermas',
  })
})

test('not created permits cleanup and stays in the form', () => {
  assert.deepEqual(resolveMermaSubmitOutcome({ outcome: 'NOT_CREATED', requestPersisted: false, error: 'invalid evidence' }), {
    cleanupEvidence: true,
    message: 'invalid evidence',
  })
})

test('all persisted non-final outcomes navigate to detail without cleanup', () => {
  const cases = [
    ['BSALE_FAILED', 'La solicitud MER-0001 fue creada, pero Bsale rechazó el movimiento de Merma.'],
    ['RECONCILIATION_REQUIRED', 'La solicitud MER-0001 fue creada. El movimiento en Bsale requiere revisión antes de continuar.'],
    ['SENDING', 'La solicitud MER-0001 fue creada. El movimiento en Bsale sigue en proceso y quedó pendiente de revisión.'],
    ['LOCAL_APPLICATION_PENDING', 'La Merma fue creada en Bsale, pero PetGroup no pudo completar el ingreso local. La solicitud quedó pendiente de regularización.'],
  ]
  for (const [outcome, message] of cases) {
    const result = resolveMermaSubmitOutcome({
      ...persisted,
      outcome,
      ...(outcome === 'BSALE_FAILED' || outcome === 'RECONCILIATION_REQUIRED' ? { error: 'technical detail' } : {}),
      ...(outcome === 'LOCAL_APPLICATION_PENDING' ? { consumptionId: 10, error: 'technical detail' } : {}),
    })
    assert.equal(result.cleanupEvidence, false)
    assert.equal(result.destination, '/dashboard/logistica/mermas/request-1')
    assert.equal(result.message, message)
  }
})
