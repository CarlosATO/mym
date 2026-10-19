import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  createPreparationDetailCache,
  getUncachedNvIds,
  putPreparationDetailsBatch,
  prunePreparationDetailCache,
} from '../src/modules/logistica/preparacion-pedidos/preparation-detail-cache.ts'
import { generatePreparationOrdersPdf } from '../src/lib/pdf/generate-preparation-orders-pdf.ts'

const root = new URL('../', import.meta.url)
const panelSource = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-preparation-panel.tsx', root), 'utf8')
const drawerSource = await readFile(new URL('src/modules/logistica/preparacion-pedidos/sales-order-drawer.tsx', root), 'utf8')
const cacheSource = await readFile(new URL('src/modules/logistica/preparacion-pedidos/preparation-detail-cache.ts', root), 'utf8')

test('1. board carga antes que prefetch y no se bloquea por él', () => {
  // loadBoard debe actualizar cards antes de lanzar el prefetch
  const setCardsIndex = panelSource.indexOf('setCards(rows)')
  const prefetchCallIndex = panelSource.indexOf('void prefetchPreparationDetails(activeCompanyId, rows.map(r => r.nv_bsale_id))')

  assert.ok(setCardsIndex > 0, 'setCards(rows) debe existir en panel')
  assert.ok(prefetchCallIndex > 0, 'void prefetchPreparationDetails(...) debe existir en panel')
  assert.ok(setCardsIndex < prefetchCallIndex, 'setCards debe ocurrir antes de prefetchPreparationDetails')
  // Comprueba que sea "void prefetchPreparationDetails", garantizando no bloqueo
  assert.match(panelSource, /void prefetchPreparationDetails\(/)
})

test('2. prefetch usa batch, no N+1', () => {
  assert.match(panelSource, /const res = await getSalesOrderPreparationPrintData\(activeCompanyId, uncachedIds\)/)
  // No debe haber un loop llamando getSalesOrderPreparation por tarjeta dentro del prefetch
  const prefetchStart = panelSource.indexOf('const prefetchPreparationDetails = useCallback')
  const prefetchEnd = panelSource.indexOf('const loadBoard = useCallback', prefetchStart)
  const prefetchBody = panelSource.slice(prefetchStart, prefetchEnd)

  assert.doesNotMatch(prefetchBody, /for\s*\([^)]*\)\s*\{[^}]*await\s+getSalesOrder/)
  assert.doesNotMatch(prefetchBody, /\.map\(\s*async[^)]*=>\s*await\s+getSalesOrder/)
})

test('3. cache hit abre tarjeta sin fetch items', () => {
  const openStart = panelSource.indexOf('const openCardDetails = async')
  const openEnd = panelSource.indexOf('const transitionCard = async', openStart)
  const openBody = panelSource.slice(openStart, openEnd)

  assert.match(openBody, /const cached = detailCacheRef\.current\.get\(card\.nv_bsale_id\)/)
  assert.match(openBody, /if \(cached\) \{/)
  assert.match(openBody, /setSelectedItems\(cached\.items\)/)
  assert.match(openBody, /setSelectedClientData\(cached\.clientData\)/)
  assert.match(openBody, /setLoadingItems\(false\)/)
  assert.match(openBody, /return/)

  // En cache hit, el return ocurre ANTES de cualquier llamada a getSalesOrderPreparationPrintData
  const hitIndex = openBody.indexOf('return')
  const fetchIndex = openBody.indexOf('await getSalesOrderPreparationPrintData')
  assert.ok(hitIndex < fetchIndex, 'El cache hit debe retornar antes de llamar al servidor')
})

test('4. cache hit entrega clientData sin fetch adicional al abrir drawer', () => {
  assert.match(panelSource, /<SalesOrderDrawer[\s\S]*clientData=\{selectedClientData\}/)
  assert.match(drawerSource, /clientData\?: SalesOrderClientData \| null/)
  assert.match(drawerSource, /const clientData = clientDataProp !== undefined \? clientDataProp : fallbackClientData/)
  assert.match(drawerSource, /if \(clientDataProp !== undefined\) return/)
})

test('5. cache miss usa fallback individual seguro', () => {
  const openStart = panelSource.indexOf('const openCardDetails = async')
  const openEnd = panelSource.indexOf('const transitionCard = async', openStart)
  const openBody = panelSource.slice(openStart, openEnd)

  assert.match(openBody, /setLoadingItems\(true\)/)
  assert.match(openBody, /await getSalesOrderPreparationPrintData\(companyId, \[card\.nv_bsale_id\]\)/)
})

test('6. fallback guarda en cache', () => {
  const openStart = panelSource.indexOf('const openCardDetails = async')
  const openEnd = panelSource.indexOf('const transitionCard = async', openStart)
  const openBody = panelSource.slice(openStart, openEnd)

  assert.match(openBody, /detailCacheRef\.current\.set\(card\.nv_bsale_id, \{/)
  assert.match(openBody, /items,/)
  assert.match(openBody, /clientData,/)
})

test('7. Pendiente → En preparación conserva cache en memoria', () => {
  const cache = createPreparationDetailCache()
  const nvId = 4988
  putPreparationDetailsBatch(
    cache,
    {
      itemsByNv: { '4988': [{ detail_id: 'd1', nv_bsale_id: 4988, sku: 'PROD-1', product_name: 'Producto Test', quantity: 5, unit_net_value: 1000 }] },
      clientByNv: { '4988': { rut: '12.345.678-9', phone: '+56912345678', email: 'test@example.com' } },
    },
    [nvId],
  )

  assert.ok(cache.has(nvId), 'Cache debe contener la NV 4988 precargada en Pendiente')

  // Transición: mover la tarjeta cambia el status pero no el nv_bsale_id ni el cache
  const cardBefore = { card_id: 'c1', nv_bsale_id: nvId, status: 'PENDING_ROUTE_PREP' }
  const cardAfter = { ...cardBefore, status: 'IN_PREPARATION' }

  // Verificar que el cache no fue alterado por la transición
  assert.ok(cache.has(cardAfter.nv_bsale_id), 'Cache debe seguir disponible tras mover a IN_PREPARATION')
  const entry = cache.get(cardAfter.nv_bsale_id)
  assert.equal(entry?.items[0].sku, 'PROD-1')
  assert.equal(entry?.clientData?.rut, '12.345.678-9')

  // Verificar que transitionCard en panel no limpie el detailCacheRef
  const transStart = panelSource.indexOf('const transitionCard = async')
  const transEnd = panelSource.indexOf('const toggleSelection =', transStart)
  const transBody = panelSource.slice(transStart, transEnd)
  assert.doesNotMatch(transBody, /detailCacheRef/)
})

test('8. historial de movimientos NO carga al abrir drawer', () => {
  // useEffect de card_id en drawer resetea sin cargar
  assert.match(drawerSource, /setMovements\(\[\]\)/)
  assert.match(drawerSource, /setMovementsLoaded\(false\)/)
  assert.doesNotMatch(drawerSource, /useEffect\(\(\) => \{[^}]*loadMovements\(\)/)
})

test('9. historial de movimientos carga al expandir details', () => {
  assert.match(drawerSource, /onToggle=\{handleMovementsToggle\}/)
  assert.match(drawerSource, /const handleMovementsToggle = \(e: React\.SyntheticEvent<HTMLDetailsElement>\) => \{/)
  assert.match(drawerSource, /if \(isOpen && !movementsLoaded && !loadingMovements && card\?\.card_id\) \{/)
  assert.match(drawerSource, /void loadMovements\(\)/)
})

test('10. historial se consulta sólo una vez mientras no se invalide', () => {
  assert.match(drawerSource, /!movementsLoaded/)
  assert.match(drawerSource, /setMovementsLoaded\(true\)/)
})

test('11. cambio rápido A → B no mezcla items (race protection)', () => {
  assert.match(panelSource, /const requestId = \+\+itemsRequestSeqRef\.current/)
  assert.match(panelSource, /if \(requestId !== itemsRequestSeqRef\.current \|\| !mountedRef\.current\) return/)
})

test('12. sync limpia/actualiza cache correctamente', () => {
  assert.match(panelSource, /detailCacheRef\.current\.clear\(\)/)
  assert.match(panelSource, /prunePreparationDetailCache\(detailCacheRef\.current, rows\.map\(r => r\.nv_bsale_id\)\)/)

  // Test unitario de poda
  const cache = createPreparationDetailCache()
  putPreparationDetailsBatch(
    cache,
    {
      itemsByNv: { '100': [], '200': [], '300': [] },
      clientByNv: {},
    },
    [100, 200, 300],
  )
  assert.equal(cache.size, 3)

  // Sync deja solo 100 y 300
  const removed = prunePreparationDetailCache(cache, [100, 300])
  assert.equal(removed, 1)
  assert.ok(cache.has(100))
  assert.ok(!cache.has(200))
  assert.ok(cache.has(300))
})

test('13. fallo en prefetch no bloquea el board ni lanza toasts intrusivos', () => {
  assert.match(panelSource, /catch \(err: unknown\) \{/)
  assert.doesNotMatch(panelSource, /catch[^}]*toast\.error[^}]*prefetch/)
})

test('14. PDF existente sigue funcionando con datos del cache', () => {
  const dummyCard = {
    card_id: 'card-1',
    nv_folio: 9999,
    client_name: 'Cliente Test SpA',
    nv_emission_date: '2026-10-19',
    route_date: '2026-10-20',
    status: 'IN_PREPARATION',
    total_quantity: 12,
    net_amount: 50000,
    gross_amount: 59500,
    seller_name: 'Vendedor Test',
    address_raw: 'Calle Falsa 123',
    city_raw: 'Curicó',
    normalized_city: 'Curicó',
  }

  const dummyItems = [
    { detail_id: 'd-1', nv_bsale_id: 9999, sku: 'ALIM-01', product_name: 'Alimento Premium 15kg', quantity: 2, unit_net_value: 25000 },
  ]

  const dummyClient = {
    rut: '76.123.456-7',
    phone: '+56987654321',
    email: 'contacto@clientetest.cl',
  }

  const blob = generatePreparationOrdersPdf([{ card: dummyCard, items: dummyItems, clientData: dummyClient }])
  assert.ok(blob instanceof Blob, 'El PDF debe retornar un Blob')
  assert.equal(blob.type, 'application/pdf', 'El tipo de Blob debe ser application/pdf')
  assert.ok(blob.size > 1000, 'El PDF generado debe contener contenido')
})
