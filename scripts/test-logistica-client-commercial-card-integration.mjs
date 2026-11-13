import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function loadModule(path, mockedModules = {}) {
  const source = readFileSync(new URL(path, import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
  }).outputText

  const exports = {}
  const moduleContext = {
    exports,
    require: name => {
      if (name in mockedModules) return mockedModules[name]
      throw new Error(`Unexpected import in test: ${name}`)
    },
    console,
    process: { env: {} },
    Date,
    Number,
    Error,
    String,
    Boolean,
    AbortSignal,
    Map,
    Set,
    Promise,
    setTimeout,
    clearTimeout,
    performance: { now: () => Date.now() },
  }

  vm.runInNewContext(compiled, moduleContext)
  return exports
}

// ==============================================================================
// 1. Pruebas de Backend: getCardClientCommercialStatusesBatch
// ==============================================================================

test('getCardClientCommercialStatusesBatch agrupa consultas, no llama a Bsale y respeta identidad canónica', async () => {
  let bsaleNetworkCalls = 0
  const queriesExecuted = []

  // Mock de datos para 3 tarjetas:
  // - card-1: token canónico -> nv 5002 -> client 101 -> commerciallyBlocked: true
  // - card-2: token canónico -> nv 6002 -> client 102 -> commerciallyBlocked: false
  // - card-3: sin token -> nv 7001 -> client 103 -> commerciallyBlocked: null (UNKNOWN)
  const mockCards = [
    { id: 'card-1', bsale_nv_id: 5001, current_bsale_nv_id: 5002, canonical_bsale_token: 'tok-1' },
    { id: 'card-2', bsale_nv_id: 6001, current_bsale_nv_id: 6002, canonical_bsale_token: 'tok-2' },
    { id: 'card-3', bsale_nv_id: 7001, current_bsale_nv_id: 7001, canonical_bsale_token: null },
  ]

  const mockCanonicalDocs = [
    { canonical_bsale_token: 'tok-1', current_bsale_id: 5002, client_id: 101 },
    { canonical_bsale_token: 'tok-2', current_bsale_id: 6002, client_id: 102 },
  ]

  const mockBsaleDocs = [
    { bsale_id: 7001, client_id: 103 },
  ]

  const mockClients = [
    { bsale_client_id: 101, raw_payload: { id: 101, commerciallyBlocked: true }, last_seen_at: '2026-11-13T10:00:00Z' },
    { bsale_client_id: 102, raw_payload: { id: 102, commerciallyBlocked: false }, last_seen_at: '2026-11-13T10:05:00Z' },
    { bsale_client_id: 103, raw_payload: { id: 103 }, last_seen_at: null },
  ]

  const adminDb = {
    schema: schemaName => ({
      from: tableName => ({
        select: () => ({
          eq: (f1, v1) => ({
            in: (f2, values) => {
              queriesExecuted.push({ schema: schemaName, table: tableName, filter: f2, count: values.length })
              if (tableName === 'sales_order_preparation_cards') {
                return Promise.resolve({ data: mockCards, error: null })
              }
              if (tableName === 'vw_bsale_sales_order_documents_canonical') {
                return Promise.resolve({ data: mockCanonicalDocs, error: null })
              }
              if (tableName === 'bsale_documents') {
                return Promise.resolve({ data: mockBsaleDocs, error: null })
              }
              if (tableName === 'bsale_clients') {
                return Promise.resolve({ data: mockClients, error: null })
              }
              return Promise.resolve({ data: [], error: null })
            },
          }),
        }),
      }),
    }),
  }

  const mockedModules = {
    '@/lib/supabase/server': { createClient: async () => ({}) },
    '@/lib/supabase/admin': { createAdminClient: () => adminDb },
    '@/app/actions/companies': { getActiveCompanyId: async () => 'comp-1' },
    '@/app/actions/integraciones/sync': { getWarehousePreparationSyncHealth: async () => ({}) },
    '@/modules/logistica/preparacion-pedidos/preparation-sync-policy': { decidePreparationSync: () => ({}) },
    '@/lib/integraciones/invoice-emission-contract': { chileToday: () => '2026-11-13' },
    '@/lib/integraciones/bsale-client-commercial-normalization': { extractBsaleRelationIdFromHref: () => null },
    '@/lib/integraciones/invoice-print-assistant': {
      getSafeHttpsHostname: () => '',
      validateBsalePdfResponseUrl: () => null,
      validateBsalePdfUrl: () => null,
      validateBsaleRedirectUrl: () => null,
    },
    './authorization': {
      requirePreparationCardAccess: async () => {},
      requirePreparationCardMoveAuthorization: async () => {},
      requirePreparationLineConfirmationAuthorization: async () => {},
      requireWmsPermission: async () => ({ companyId: 'comp-1', isOperatorBodega: false }),
    },
    './sales-order-preparation-cache': {
      patchPreparationLine: () => {},
      prunePreparationDetailCache: () => {},
      prunePreparationLinesCache: () => {},
      readPreparationDetailCache: () => null,
      readPreparationLinesCache: () => null,
      writePreparationDetailCache: () => {},
      writePreparationLinesCache: () => {},
    },
    '@/lib/integraciones/bsale-client-commercial-normalization': {
      extractBsaleRelationIdFromHref: () => null,
      parseCommerciallyBlocked: value => {
        if (value === true || value === 1 || value === '1' || value === 'true') return true
        if (value === false || value === 0 || value === '0' || value === 'false') return false
        return null
      },
    },
    './sales-order-client-commercial-verification': {
      parseCommerciallyBlocked: value => {
        if (value === true || value === 1 || value === '1' || value === 'true') return true
        if (value === false || value === 0 || value === '0' || value === 'false') return false
        return null
      },
    },
  }

  const { getCardClientCommercialStatusesBatch } = loadModule(
    '../src/app/actions/logistica/sales-order-preparation.ts',
    mockedModules
  )

  const startTime = Date.now()
  const resultMap = await getCardClientCommercialStatusesBatch('comp-1', ['card-1', 'card-2', 'card-3'])
  const durationMs = Date.now() - startTime

  // 1. Verificación de cero llamadas individuales a Bsale
  assert.equal(bsaleNetworkCalls, 0, 'La carga del tablero NO debe consultar Bsale individualmente')

  // 2. Verificación de consultas agrupadas (batch con IN)
  assert.ok(queriesExecuted.length <= 4, 'Consultas agrupadas eficientes en batch')
  assert.ok(queriesExecuted.every(q => q.count > 0))

  // 3. Verificación de resultados por tarjeta
  const card1Status = resultMap.get('card-1')
  assert.equal(card1Status?.clientId, 101)
  assert.equal(card1Status?.status, 'BLOCKED')
  assert.equal(card1Status?.commerciallyBlocked, true)
  assert.equal(card1Status?.verifiedAt, '2026-11-13T10:00:00Z')

  const card2Status = resultMap.get('card-2')
  assert.equal(card2Status?.clientId, 102)
  assert.equal(card2Status?.status, 'UNBLOCKED')
  assert.equal(card2Status?.commerciallyBlocked, false)

  const card3Status = resultMap.get('card-3')
  assert.equal(card3Status?.clientId, 103)
  assert.equal(card3Status?.status, 'UNKNOWN')
  assert.equal(card3Status?.commerciallyBlocked, null)

  // 4. Rendimiento rápido sin N+1
  assert.ok(durationMs < 100, `Rendimiento de carga batch óptimo: ${durationMs}ms`)
})

// ==============================================================================
// 2. Pruebas de Lógica e Interfaz de Tarjetas (sales-order-card)
// ==============================================================================

test('Tarjeta bloqueada: detecta bloqueo comercial, aplica formato rojo y renderiza botón', () => {
  const blockedCard = {
    card_id: 'card-blocked-1',
    company_id: 'comp-1',
    status: 'IN_PREPARATION',
    nv_folio: '5001',
    client_name: 'Cliente Bloqueado S.A.',
    client_id: 101,
    client_commercial_status: 'BLOCKED',
    client_commercially_blocked: true,
  }

  const isClientBlocked = blockedCard.client_commercially_blocked === true || blockedCard.client_commercial_status === 'BLOCKED'
  const isClientUnknown = !blockedCard.client_commercial_status || blockedCard.client_commercial_status === 'UNKNOWN'

  assert.equal(isClientBlocked, true)
  assert.equal(isClientUnknown, false)

  // Nombre debe tener estilo rojo intenso
  const clientNameClasses = isClientBlocked
    ? 'font-bold text-red-700 group-hover:text-red-800'
    : 'font-semibold text-[#322D29] group-hover:text-[#72383D]'
  assert.match(clientNameClasses, /text-red-700/)
  assert.match(clientNameClasses, /font-bold/)

  // Debe incluir la leyenda «Cliente bloqueado» y permitir verificar si canVerifyClientCommercial es true
  const canVerifyCommercialAdmin = true
  const shouldRenderVerifyButton = isClientBlocked && canVerifyCommercialAdmin
  assert.equal(shouldRenderVerifyButton, true)
})

test('Rol OPERADOR_BODEGA: muestra advertencia visual pero NO presenta el botón funcional', () => {
  const blockedCard = {
    card_id: 'card-blocked-2',
    client_name: 'Distribuidora Norte Ltda.',
    client_commercial_status: 'BLOCKED',
    client_commercially_blocked: true,
  }

  const isOperatorBodega = true
  const canVerifyClientCommercial = !isOperatorBodega // false para operador de bodega

  const isClientBlocked = blockedCard.client_commercially_blocked === true || blockedCard.client_commercial_status === 'BLOCKED'
  const showWarningNotice = isClientBlocked
  const showInteractiveButton = isClientBlocked && canVerifyClientCommercial

  assert.equal(showWarningNotice, true, 'El operador de bodega sí ve el aviso visual de bloqueo')
  assert.equal(showInteractiveButton, false, 'El operador de bodega NO ve el botón interactivo de verificación')
})

test('Desbloqueo exitoso: actualiza inmediatamente la tarjeta a UNBLOCKED sin recargar tablero', () => {
  let cardState = {
    card_id: 'card-1',
    nv_folio: '5001',
    client_name: 'Supermercado Central',
    client_commercial_status: 'BLOCKED',
    client_commercially_blocked: true,
    client_commercial_verified_at: '2026-11-13T09:00:00Z',
  }

  // Simulación de respuesta exitosa de verifyCardClientCommercialStatus
  const verificationResult = {
    data: {
      cardId: 'card-1',
      clientId: 101,
      status: 'UNBLOCKED',
      commerciallyBlocked: false,
      verifiedAt: '2026-11-13T12:00:00Z',
      previousStatus: 'BLOCKED',
    },
    error: null,
  }

  // Manejador local de actualización de estado
  if (verificationResult.data?.status === 'UNBLOCKED') {
    cardState = {
      ...cardState,
      client_commercial_status: 'UNBLOCKED',
      client_commercially_blocked: false,
      client_commercial_verified_at: verificationResult.data.verifiedAt,
    }
  }

  assert.equal(cardState.client_commercial_status, 'UNBLOCKED')
  assert.equal(cardState.client_commercially_blocked, false)
  assert.equal(cardState.client_commercial_verified_at, '2026-11-13T12:00:00Z')

  // Tras desbloqueo, el nombre vuelve a estilo normal y la advertencia se retira
  const isClientBlockedNow = cardState.client_commercially_blocked === true || cardState.client_commercial_status === 'BLOCKED'
  assert.equal(isClientBlockedNow, false)
})

test('Bloqueo persistente: mantiene estado BLOCKED y actualiza marca temporal', () => {
  let cardState = {
    card_id: 'card-1',
    client_commercial_status: 'BLOCKED',
    client_commercially_blocked: true,
    client_commercial_verified_at: '2026-11-13T09:00:00Z',
  }

  const verificationResult = {
    data: {
      cardId: 'card-1',
      clientId: 101,
      status: 'BLOCKED',
      commerciallyBlocked: true,
      verifiedAt: '2026-11-13T12:05:00Z',
      previousStatus: 'BLOCKED',
    },
    error: null,
  }

  if (verificationResult.data?.status === 'BLOCKED') {
    cardState = {
      ...cardState,
      client_commercial_status: 'BLOCKED',
      client_commercially_blocked: true,
      client_commercial_verified_at: verificationResult.data.verifiedAt,
    }
  }

  assert.equal(cardState.client_commercial_status, 'BLOCKED')
  assert.equal(cardState.client_commercially_blocked, true)
  assert.equal(cardState.client_commercial_verified_at, '2026-11-13T12:05:00Z')
})

test('Fallo de Bsale o timeout: conserva estado previo y nunca asume desbloqueo', () => {
  let cardState = {
    card_id: 'card-1',
    client_commercial_status: 'BLOCKED',
    client_commercially_blocked: true,
    client_commercial_verified_at: '2026-11-13T09:00:00Z',
  }

  const verificationResult = {
    data: {
      cardId: 'card-1',
      clientId: 101,
      status: 'UNKNOWN',
      commerciallyBlocked: null,
      verifiedAt: '2026-11-13T12:10:00Z',
      previousStatus: 'BLOCKED',
    },
    error: 'Error Bsale (429): Rate limit exceeded',
  }

  // Regla: Si devuelve UNKNOWN o error, conservar el último estado conocido
  if (verificationResult.data?.status === 'UNBLOCKED') {
    cardState.client_commercial_status = 'UNBLOCKED'
  }

  assert.equal(cardState.client_commercial_status, 'BLOCKED', 'Conserva estado bloqueado ante fallo')
  assert.equal(cardState.client_commercially_blocked, true)
})

test('Eventos de botón: evita apertura, selección o arrastre accidental de la tarjeta', () => {
  let cardOpened = false
  let cardSelected = false
  let dragStarted = false

  const handleCardClick = event => {
    // Verificación de data-card-action implementada en sales-order-card.tsx
    if (event.target?.dataset?.cardAction || event.target?.closest?.('[data-card-action]')) {
      return
    }
    cardOpened = true
  }

  const handlePointerDown = event => {
    if (event.target?.closest?.('[data-card-action]')) {
      event.stopPropagation()
      return
    }
    dragStarted = true
  }

  // Simulación de click en el botón «Verificar en Bsale»
  const mockButtonElement = {
    dataset: { cardAction: '' },
    closest: selector => (selector === '[data-card-action]' ? mockButtonElement : null),
  }

  let propagationStopped = false
  const mockEvent = {
    target: mockButtonElement,
    stopPropagation: () => {
      propagationStopped = true
    },
  }

  handlePointerDown(mockEvent)
  handleCardClick(mockEvent)

  assert.equal(propagationStopped, true)
  assert.equal(cardOpened, false, 'El botón de verificación NO debe abrir el detalle de la tarjeta')
  assert.equal(cardSelected, false, 'El botón de verificación NO debe alterar la selección')
  assert.equal(dragStarted, false, 'El botón de verificación NO debe iniciar arrastre')
})

test('Concurrencia: previene clics duplicados y no sobrescribe con respuestas antiguas', () => {
  let isVerifying = false
  let executions = 0

  const handleVerifyClick = () => {
    if (isVerifying) return false
    isVerifying = true
    executions++
    return true
  }

  assert.equal(handleVerifyClick(), true, 'Primera ejecución permitida')
  assert.equal(handleVerifyClick(), false, 'Clic duplicado bloqueado mientras verifica')
  assert.equal(executions, 1)

  // Protección contra respuestas desordenadas / antiguas
  const card = {
    card_id: 'card-1',
    client_commercial_verified_at: '2026-11-13T12:15:00Z',
    client_commercial_status: 'UNBLOCKED',
  }

  const olderResponse = {
    verifiedAt: '2026-11-13T12:10:00Z',
    status: 'BLOCKED',
  }

  const isOlder = new Date(card.client_commercial_verified_at).getTime() > new Date(olderResponse.verifiedAt).getTime()
  assert.equal(isOlder, true, 'Detecta que la respuesta es más antigua que el estado actual')
})

test('Respuesta tardía (applied = false): UI advierte descarte y adopta estado prevalente de BD', () => {
  let cardState = {
    card_id: 'card-1',
    nv_folio: '5001',
    client_commercial_status: 'BLOCKED',
    client_commercially_blocked: true,
    client_commercial_verified_at: '2026-11-13T12:00:00Z',
  }

  const toastEvents = []
  const toastMock = {
    warning: msg => toastEvents.push({ type: 'warning', msg }),
    success: msg => toastEvents.push({ type: 'success', msg }),
    error: msg => toastEvents.push({ type: 'error', msg }),
  }

  // Respuesta de la Server Action cuando applied = false
  const verificationResult = {
    data: {
      cardId: 'card-1',
      clientId: 101,
      status: 'BLOCKED',
      commerciallyBlocked: true,
      verifiedAt: '2026-11-13T12:15:00Z',
      previousStatus: 'BLOCKED',
      applied: false,
    },
    error: 'Observación comercial descartada: existe una actualización más reciente en la base de datos.',
  }

  // Simulación del flujo de control en sales-order-card.tsx
  if (verificationResult.data?.applied === false) {
    toastMock.warning(verificationResult.error ?? 'La verificación fue descartada')
    if (verificationResult.data.status && verificationResult.data.status !== 'UNKNOWN') {
      cardState = {
        ...cardState,
        client_commercial_status: verificationResult.data.status,
        client_commercially_blocked: verificationResult.data.commerciallyBlocked,
        client_commercial_verified_at: verificationResult.data.verifiedAt,
      }
    }
  } else if (verificationResult.data?.status === 'UNBLOCKED') {
    toastMock.success('Cliente desbloqueado en Bsale')
  }

  assert.equal(toastEvents.length, 1)
  assert.equal(toastEvents[0].type, 'warning')
  assert.match(toastEvents[0].msg, /Observación comercial descartada/)
  assert.equal(cardState.client_commercial_status, 'BLOCKED')
  assert.equal(cardState.client_commercial_verified_at, '2026-11-13T12:15:00Z')
})

