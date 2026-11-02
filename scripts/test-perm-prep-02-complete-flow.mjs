import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { isOperatorMovementAllowed, getMovementRule } from '../src/modules/logistica/preparacion-pedidos/movement-rules.ts'

const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')

test('PERM-PREP-02 contract: authorization.ts exports requirePreparationLineConfirmationAuthorization and requirePreparationCardMoveAuthorization', async () => {
  const source = await read('src/app/actions/logistica/authorization.ts')

  // Move authorization
  assert.match(source, /export async function requirePreparationCardMoveAuthorization\(/)
  assert.match(source, /toStatus !== 'IN_PREPARATION' && toStatus !== 'IN_AUDIT' && toStatus !== 'PENDING_ROUTE_PREP'/)
  assert.match(source, /card\.status !== 'PENDING_ROUTE_PREP'/)
  assert.match(source, /toStatus === 'IN_AUDIT'/)
  assert.match(source, /toStatus === 'PENDING_ROUTE_PREP'/)
  assert.match(source, /card\.status !== 'IN_PREPARATION'/)
  assert.match(source, /card\.locked_by_user_id !== auth\.user\.id/)
  assert.match(source, /!observation \|\| !observation\.trim\(\)/)

  // Line confirmation authorization
  assert.match(source, /export async function requirePreparationLineConfirmationAuthorization\(/)
  assert.match(source, /requireWmsPermission\('module\.logistica\.view'\)/)
  assert.match(source, /hasWmsPermission\(auth\.user\.id,\s*'logistica\.preparation\.manage'\)/)
  assert.match(source, /if \(!auth\.isOperatorBodega\)/)
  assert.match(source, /from\('sales_order_preparation_lines'\)/)
  assert.match(source, /from\('sales_order_preparation_cards'\)/)
  assert.match(source, /card\.status !== 'IN_PREPARATION'/)
  assert.match(source, /card\.locked_by_user_id !== auth\.user\.id/)
  assert.match(source, /requirePreparationCardAccess\(auth,\s*card\.id\)/)
})

test('PERM-PREP-02 contract: sales-order-preparation.ts delegates line confirmation and card movement to authorization helpers', async () => {
  const source = await read('src/app/actions/logistica/sales-order-preparation.ts')

  // Imports
  assert.match(source, /requirePreparationLineConfirmationAuthorization/)
  assert.match(source, /requirePreparationCardMoveAuthorization/)

  // confirmSalesOrderPreparationLine usage
  assert.match(source, /export async function confirmSalesOrderPreparationLine\(/)
  assert.match(source, /auth = await requirePreparationLineConfirmationAuthorization\(params\.lineId,\s*params\.companyId\)/)
  assert.match(source, /supabase\.schema\('logistica'\)\.rpc\('confirm_sales_order_preparation_line'/)

  // moveSalesOrderPreparationCard usage
  assert.match(source, /export async function moveSalesOrderPreparationCard\(/)
  assert.match(source, /auth = await requirePreparationCardMoveAuthorization\(params\.cardId,\s*params\.toStatus,\s*params\.observation\)/)
  assert.match(source, /params\.toStatus === 'PENDING_ROUTE_PREP' && \(!params\.observation \|\| !params\.observation\.trim\(\)\)/)
})

test('PERM-PREP-02 movement rules: isOperatorMovementAllowed permits operational flow and return to Pendientes', () => {
  // Transiciones autorizadas para operador
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'IN_PREPARATION'), true)
  assert.equal(isOperatorMovementAllowed('IN_PREPARATION', 'PENDING_ROUTE_PREP'), true)
  assert.equal(isOperatorMovementAllowed('IN_PREPARATION', 'IN_AUDIT'), true)

  // Rechazadas: etapas no autorizadas o transiciones desde otros estados
  assert.equal(isOperatorMovementAllowed('IN_AUDIT', 'IN_PREPARATION'), false)
  assert.equal(isOperatorMovementAllowed('IN_AUDIT', 'PENDING_ROUTE_PREP'), false)
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'IN_AUDIT'), false)
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'INCIDENTS'), false)
  assert.equal(isOperatorMovementAllowed('PENDING_ROUTE_PREP', 'AUDITED'), false)
  assert.equal(isOperatorMovementAllowed('IN_PREPARATION', 'AUDITED'), false)
  assert.equal(isOperatorMovementAllowed('IN_PREPARATION', 'INCIDENTS'), false)
  assert.equal(isOperatorMovementAllowed('AUDITED', 'IN_PREPARATION'), false)
  assert.equal(isOperatorMovementAllowed('INCIDENTS', 'IN_PREPARATION'), false)
})

test('PERM-PREP-02 simulation: line confirmation authorization policy', () => {
  function evaluateLineConfirmationPolicy({
    user,
    userActive,
    companyId,
    requestCompanyId,
    companyActive,
    hasModuleView,
    hasManagePermission,
    effectiveRole,
    line,
    card,
  }) {
    if (!user) throw new Error('No autorizado')
    if (!userActive) throw new Error('El usuario no está activo')
    if (!companyId) throw new Error('No se ha seleccionado una empresa activa')
    if (!companyActive) throw new Error('La empresa activa no está disponible')
    if (!hasModuleView) throw new Error('No autorizado para el módulo WMS')

    if (requestCompanyId && requestCompanyId !== companyId) {
      throw new Error('Empresa no autorizada')
    }

    const isOperatorBodega = effectiveRole === 'OPERADOR_BODEGA'

    if (hasManagePermission) {
      return { allowed: true, role: effectiveRole, isOperatorBodega }
    }

    if (!isOperatorBodega) {
      throw new Error('No autorizado para esta operación')
    }

    if (!line || line.company_id !== companyId) {
      throw new Error('Línea no disponible')
    }

    if (!card || card.company_id !== companyId || card.id !== line.card_id) {
      throw new Error('Tarjeta no disponible')
    }

    if (card.status !== 'IN_PREPARATION') {
      throw new Error('La tarjeta debe estar En preparación.')
    }

    if (!card.locked_by_user_id) {
      throw new Error('Esta preparación aún no tiene responsable. Tómala antes de continuar.')
    }

    if (card.locked_by_user_id !== user.id) {
      throw new Error('Esta preparación está asignada a otro usuario.')
    }

    return { allowed: true, role: effectiveRole, isOperatorBodega: true }
  }

  const validCompany = 'c1000000-0000-0000-0000-000000000001'
  const otherCompany = 'c2000000-0000-0000-0000-000000000002'
  const ownerUser = { id: 'u1000000-0000-0000-0000-000000000001' }
  const otherUser = { id: 'u2000000-0000-0000-0000-000000000002' }

  const cardInPrep = {
    id: 'card-1',
    company_id: validCompany,
    status: 'IN_PREPARATION',
    locked_by_user_id: ownerUser.id,
  }
  const line1 = {
    id: 'line-1',
    card_id: 'card-1',
    company_id: validCompany,
  }

  // 1. Operador propietario confirma línea: AUTORIZADO
  const ownerResult = evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: cardInPrep,
  })
  assert.equal(ownerResult.allowed, true)
  assert.equal(ownerResult.isOperatorBodega, true)

  // 2. Operador no propietario: RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: otherUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: cardInPrep,
  }), /Esta preparación está asignada a otro usuario\./)

  // 3. Tarjeta sin responsable asignado: RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: { ...cardInPrep, locked_by_user_id: null },
  }), /Esta preparación aún no tiene responsable\. Tómala antes de continuar\./)

  // 4. Tarjeta fuera de IN_PREPARATION (ej. PENDING_ROUTE_PREP): RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: { ...cardInPrep, status: 'PENDING_ROUTE_PREP' },
  }), /La tarjeta debe estar En preparación\./)

  // 5. Tarjeta en IN_AUDIT: RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: { ...cardInPrep, status: 'IN_AUDIT' },
  }), /La tarjeta debe estar En preparación\./)

  // 6. Empresa incorrecta en params: RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: otherCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: cardInPrep,
  }), /Empresa no autorizada/)

  // 7. Línea de otra empresa en base de datos: RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: { ...line1, company_id: otherCompany },
    card: cardInPrep,
  }), /Línea no disponible/)

  // 8. Usuario inactivo: RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: false,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: cardInPrep,
  }), /El usuario no está activo/)

  // 9. Usuario no autenticado: RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: null,
    userActive: false,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    line: line1,
    card: cardInPrep,
  }), /No autorizado/)

  // 10. Rol sin manage y distinto de OPERADOR_BODEGA (ej. CHOFER): RECHAZADO
  assert.throws(() => evaluateLineConfirmationPolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'CHOFER',
    line: line1,
    card: cardInPrep,
  }), /No autorizado para esta operación/)

  // 11. Usuario administrativo con manage: AUTORIZADO
  const adminResult = evaluateLineConfirmationPolicy({
    user: otherUser,
    userActive: true,
    companyId: validCompany,
    requestCompanyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: true,
    effectiveRole: 'SUPERVISOR_VENTAS',
    line: line1,
    card: cardInPrep,
  })
  assert.equal(adminResult.allowed, true)
  assert.equal(adminResult.isOperatorBodega, false)
})

test('PERM-PREP-02 simulation: card movement authorization policy, return to Pendientes and pending lines validation', () => {
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
    observation,
    pendingLinesCount = 0,
  }) {
    if (!user) throw new Error('No autorizado')
    if (!userActive) throw new Error('El usuario no está activo')
    if (!companyId) throw new Error('No se ha seleccionado una empresa activa')
    if (!companyActive) throw new Error('La empresa activa no está disponible')
    if (!hasModuleView) throw new Error('No autorizado para el módulo WMS')

    const isOperatorBodega = effectiveRole === 'OPERADOR_BODEGA'

    if (hasManagePermission) {
      if (toStatus === 'IN_AUDIT' && pendingLinesCount > 0) {
        throw new Error(`Faltan ${pendingLinesCount} productos por confirmar.`)
      }
      if (toStatus === 'PENDING_ROUTE_PREP' && (!observation || !observation.trim())) {
        throw new Error('Se requiere observación para retroceder.')
      }
      return { allowed: true, role: effectiveRole, isOperatorBodega }
    }

    if (!isOperatorBodega) {
      throw new Error('No autorizado para esta operación')
    }

    if (toStatus !== 'IN_PREPARATION' && toStatus !== 'IN_AUDIT' && toStatus !== 'PENDING_ROUTE_PREP') {
      throw new Error('No autorizado para mover a esta etapa.')
    }

    if (!card || card.company_id !== companyId) {
      throw new Error('Tarjeta no disponible')
    }

    if (toStatus === 'IN_PREPARATION') {
      if (card.status !== 'PENDING_ROUTE_PREP') {
        throw new Error('No autorizado para mover tarjetas fuera de Pendientes.')
      }
    } else if (toStatus === 'IN_AUDIT') {
      if (card.status !== 'IN_PREPARATION') {
        throw new Error('No autorizado para mover tarjetas fuera de En preparación.')
      }
      if (!card.locked_by_user_id) {
        throw new Error('Esta preparación aún no tiene responsable. Tómala antes de moverla.')
      }
      if (card.locked_by_user_id !== user.id) {
        throw new Error('Esta preparación está asignada a otro usuario.')
      }
      if (pendingLinesCount > 0) {
        throw new Error(`Faltan ${pendingLinesCount} productos por confirmar.`)
      }
    } else if (toStatus === 'PENDING_ROUTE_PREP') {
      if (card.status !== 'IN_PREPARATION') {
        throw new Error('No autorizado para mover tarjetas fuera de En preparación.')
      }
      if (!card.locked_by_user_id) {
        throw new Error('Esta preparación aún no tiene responsable. Tómala antes de moverla.')
      }
      if (card.locked_by_user_id !== user.id) {
        throw new Error('Esta preparación está asignada a otro usuario.')
      }
      if (!observation || !observation.trim()) {
        throw new Error('Se requiere observación para retroceder.')
      }
    }

    return { allowed: true, role: effectiveRole, isOperatorBodega: true }
  }

  const validCompany = 'c1000000-0000-0000-0000-000000000001'
  const ownerUser = { id: 'u1000000-0000-0000-0000-000000000001' }
  const otherUser = { id: 'u2000000-0000-0000-0000-000000000002' }

  const cardInPrep = {
    id: 'card-1',
    company_id: validCompany,
    status: 'IN_PREPARATION',
    locked_by_user_id: ownerUser.id,
  }

  // 1. Operador propietario envía a auditoría con todas las líneas completas: AUTORIZADO
  const moveAuditResult = evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'IN_AUDIT',
    pendingLinesCount: 0,
  })
  assert.equal(moveAuditResult.allowed, true)

  // 2. Operador propietario intenta enviar a auditoría con líneas pendientes: RECHAZADO por la RPC
  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'IN_AUDIT',
    pendingLinesCount: 2,
  }), /Faltan 2 productos por confirmar\./)

  // 3. Operador no propietario intenta enviar a auditoría: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: otherUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'IN_AUDIT',
    pendingLinesCount: 0,
  }), /Esta preparación está asignada a otro usuario\./)

  // 4. Operador intenta enviar a auditoría tarjeta sin responsable: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { ...cardInPrep, locked_by_user_id: null },
    toStatus: 'IN_AUDIT',
    pendingLinesCount: 0,
  }), /Esta preparación aún no tiene responsable\. Tómala antes de moverla\./)

  // 5. Operador propietario devuelve IN_PREPARATION -> PENDING_ROUTE_PREP con observación: AUTORIZADO
  const returnResult = evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'PENDING_ROUTE_PREP',
    observation: 'Cliente solicitó postergar el despacho',
  })
  assert.equal(returnResult.allowed, true)

  // 6. Operador propietario intenta devolver sin observación: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'PENDING_ROUTE_PREP',
    observation: '',
  }), /Se requiere observación para retroceder\./)

  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'PENDING_ROUTE_PREP',
    observation: '   ',
  }), /Se requiere observación para retroceder\./)

  // 7. Operador no propietario intenta devolver a Pendientes: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: otherUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'PENDING_ROUTE_PREP',
    observation: 'Motivo válido',
  }), /Esta preparación está asignada a otro usuario\./)

  // 8. Operador intenta devolver tarjeta sin responsable: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { ...cardInPrep, locked_by_user_id: null },
    toStatus: 'PENDING_ROUTE_PREP',
    observation: 'Motivo válido',
  }), /Esta preparación aún no tiene responsable\. Tómala antes de moverla\./)

  // 9. Operador intenta devolver tarjeta que NO está en IN_PREPARATION: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { ...cardInPrep, status: 'IN_AUDIT' },
    toStatus: 'PENDING_ROUTE_PREP',
    observation: 'Motivo válido',
  }), /No autorizado para mover tarjetas fuera de En preparación\./)

  // 10. Operador intenta mover tarjeta en IN_AUDIT a cualquier estado: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: { ...cardInPrep, status: 'IN_AUDIT' },
    toStatus: 'IN_PREPARATION',
    pendingLinesCount: 0,
  }), /No autorizado para mover tarjetas fuera de Pendientes\./)

  // 11. Operador intenta mover a AUDITED o INCIDENTS: RECHAZADO
  assert.throws(() => evaluateMovePolicy({
    user: ownerUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: false,
    effectiveRole: 'OPERADOR_BODEGA',
    card: cardInPrep,
    toStatus: 'AUDITED',
  }), /No autorizado para mover a esta etapa\./)

  // 12. Usuario administrativo conserva capacidad de mover a IN_AUDIT y devolver a PENDING_ROUTE_PREP
  const adminResult = evaluateMovePolicy({
    user: otherUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: true,
    effectiveRole: 'SUPERVISOR_VENTAS',
    card: cardInPrep,
    toStatus: 'IN_AUDIT',
    pendingLinesCount: 0,
  })
  assert.equal(adminResult.allowed, true)

  const adminReturnResult = evaluateMovePolicy({
    user: otherUser,
    userActive: true,
    companyId: validCompany,
    companyActive: true,
    hasModuleView: true,
    hasManagePermission: true,
    effectiveRole: 'SUPERVISOR_VENTAS',
    card: cardInPrep,
    toStatus: 'PENDING_ROUTE_PREP',
    observation: 'Reasignación de ruta',
  })
  assert.equal(adminReturnResult.allowed, true)
})

test('PERM-PREP-02 security: OPERADOR_BODEGA does NOT receive administrative permissions or invoice/audit access', async () => {
  const authSource = await read('src/app/actions/logistica/authorization.ts')
  const invoiceSource = await read('src/app/actions/logistica/sales-order-invoice-attempts.ts')
  const diagSource = await read('src/app/actions/logistica/sales-order-invoice-diagnostics.ts')

  // No recibe manage
  assert.doesNotMatch(authSource, /OPERADOR_BODEGA.*logistica\.preparation\.manage/)

  // Facturación bloqueada
  assert.match(invoiceSource, /if \(auth\.isOperatorBodega\) return \{ status: 'PREVALIDATION_FAILED' as const, error: 'No autorizado para facturación\.' \}/)
  assert.match(invoiceSource, /export async function prevalidateSalesOrderInvoiceAttempt[\s\S]*if \(auth\.isOperatorBodega\) throw new Error\('No autorizado para facturación'\)/)
  assert.match(invoiceSource, /export async function reconcileSalesOrderInvoiceAttempt[\s\S]*if \(auth\.isOperatorBodega\) throw new Error\('No autorizado para facturación'\)/)

  // Diagnóstico comercial de facturación bloqueado
  assert.match(diagSource, /if \(auth\.isOperatorBodega\) return \{ data: null, error: 'No autorizado para información comercial\.' \}/)
})
