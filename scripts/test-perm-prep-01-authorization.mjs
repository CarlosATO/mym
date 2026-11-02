import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isOperatorMovementAllowed, getMovementRule } from '../src/modules/logistica/preparacion-pedidos/movement-rules.ts'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('PERM-PREP-01 contract: authorization.ts exports requirePreparationCardMoveAuthorization', async () => {
  const source = await read('src/app/actions/logistica/authorization.ts')
  assert.match(source, /export async function requirePreparationCardMoveAuthorization\(/)
  assert.match(source, /requireWmsPermission\('module\.logistica\.view'\)/)
  assert.match(source, /hasWmsPermission\(auth\.user\.id,\s*'logistica\.preparation\.manage'\)/)
  assert.match(source, /auth\.isOperatorBodega/)
  assert.match(source, /toStatus !== 'IN_PREPARATION'/)
  assert.match(source, /from\('sales_order_preparation_cards'\)/)
  assert.match(source, /eq\('company_id',\s*auth\.companyId\)/)
  assert.match(source, /card\.status !== 'PENDING_ROUTE_PREP'/)
  assert.match(source, /requirePreparationCardAccess\(auth,\s*cardId\)/)
})

test('PERM-PREP-01 contract: sales-order-preparation.ts invokes requirePreparationCardMoveAuthorization', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')
  assert.match(source, /import \{[^}]*requirePreparationCardMoveAuthorization[^}]*\} from '\.\/authorization'/)
  assert.match(source, /requirePreparationCardMoveAuthorization\(params\.cardId,\s*params\.toStatus/)
})

test('PERM-PREP-01/02 movement rules: isOperatorMovementAllowed permits operational flow', () => {
  // Casos autorizados
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'IN_PREPARATION'), true)
  assert.equal(isOperatorMovementAllowed('IN_PREPARATION', 'PENDING_ROUTE_PREP'), true)
  assert.equal(isOperatorMovementAllowed('IN_PREPARATION', 'IN_AUDIT'), true)

  // Casos rechazados: destinos no permitidos
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'IN_AUDIT'), false)
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'INCIDENTS'), false)
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'AUDITED'), false)
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'CANCELLED'), false)
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'INVOICED_READY_FOR_ROUTE'), false)

  // Casos rechazados: orígenes o transiciones no permitidas
  assert.equal(isOperatorMovementAllowed('IN_PREPARATION', 'IN_PREPARATION'), false)
  assert.equal(isOperatorMovementAllowed('IN_AUDIT', 'IN_PREPARATION'), false)
  assert.equal(isOperatorMovementAllowed('IN_AUDIT', 'PENDING_ROUTE_PREP'), false)
  assert.equal(isOperatorMovementAllowed('AUDITED', 'IN_PREPARATION'), false)
  assert.equal(isOperatorMovementAllowed('INCIDENTS', 'IN_PREPARATION'), false)
})

test('PERM-PREP-01 simulation: operator authorized exclusively for PENDING_ROUTE_PREP -> IN_PREPARATION', () => {
  // Función de evaluación de política que replica exactamente requirePreparationCardMoveAuthorization
  function evaluateMovePolicy({
    user,
    userActive,
    companyId,
    companyActive,
    hasModuleView,
    hasManagePermission,
    effectiveRole,
    card,
    toStatus,
  }) {
    if (!user) throw new Error('No autorizado')
    if (!userActive) throw new Error('El usuario no está activo')
    if (!companyId) throw new Error('No se ha seleccionado una empresa activa')
    if (!companyActive) throw new Error('La empresa activa no está disponible')
    if (!hasModuleView) throw new Error('No autorizado para el módulo WMS')

    const isOperatorBodega = effectiveRole === 'OPERADOR_BODEGA'

    if (hasManagePermission) {
      return { allowed: true, role: effectiveRole, isOperatorBodega }
    }

    if (!isOperatorBodega) {
      throw new Error('No autorizado para esta operación')
    }

    if (toStatus !== 'IN_PREPARATION') {
      throw new Error('No autorizado para mover a esta etapa.')
    }

    if (!card || card.company_id !== companyId) {
      throw new Error('Tarjeta no disponible')
    }

    if (card.status !== 'PENDING_ROUTE_PREP') {
      throw new Error('No autorizado para mover tarjetas fuera de Pendientes.')
    }

    return { allowed: true, role: effectiveRole, isOperatorBodega: true }
  }

  const validCompany = 'c1000000-0000-0000-0000-000000000001'
  const otherCompany = 'c2000000-0000-0000-0000-000000000002'
  const validUser = { id: 'u1000000-0000-0000-0000-000000000001' }

  // 1. Caso autorizado: OPERADOR_BODEGA, PENDING_ROUTE_PREP -> IN_PREPARATION
  const okResult = evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: validCompany, status: 'PENDING_ROUTE_PREP' },
    toStatus: 'IN_PREPARATION',
  })
  assert.equal(okResult.allowed, true)
  assert.equal(okResult.isOperatorBodega, true)

  // 2. Rechazo: destino no permitido (IN_AUDIT)
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: validCompany, status: 'PENDING_ROUTE_PREP' },
    toStatus: 'IN_AUDIT',
  }), /No autorizado para mover a esta etapa\./)

  // 3. Rechazo: destino no permitido (PENDING_ROUTE_PREP)
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: validCompany, status: 'PENDING_ROUTE_PREP' },
    toStatus: 'PENDING_ROUTE_PREP',
  }), /No autorizado para mover a esta etapa\./)

  // 4. Rechazo: origen no permitido (IN_PREPARATION -> IN_PREPARATION)
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: validCompany, status: 'IN_PREPARATION' },
    toStatus: 'IN_PREPARATION',
  }), /No autorizado para mover tarjetas fuera de Pendientes\./)

  // 5. Rechazo: origen no permitido (IN_AUDIT -> IN_PREPARATION)
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: validCompany, status: 'IN_AUDIT' },
    toStatus: 'IN_PREPARATION',
  }), /No autorizado para mover tarjetas fuera de Pendientes\./)

  // 6. Rechazo: tarjeta inexistente
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: null,
    toStatus: 'IN_PREPARATION',
  }), /Tarjeta no disponible/)

  // 7. Rechazo: tarjeta de otra empresa (aislamiento multi-tenant)
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: otherCompany, status: 'PENDING_ROUTE_PREP' },
    toStatus: 'IN_PREPARATION',
  }), /Tarjeta no disponible/)

  // 8. Rechazo: usuario inactivo
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: false,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: validCompany, status: 'PENDING_ROUTE_PREP' },
    toStatus: 'IN_PREPARATION',
  }), /El usuario no está activo/)

  // 9. Rechazo: no autenticado
  assert.throws(() => evaluateMovePolicy({
    user: null,
    userActive: false,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { id: 'card-1', company_id: validCompany, status: 'PENDING_ROUTE_PREP' },
    toStatus: 'IN_PREPARATION',
  }), /No autorizado/)

  // 10. Rechazo: rol sin manage y distinto de OPERADOR_BODEGA (ej. CHOFER)
  assert.throws(() => evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'CHOFER',
    card: { id: 'card-1', company_id: validCompany, status: 'PENDING_ROUTE_PREP' },
    toStatus: 'IN_PREPARATION',
  }), /No autorizado para esta operación/)

  // 11. Autorizado para rol supervisor/admin con manage permission
  const adminResult = evaluateMovePolicy({
    user: validUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: true,
    effectiveRole: 'SUPERVISOR_VENTAS',
    card: { id: 'card-1', company_id: validCompany, status: 'IN_PREPARATION' },
    toStatus: 'IN_AUDIT',
  })
  assert.equal(adminResult.allowed, true)
  assert.equal(adminResult.isOperatorBodega, false)
})

test('PERM-PREP-01 security: OPERADOR_BODEGA does NOT receive global logistica.preparation.manage', async () => {
  const authSource = await read('src/app/actions/logistica/authorization.ts')
  const layoutSource = await read('src/app/dashboard/logistica/layout.tsx')

  // El rol OPERADOR_BODEGA no está mapeado a manage
  assert.doesNotMatch(authSource, /OPERADOR_BODEGA.*logistica\.preparation\.manage/)
  assert.doesNotMatch(layoutSource, /logistica\.preparation\.manage.*OPERADOR_BODEGA/)
})

test('PERM-PREP-01 security: invoice emission remains strictly blocked for OPERADOR_BODEGA', async () => {
  const invoiceSource = await read('src/app/actions/logistica/sales-order-invoice-attempts.ts')

  // Bloqueo estricto en emisión
  assert.match(invoiceSource, /if \(auth\.isOperatorBodega\) return \{ status: 'PREVALIDATION_FAILED' as const, error: 'No autorizado para facturación\.' \}/)
  // Bloqueo estricto en prevalidación y preparación de intento
  assert.match(invoiceSource, /export async function prevalidateSalesOrderInvoiceAttempt[\s\S]*if \(auth\.isOperatorBodega\) throw new Error\('No autorizado para facturación'\)/)
  assert.match(invoiceSource, /export async function reconcileSalesOrderInvoiceAttempt[\s\S]*if \(auth\.isOperatorBodega\) throw new Error\('No autorizado para facturación'\)/)
})
