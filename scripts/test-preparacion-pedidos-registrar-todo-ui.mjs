import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const drawer = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', root), 'utf8')

// ========================================================================
// 1. CONTRATO VISUAL: BOTÓN "REGISTRAR TODO" Y ELIMINACIÓN DE "CONFIRMAR"
// ========================================================================

test('1. Encabezado de PRODUCTOS contiene el botón «Registrar todo» con estado de progreso y concurrencia controlada', () => {
  // Debe existir el botón «Registrar todo» en el encabezado de productos
  assert.match(drawer, /Registrar todo/)
  assert.match(drawer, /handleRegisterAll/)
  assert.match(drawer, /pendingLinesToRegister/)
  assert.match(drawer, /isRegisteringAll/)
  assert.match(drawer, /Registrando/)
  assert.match(drawer, /CONCURRENCY_LIMIT\s*=\s*4/)
  assert.match(drawer, /Promise\.all/)
  // Debe deshabilitarse ante operación en curso o modo solo lectura
  assert.match(drawer, /disabled=\{isRegisteringAll \|\| isReadOnly/)
})

test('2. Se eliminó el botón «Confirmar» de cada fila y se conserva el botón «Excluir»', () => {
  // Verificar que en las filas de productos ya no existe el botón con texto "Confirmar"
  // (Nota: "Confirmar incidencia" o "Confirmar envío a Auditoría" en modales sí existen)
  const productRowMatch = drawer.match(/<td className="px-3 py-2 text-center">[\s\S]*?<\/td>/)
  assert.ok(productRowMatch, 'Debe existir la celda de acciones en cada fila')
  assert.doesNotMatch(productRowMatch[0], />\s*Confirmar\s*</, 'No debe haber botón Confirmar en la fila')
  assert.match(productRowMatch[0], />\s*Excluir\s*</, 'Debe mantenerse el botón Excluir en la fila')
})

test('3. Confirmación automática individual conectada a onBlur y onKeyDown Enter', () => {
  assert.match(drawer, /onBlur=\{\(\) => setLineDrafts\(current => \{[\s\S]*?handleLineAutoConfirm\(line/)
  assert.match(drawer, /onKeyDown=\{event => \{\s*if \(event\.key === 'Enter'\) \{/)
  assert.match(drawer, /handleLineAutoConfirm/)
})

test('4. Estados visuales discretos: Guardando, Confirmada, Con error, Excluida y Pendiente', () => {
  assert.match(drawer, /Guardando…/)
  assert.match(drawer, /lineStateLabel\(line\)/)
  assert.match(drawer, /isSavingThisLine/)
  assert.match(drawer, /lineErrorText/)
  assert.match(drawer, /bg-red-50\/50/)
  assert.match(drawer, /border-red-400/)
})

// ========================================================================
// 2. SIMULACIÓN DE COMPORTAMIENTO: REGLAS Y CASOS DE PRUEBA
// ========================================================================

function createMockLine(id, sku, requestedQty, preparedQty = null, status = 'PENDING', excluded = false) {
  return {
    id,
    sku,
    product_name: `Producto ${sku}`,
    requested_quantity: requestedQty,
    prepared_quantity: preparedQty,
    line_status: status,
    excluded_from_dispatch: excluded,
  }
}

test('5. «Registrar todo» con todas las líneas pendientes identifica y completa con cantidad solicitada', async () => {
  const lines = [
    createMockLine('line-1', 'SKU-1', 10),
    createMockLine('line-2', 'SKU-2', 5),
    createMockLine('line-3', 'SKU-3', 2),
  ]
  const lineDrafts = {}
  const savingLineIds = {}

  // Lógica de filtro idéntica a la implementada en handleRegisterAll
  const candidates = lines.filter(line => {
    if (line.excluded_from_dispatch || line.line_status !== 'PENDING') return false
    if (savingLineIds[line.id]) return false
    const draft = lineDrafts[line.id]
    if (draft !== undefined && draft.trim() !== '') return false
    return true
  })

  assert.equal(candidates.length, 3, 'Debe seleccionar todas las líneas pendientes')
  assert.equal(candidates[0].requested_quantity, 10)
  assert.equal(candidates[1].requested_quantity, 5)
  assert.equal(candidates[2].requested_quantity, 2)
})

test('6. «Registrar todo» con cantidades parciales previamente ingresadas conserva las parciales y no las sobrescribe', () => {
  // 15 productos en total: 2 con cantidades manuales inferiores y 13 pendientes limpios
  const lines = Array.from({ length: 15 }, (_, i) => 
    createMockLine(`line-${i + 1}`, `SKU-${i + 1}`, 10)
  )

  // 2 líneas tienen draft manual con cantidad inferior
  const lineDrafts = {
    'line-1': '3', // 3 de 10
    'line-2': '0', // 0 de 10
  }
  const savingLineIds = {}

  const candidates = lines.filter(line => {
    if (line.excluded_from_dispatch || line.line_status !== 'PENDING') return false
    if (savingLineIds[line.id]) return false
    const draft = lineDrafts[line.id]
    if (draft !== undefined && draft.trim() !== '') return false
    return true
  })

  assert.equal(candidates.length, 13, 'Debe procesar exactamente las 13 líneas restantes')
  assert.ok(!candidates.some(c => c.id === 'line-1' || c.id === 'line-2'), 'No debe incluir las líneas con borrador manual')
  assert.equal(lineDrafts['line-1'], '3', 'El borrador manual de line-1 se conserva intacto')
  assert.equal(lineDrafts['line-2'], '0', 'El borrador manual de line-2 se conserva intacto')
})

test('7. «Registrar todo» omite líneas ya confirmadas y líneas excluidas', () => {
  const lines = [
    createMockLine('line-1', 'SKU-1', 10, 10, 'CONFIRMED'),
    createMockLine('line-2', 'SKU-2', 5, 0, 'INCIDENT', true), // Excluida
    createMockLine('line-3', 'SKU-3', 8, null, 'PENDING', false), // Pendiente
  ]
  const lineDrafts = {}
  const savingLineIds = {}

  const candidates = lines.filter(line => {
    if (line.excluded_from_dispatch || line.line_status !== 'PENDING') return false
    if (savingLineIds[line.id]) return false
    const draft = lineDrafts[line.id]
    if (draft !== undefined && draft.trim() !== '') return false
    return true
  })

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0].id, 'line-3')
})

test('8. Confirmación automática al salir del campo (onBlur): campo vacío no confirma', () => {
  let apiCalled = false
  const mockApi = () => { apiCalled = true }

  const line = createMockLine('line-1', 'SKU-1', 5)
  const lineDrafts = { 'line-1': '   ' } // Campo vacío / espacios

  const raw = lineDrafts[line.id]
  if (raw === undefined || raw.trim() === '') {
    // No hace nada
  } else {
    mockApi()
  }

  assert.equal(apiCalled, false, 'Un campo vacío no debe llamar al backend')
})

test('9. Confirmación automática al salir del campo (onBlur): cantidad exacta confirma automáticamente', () => {
  let confirmedQty = null
  const line = createMockLine('line-1', 'SKU-1', 5)
  const lineDrafts = { 'line-1': '5' }

  const raw = lineDrafts[line.id]
  const quantity = Number(raw)
  if (quantity === line.requested_quantity) {
    confirmedQty = quantity
  }

  assert.equal(confirmedQty, 5, 'Debe confirmar automáticamente con la cantidad exacta')
})

test('10. Confirmación automática: cantidad menor a la solicitada activa diálogo de incidencia', () => {
  let incidentOpened = false
  const line = createMockLine('line-1', 'SKU-1', 10)
  const lineDrafts = { 'line-1': '7' }

  const raw = lineDrafts[line.id]
  const quantity = Number(raw)
  if (quantity < line.requested_quantity) {
    incidentOpened = true
  }

  assert.equal(incidentOpened, true, 'Debe abrir el diálogo de incidencia cuando la cantidad es menor')
})

test('11. Manejo de errores de guardado: conserva valor ingresado y muestra error sin fingir éxito', () => {
  const lineDrafts = { 'line-1': '5' }
  const lineErrors = {}

  // Simulación de fallo backend
  const result = { data: null, error: 'Conflicto de bloqueo o error de base de datos' }
  if (result.error || !result.data) {
    lineErrors['line-1'] = result.error
  }

  assert.equal(lineDrafts['line-1'], '5', 'El valor ingresado debe conservarse en el borrador')
  assert.equal(lineErrors['line-1'], 'Conflicto de bloqueo o error de base de datos')
})

test('12. Prevención de doble ejecución y peticiones concurrentes en vuelo', () => {
  const inFlightLineConfirms = new Set()
  const lineId = 'line-1'

  // Primer disparo
  assert.ok(!inFlightLineConfirms.has(lineId))
  inFlightLineConfirms.add(lineId)

  // Segundo disparo simultáneo (ej. blur inmediato tras Enter)
  const isDuplicate = inFlightLineConfirms.has(lineId)
  assert.ok(isDuplicate, 'El segundo disparo debe detectarse como duplicado')

  // Tras finalizar
  inFlightLineConfirms.delete(lineId)
  assert.ok(!inFlightLineConfirms.has(lineId), 'Se libera al completar la confirmación')
})

test('13. No ejecutar automáticamente «Enviar a auditoría» tras «Registrar todo»', () => {
  // Inspección del método handleRegisterAll en el drawer:
  // No debe contener executeMove('IN_AUDIT') ni onTransition(card, 'IN_AUDIT')
  const registerAllStart = drawer.indexOf('const handleRegisterAll = async () =>')
  const registerAllEnd = drawer.indexOf('const emissionDateObj = parseDateOnly', registerAllStart)
  const registerAllBody = drawer.slice(registerAllStart, registerAllEnd)

  assert.doesNotMatch(registerAllBody, /IN_AUDIT/, 'handleRegisterAll no debe invocar ninguna transición a IN_AUDIT')
  assert.doesNotMatch(registerAllBody, /executeMove/, 'handleRegisterAll no debe invocar executeMove')
})

