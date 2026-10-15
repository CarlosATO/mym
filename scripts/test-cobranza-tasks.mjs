import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCobranzaTasks, effectivePriority, prioritizeCobranzaColumn, taskUrgency, todayInChile } from '../src/modules/analisis-comercial/lib/cobranza-tasks.ts'

const client = (clientId, name, overdueAmount = 0) => ({
  key: String(clientId), clientId, name, code: null, totalAmount: overdueAmount, overdueAmount,
  pendingDocuments: 1, oldestExpirationDate: null, oldestDaysOverdue: 0, documents: [], priority: 'Normal',
})

const workflows = (rows) => Object.fromEntries(rows.map(([clientId, values]) => [clientId, { stage: 'IN_PROGRESS', ...values }]))

test('fecha futura no crea tarea y fechas civiles no se desplazan por UTC', () => {
  const clients = [client(1, 'Futuro')]
  assert.deepEqual(buildCobranzaTasks(clients, workflows([[1, { commitment_at: '2026-10-16T00:00:00Z' }]]), '2026-10-15'), [])
  assert.equal(todayInChile(new Date('2026-10-15T02:30:00Z')), '2026-10-14')
  assert.equal(todayInChile(new Date('2026-10-15T04:30:00Z')), '2026-10-15')
})

test('compromiso hoy y vencido generan urgencia correcta', () => {
  const clients = [client(1, 'Hoy'), client(2, 'Ayer')]
  const tasks = buildCobranzaTasks(clients, workflows([
    [1, { commitment_at: '2026-10-15T00:00:00Z' }],
    [2, { commitment_at: '2026-10-14T00:00:00Z' }],
  ]), '2026-10-15')
  assert.deepEqual(tasks.map(task => [task.clientId, task.urgency]), [[2, 'OVERDUE'], [1, 'TODAY']])
})

test('seguimiento hoy y vencido también se proyectan', () => {
  const tasks = buildCobranzaTasks([client(1, 'Hoy'), client(2, 'Vencido')], workflows([
    [1, { next_action_at: '2026-10-15' }], [2, { next_action_at: '2026-10-13' }],
  ]), '2026-10-15')
  assert.deepEqual(tasks.map(task => [task.type, task.urgency]), [['FOLLOW_UP', 'OVERDUE'], ['FOLLOW_UP', 'TODAY']])
})

test('CLOSED y clientes fuera de cartera activa no generan tarea', () => {
  const tasks = buildCobranzaTasks([client(1, 'Cerrado')], workflows([[1, { stage: 'CLOSED', commitment_at: '2026-10-15' }]]), '2026-10-15')
  assert.deepEqual(tasks, [])
  assert.deepEqual(buildCobranzaTasks([], workflows([[99, { commitment_at: '2026-10-15' }]]), '2026-10-15'), [])
})

test('vencidos ordenan por fecha antigua y amount null no se materializa', () => {
  const tasks = buildCobranzaTasks([client(1, 'Nuevo'), client(2, 'Antiguo')], workflows([
    [1, { commitment_at: '2026-10-14', commitment_amount: null }], [2, { commitment_at: '2026-10-10', commitment_amount: null }],
  ]), '2026-10-15')
  assert.deepEqual(tasks.map(task => task.clientId), [2, 1])
  assert.equal(tasks[0].amount, null)
})

test('priorización eleva tareas y conserva el orden comercial para el resto', () => {
  const clients = [client(1, 'Comercial primero', 900), client(2, 'Vencido'), client(3, 'Hoy'), client(4, 'Sin tarea')]
  const ordered = prioritizeCobranzaColumn(clients, workflows([
    [2, { commitment_at: '2026-10-14' }], [3, { next_action_at: '2026-10-15' }],
  ]), '2026-10-15')
  assert.deepEqual(ordered.map(value => value.clientId), [2, 3, 1, 4])
})

test('urgencia futura es NONE', () => assert.equal(taskUrgency('2026-10-16T00:00:00Z', '2026-10-15'), 'NONE'))

test('una tarea urgente eleva la prioridad visual a Alta sin tocar la comercial', () => {
  const [today] = buildCobranzaTasks([client(1, 'Hoy')], workflows([[1, { commitment_at: '2026-10-15' }]]), '2026-10-15')
  const [overdue] = buildCobranzaTasks([client(2, 'Vencido')], workflows([[2, { commitment_at: '2026-10-10' }]]), '2026-10-15')
  assert.equal(effectivePriority('Normal', today), 'Alta')
  assert.equal(effectivePriority('Media', overdue), 'Alta')
})

test('sin tarea vigente se conserva la prioridad comercial y una fecha futura no genera tarea', () => {
  assert.equal(effectivePriority('Normal', null), 'Normal')
  assert.equal(effectivePriority('Media', undefined), 'Media')
  const future = buildCobranzaTasks([client(3, 'Futuro')], workflows([[3, { commitment_at: '2026-10-20' }]]), '2026-10-15')
  assert.deepEqual(future, [])
})

test('generar tareas no altera la etapa vigente del workflow', () => {
  const source = workflows([[1, { stage: 'IN_PROGRESS', commitment_at: '2026-10-15' }]])
  const snapshot = JSON.parse(JSON.stringify(source))
  buildCobranzaTasks([client(1, 'Hoy')], source, '2026-10-15')
  prioritizeCobranzaColumn([client(1, 'Hoy')], source, '2026-10-15')
  assert.deepEqual(source, snapshot)
  assert.equal(source[1].stage, 'IN_PROGRESS')
})
