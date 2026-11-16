import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire, registerHooks } from 'node:module'
import test from 'node:test'
import ts from 'typescript'

registerHooks({ resolve(specifier, context, nextResolve) {
  try { return nextResolve(specifier, context) } catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || !specifier.startsWith('.')) throw error
    return nextResolve(`${specifier}.ts`, context)
  }
} })

const adapter = await import('./preparation-adapter.ts')
const grouping = await import('./delivery-stops.ts')
const geographic = await import('./geocoding-contract.ts')
const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'
const D = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const MYM_ID = 'd1000000-0000-0000-0000-000000000001'
const auth = { user: { id: 'usuario' }, companyId: 'empresa-a', companyName: 'Empresa', effectiveRole: 'ADMIN', isOperatorBodega: false }

function card(id, nvId, overrides = {}) {
  return { card_id: id, company_id: 'empresa-a', nv_bsale_id: nvId, nv_folio: String(nvId), client_name: 'Cliente ficticio', client_id: 10, address_raw: 'Calle Ficticia 123', normalized_city: 'Talca', municipality_raw: null, city_raw: null, seller_name: 'Ana', total_quantity: 1, gross_amount: 119, total_amount: 119, net_amount: 100, tax_amount: 19, invoice_folio: null, status: 'PENDING_ROUTE_PREP', ...overrides }
}

async function loadBoundary({ initialAuth = auth, finalAuth = initialAuth, cards = [card(A, 1), card(B, 2), card(C, 3)], boardError = null, boardOperator = initialAuth.isOperatorBodega, rejectCard, failAuth = false, transformEvaluation } = {}) {
  const source = await readFile(new URL('./authorize-geocoding.server.ts', import.meta.url), 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  const calls = { auth: 0, board: [], access: [] }
  const modules = {
    'server-only': {},
    '@/app/actions/logistica/authorization': {
      requireWmsPermission: async permission => {
        calls.auth++
        assert.equal(permission, 'module.logistica.view')
        if (failAuth) throw new Error('datos internos que no deben propagarse')
        return calls.auth === 1 ? initialAuth : finalAuth
      },
      requirePreparationCardAccess: async (identity, id) => {
        calls.access.push({ identity, id })
        if (id === rejectCard) throw new Error('tarjeta inaccesible')
      },
    },
    '@/app/actions/logistica/sales-order-preparation': {
      getSalesOrderPreparationBoard: async companyId => {
        calls.board.push(companyId)
        return { data: cards, error: boardError, isOperatorBodega: boardOperator }
      },
    },
    './preparation-adapter': { ...adapter, adaptFilteredPreparationCards: params => {
      const evaluation = adapter.adaptFilteredPreparationCards(params)
      return transformEvaluation ? transformEvaluation(evaluation) : evaluation
    } },
    './delivery-stops': grouping,
    './geocoding-contract': geographic,
  }
  const nativeRequire = createRequire(import.meta.url)
  const localRequire = name => Object.hasOwn(modules, name) ? modules[name] : nativeRequire(name)
  const exports = {}
  new Function('require', 'exports', compiled)(localRequire, exports)
  return { authorize: exports.authorizePreparationGeocoding, calls, source }
}

const denied = error => error.message === 'No se pudo autorizar la solicitud de geocodificación.'

test('usuario autorizado reconstruye solo las tarjetas solicitadas y la agrupación existente', async () => {
  const { authorize, calls, source } = await loadBoundary()
  const result = await authorize([A, B])
  assert.deepEqual(calls.board, ['empresa-a'])
  assert.deepEqual(calls.access.map(item => item.id), [A, B])
  assert.equal(calls.auth, 2)
  assert.equal(result.companyId, 'empresa-a')
  assert.equal(result.userId, 'usuario')
  assert.equal(result.stops.length, 1)
  assert.deepEqual(result.stops[0].cardIds, [A, B])
  assert.equal(result.stops[0].geographic.status, 'REVIEW_REQUIRED')
  assert.equal(result.stops[0].geographic.reason, 'DOMESTIC_SCOPE_REQUIRED')
  assert.equal(result.stops[0].geographic.cacheKey, null)
  assert.deepEqual(result.unresolved, [])
  assert.ok(!result.stops[0].cardIds.includes(C))
  assert.match(source, /^import 'server-only'/)
  assert.doesNotMatch(source, /['"]use server['"]|console\.|functions\.invoke|fetch\(/)
})

test('la tarjeta con dirección incompleta queda identificada sin agregar tarjetas ajenas', async () => {
  const { authorize } = await loadBoundary({ cards: [card(A, 1), card(B, 2, { address_raw: null }), card(C, 3)] })
  const result = await authorize([A, B])
  assert.equal(result.stops.length, 1)
  assert.deepEqual(result.stops[0].cardIds, [A])
  assert.deepEqual(result.unresolved.map(item => item.cardId), [B])
  assert.ok(result.unresolved[0].issues.includes('MISSING_ADDRESS'))
})

test('rechaza empresa equivocada, tarjeta ausente o inaccesible con el mismo error', async () => {
  const cases = [
    { cards: [card(A, 1, { company_id: 'empresa-b' })] },
    { cards: [card(B, 2)] },
    { cards: [card(A, 1)], rejectCard: A },
    { cards: [card(A, 1)], boardError: 'dirección sensible' },
    { cards: [card(A, 1)], boardOperator: true },
    { cards: [card(A, 1)], failAuth: true },
  ]
  for (const options of cases) {
    const { authorize } = await loadBoundary(options)
    await assert.rejects(authorize([A]), denied)
  }
})

test('revalida cada tarjeta de operador y no devuelve datos si falla el acceso individual', async () => {
  const operator = { ...auth, effectiveRole: 'OPERADOR_BODEGA', isOperatorBodega: true }
  const { authorize, calls } = await loadBoundary({ initialAuth: operator, cards: [card(A, 1), card(B, 2)], rejectCard: B })
  await assert.rejects(authorize([A, B]), denied)
  assert.deepEqual(calls.access.map(item => item.id), [A, B])
  assert.equal(calls.auth, 1)
})

test('un cambio de empresa, usuario o rol invalida el resultado antes de entregarlo', async () => {
  for (const finalAuth of [{ ...auth, companyId: 'empresa-b' }, { ...auth, user: { id: 'otro' } }, { ...auth, effectiveRole: 'OPERADOR_BODEGA', isOperatorBodega: true }]) {
    const { authorize, calls } = await loadBoundary({ finalAuth })
    await assert.rejects(authorize([A]), denied)
    assert.equal(calls.auth, 2)
  }
})

test('valida límite, formato y duplicados antes de acceder al tablero', async () => {
  for (const input of [[], [A, A], [D, D.toUpperCase()], ['no-uuid'], Array(301).fill(A), { cardIds: [A], companyId: 'empresa-b', address: 'dato no confiable' }]) {
    const { authorize, calls } = await loadBoundary()
    await assert.rejects(authorize(input), denied)
    assert.equal(calls.auth, 0)
    assert.equal(calls.board.length, 0)
  }
})

test('propiedades adicionales de un arreglo no cambian empresa ni direcciones confiables', async () => {
  const { authorize } = await loadBoundary()
  const ids = [A]
  ids.companyId = 'empresa-b'
  ids.address = 'dato no confiable'
  const result = await authorize(ids)
  assert.equal(result.companyId, 'empresa-a')
  assert.equal(result.stops[0].geographic.originals[0].address, 'Calle Ficticia 123')
})

test('rechaza filas duplicadas y NV inconsistentes sin revelar detalle', async () => {
  for (const cards of [[card(A, 1), card(A, 1)], [card(A, 1), card(B, 1)]]) {
    const { authorize } = await loadBoundary({ cards })
    await assert.rejects(authorize(cards.length === 2 && cards[0].card_id !== cards[1].card_id ? [A, B] : [A]), denied)
  }
})

test('MYM autorizado obtiene clave CL sin depender del nombre comercial ni aceptar datos del navegador', async () => {
  const mymAuth = { ...auth, companyId: MYM_ID, companyName: 'Nombre no utilizado' }
  const original = card(A, 1, { company_id: MYM_ID, address_raw: '  Calle Ficticia 123  ', normalized_city: ' TALCA ', municipality_raw: 'Talca' })
  const { authorize, calls } = await loadBoundary({ initialAuth: mymAuth, cards: [original] })
  const ids = [A]
  ids.companyId = 'empresa-b'
  ids.address = 'dato no confiable'
  const result = await authorize(ids)
  assert.deepEqual(calls.board, [MYM_ID])
  assert.equal(calls.access[0].id, A)
  assert.equal(result.stops[0].geographic.status, 'READY')
  assert.deepEqual(result.stops[0].geographic.cacheKey, { companyId: MYM_ID, countryCode: 'CL', communeKey: 'talca', addressKey: 'calle ficticia 123' })
  assert.equal(result.stops[0].geographic.countrySource, 'MYM_DOMESTIC_POLICY')
  assert.equal(result.stops[0].geographic.originals[0].address, 'Calle Ficticia 123')
  assert.equal(original.address_raw, '  Calle Ficticia 123  ')
})

test('otra empresa no obtiene la política de MYM aunque tenga el mismo nombre', async () => {
  const other = { ...auth, companyId: 'empresa-b', companyName: 'DISTRIBUIDORA MYM' }
  const { authorize } = await loadBoundary({ initialAuth: other, cards: [card(A, 1, { company_id: 'empresa-b' })] })
  const result = await authorize([A])
  assert.equal(result.stops[0].geographic.status, 'REVIEW_REQUIRED')
  assert.equal(result.stops[0].geographic.reason, 'DOMESTIC_SCOPE_REQUIRED')
  assert.equal(result.stops[0].geographic.cacheKey, null)
})

test('el UUID compartido no permite aplicar la política a otro origen o a tarjetas no solicitadas', async () => {
  const mymAuth = { ...auth, companyId: MYM_ID }
  const transformations = [
    evaluation => ({ ...evaluation, origin: 'ROUTE_GUIDE' }),
    evaluation => ({ ...evaluation, deliveries: evaluation.deliveries.map(delivery => ({ ...delivery, source: { ...delivery.source, type: 'ROUTE_GUIDE' } })) }),
    evaluation => ({ ...evaluation, deliveries: evaluation.deliveries.map(delivery => ({ ...delivery, source: { ...delivery.source, recordId: B } })) }),
  ]
  for (const transformEvaluation of transformations) {
    const { authorize } = await loadBoundary({ initialAuth: mymAuth, cards: [card(A, 1, { company_id: MYM_ID })], transformEvaluation })
    await assert.rejects(authorize([A]), denied)
  }
})

test('MYM conserva incidencias por dirección insuficiente o comuna contradictoria, sin limitar el corredor', async () => {
  const mymAuth = { ...auth, companyId: MYM_ID }
  const cards = [
    card(A, 1, { company_id: MYM_ID, normalized_city: 'Talca', municipality_raw: 'Chillán' }),
    card(B, 2, { company_id: MYM_ID, address_raw: null }),
    card(C, 3, { company_id: MYM_ID, normalized_city: 'Punta Arenas', municipality_raw: 'Punta Arenas' }),
    card(D, 4, { company_id: MYM_ID, normalized_city: 'Valdivia', municipality_raw: 'Valdivia', address_raw: { address: 'dato incompatible' } }),
  ]
  const { authorize } = await loadBoundary({ initialAuth: mymAuth, cards })
  const result = await authorize([A, B, C, D])
  const byId = Object.fromEntries(result.stops.flatMap(stop => stop.cardIds.map(id => [id, stop.geographic])))
  assert.equal(byId[A].status, 'REVIEW_REQUIRED')
  assert.equal(byId[A].reason, 'INCONSISTENT_DESTINATIONS')
  assert.equal(byId[A].cacheKey, null)
  assert.equal(byId[C].status, 'READY')
  assert.equal(byId[C].cacheKey.countryCode, 'CL')
  assert.equal(byId[C].cacheKey.communeKey, 'punta arenas')
  assert.ok(result.unresolved.some(item => item.cardId === B && item.issues.includes('MISSING_ADDRESS')))
  assert.ok(result.unresolved.some(item => item.cardId === D && item.issues.includes('INVALID_SOURCE_FIELD')))
})

test('la frontera usa la dirección original de la NV y comprueba la comuna escrita', async () => {
  const mymAuth = { ...auth, companyId: MYM_ID }
  const cards = [
    card(A, 1, { company_id: MYM_ID, nv_folio: 5394, address_raw: 'Av los Puelches 1440, Chillán', normalized_city: 'Chillán', municipality_raw: 'Chillán' }),
    card(B, 2, { company_id: MYM_ID, address_raw: 'Av los Puelches 1440, Talca', normalized_city: 'Chillán', municipality_raw: 'Chillán' }),
  ]
  const { authorize } = await loadBoundary({ initialAuth: mymAuth, cards })
  const result = await authorize([A, B])
  const byId = Object.fromEntries(result.stops.flatMap(stop => stop.cardIds.map(id => [id, stop.geographic])))
  assert.equal(byId[A].status, 'READY')
  assert.equal(byId[A].cacheKey.addressKey, 'av los puelches 1440, chillán')
  assert.equal(byId[A].cacheKey.communeKey, 'chillán')
  assert.equal(byId[A].originals[0].address, 'Av los Puelches 1440, Chillán')
  assert.equal(byId[A].originals[0].addressSource, 'PREPARATION_CARD')
  assert.equal(byId[B].status, 'REVIEW_REQUIRED')
  assert.equal(byId[B].reason, 'INCONSISTENT_DESTINATIONS')
  assert.equal(byId[B].cacheKey, null)
})
