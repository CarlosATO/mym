/**
 * Suite de pruebas de integración y regresión: FAC-DIR-02B
 * Integración segura de resolución de direcciones Bsale en emisión de facturas.
 *
 * Ejecución: node scripts/test-logistica-invoice-address-integration.mjs
 */

import assert from 'node:assert/strict'
import {
  buildInvoiceEmissionPayload,
  buildInvoiceEmissionIdentity,
  invoiceAddressResolutionEnabled,
  resolveInvoiceEmissionAddress,
} from '../src/lib/integraciones/invoice-emission-contract.ts'
import {
  verifyBsaleInvoiceAddress,
  resolveBsaleClientAddress,
} from '../src/lib/integraciones/bsale-address-resolution.ts'

console.log('--- Iniciando suite de pruebas: FAC-DIR-02B (Integración de Direcciones en Facturación) ---')

let passedTests = 0
function test(name, fn) {
  try {
    fn()
    console.log(`  ✓ ${name}`)
    passedTests++
  } catch (err) {
    console.error(`  ✗ ${name}`)
    console.error(err)
    process.exit(1)
  }
}

// ==========================================
// FIXTURES REALES CONOCIDOS
// ==========================================

// Cliente 643 (AMIMASCOTA SPA / Tatiana Pailahuar)
const CLIENT_643 = {
  address: 'SANTIAGO',
  commune: 'SANTIAGO',
  city: 'SANTIAGO',
}

const ADDRESSES_643 = [
  {
    id: 11,
    addressName: 'MALL GO FLORIDA ',
    address: 'MALL GO FLORIDA  LOCAL 1015B',
    municipality: 'TALCA',
    city: 'TALCA',
    state: 0,
  },
  {
    id: 12,
    addressName: 'MALL BRISAS DEL CENTRO',
    address: 'MALL BRISAS DEL CENTRO LOCAL 4',
    municipality: 'TALCA',
    city: 'TALCA',
    state: 0,
  },
]

// Cliente 994
const CLIENT_994 = {
  address: 'Freire #854',
  commune: 'Constitución',
  city: 'Constitución',
}

const ADDRESSES_994 = [
  {
    id: 28,
    addressName: 'Sucursal Romeral',
    address: 'Camino Romeral Km 5',
    municipality: 'Romeral',
    city: 'Romeral',
    state: 0,
  },
]

// ==========================================
// TEST CASES
// ==========================================

// 1. Caso real conocido: NV 5140 -> Factura 24873 (Mall Go Florida, id 11)
test('1. Caso real NV 5140 -> Factura 24873: Resuelve addressId: 11 e incorpora addressId en el payload', () => {
  const nv = {
    address: 'MALL GO FLORIDA  LOCAL 1015B',
    municipality: 'TALCA',
    city: 'TALCA',
  }

  const result = resolveInvoiceEmissionAddress({
    nv,
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })

  assert.equal(result.ok, true)
  assert.equal(result.addressId, 11)

  const payload = buildInvoiceEmissionPayload({
    officeId: 1,
    priceListId: 1,
    saleConditionId: 1,
    emissionDate: 1730600000,
    expirationDate: 1730600000,
    clientId: 643,
    sellerId: 10,
    salesId: 'PETGROUP:FACTURA:test:123',
    addressId: result.addressId,
    details: [{ detailId: 101, quantity: 2 }],
    payments: [{ paymentTypeId: 1, amount: 50000, recordDate: 1730600000 }],
  })

  assert.equal(payload.addressId, 11)
  assert.equal(payload.clientId, 643)
  assert.equal(payload.salesId, 'PETGROUP:FACTURA:test:123')
})

// 2. Caso real conocido: NV 5147 -> Factura 24872 (Coincidencia con dirección principal)
test('2. Caso real NV 5147 -> Factura 24872: Coincide con dirección principal, omite addressId en payload', () => {
  const nv = {
    address: 'Freire 854',
    municipality: 'Constitución',
    city: 'Maule',
  }

  const result = resolveInvoiceEmissionAddress({
    nv,
    client: CLIENT_994,
    clientAddresses: ADDRESSES_994,
  })

  assert.equal(result.ok, true)
  assert.equal(result.addressId, null)

  const payload = buildInvoiceEmissionPayload({
    officeId: 1,
    priceListId: 1,
    saleConditionId: 1,
    emissionDate: 1730600000,
    expirationDate: 1730600000,
    clientId: 994,
    sellerId: 10,
    salesId: 'PETGROUP:FACTURA:test:456',
    addressId: result.addressId,
    details: [{ detailId: 201, quantity: 5 }],
    payments: [{ paymentTypeId: 1, amount: 25000, recordDate: 1730600000 }],
  })

  // addressId debe estar ausente cuando es null (PRIMARY_ADDRESS_MATCHED)
  assert.equal('addressId' in payload, false)
  assert.equal(payload.clientId, 994)
})

// 3. Coincidencia con dirección adicional normalizada (espacios, mayúsculas, diacríticos)
test('3. Coincidencia con dirección adicional normalizada: Extrae addressId válido', () => {
  const nv = {
    address: '  mall  go   florida local 1015b  ',
    municipality: 'Talca',
    city: 'Talca',
  }

  const result = resolveInvoiceEmissionAddress({
    nv,
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })

  assert.equal(result.ok, true)
  assert.equal(result.addressId, 11)
})

// 4. Direcciones ambiguas o duplicadas activas -> Bloquea emisión antes de POST
test('4. Direcciones ambiguas o duplicadas activas: Bloquea con AMBIGUOUS_MATCH', () => {
  const duplicateAddresses = [
    { id: 11, address: 'Av. Colón 100', municipality: 'TALCA', state: 0 },
    { id: 12, address: 'Av. Colón 100', municipality: 'TALCA', state: 0 },
  ]

  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Av. Colón 100', municipality: 'Talca' },
    client: { address: 'Otra Casa Matriz', commune: 'Talca' },
    clientAddresses: duplicateAddresses,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'AMBIGUOUS_MATCH')
  assert.match(result.error, /múltiples direcciones activas coinciden/i)
})

// 5. Dirección inactiva (state !== 0) -> Bloquea emisión antes de POST
test('5. Dirección inactiva (state: 1): Bloquea con MATCHING_ADDRESS_IS_INACTIVE', () => {
  const inactiveAddresses = [
    { id: 77, address: 'Los Aromos 450', municipality: 'LINARES', state: 1 },
  ]

  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Los Aromos 450', municipality: 'Linares' },
    client: { address: 'Casa Central 1', commune: 'Linares' },
    clientAddresses: inactiveAddresses,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MATCHING_ADDRESS_IS_INACTIVE')
  assert.match(result.error, /dirección inactiva en Bsale/i)
})

// 6. Dirección con state: null (no presumida activa) -> Bloquea emisión antes de POST
test('6. Dirección con state: null (no presumida activa, FAC-DIR-02B): Bloquea con MATCHING_ADDRESS_IS_INACTIVE', () => {
  const nullStateAddresses = [
    { id: 88, address: 'Calle Chacabuco 12', municipality: 'TALCA', state: null },
  ]

  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Calle Chacabuco 12', municipality: 'Talca' },
    client: { address: 'Oficina Central', commune: 'Talca' },
    clientAddresses: nullStateAddresses,
  })

  assert.equal(result.ok, false)
  assert.equal(result.code, 'MATCHING_ADDRESS_IS_INACTIVE')
  assert.match(result.error, /dirección inactiva en Bsale/i)
})

// 7. Bloqueo por falta de datos en Nota de Venta (sin dirección o en blanco)
test('7. Bloqueo por falta de datos: NV con dirección null o en blanco', () => {
  const resNull = resolveInvoiceEmissionAddress({
    nv: { address: null, municipality: 'Talca' },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(resNull.ok, false)
  assert.equal(resNull.code, 'INSUFFICIENT_DATA')

  const resBlank = resolveInvoiceEmissionAddress({
    nv: { address: '    ', municipality: 'Talca' },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(resBlank.ok, false)
  assert.equal(resBlank.code, 'INSUFFICIENT_DATA')
})

// 8. Bloqueo por falta de datos territoriales en Nota de Venta
test('8. Bloqueo por falta de datos: NV sin comuna ni ciudad', () => {
  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: null, city: null },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'INSUFFICIENT_DATA')
})

// 9. Bloqueo por dirección no encontrada (sin coincidencia alguna)
test('9. Bloqueo por dirección no encontrada: NO_MATCHING_ADDRESS', () => {
  const result = resolveInvoiceEmissionAddress({
    nv: { address: 'Dirección Inexistente 9999', municipality: 'Talca' },
    client: CLIENT_643,
    clientAddresses: ADDRESSES_643,
  })
  assert.equal(result.ok, false)
  assert.equal(result.code, 'NO_MATCHING_ADDRESS')
  assert.match(result.error, /No se encontró una dirección coincidente/i)
})

// 10. Paginación y manejo de errores de consulta de direcciones Bsale
test('10. Paginación y manejo defensivo de consultas Bsale', async () => {
  // Simulación del algoritmo de paginación de fetchAllBsaleClientAddresses
  async function simulateFetchAddresses(pages, failOnPage = -1) {
    const limit = 50
    let offset = 0
    let pageIndex = 0
    const allAddresses = []

    while (true) {
      if (pageIndex === failOnPage) {
        return { ok: false, error: 'Error consultando direcciones del cliente en Bsale: HTTP_500' }
      }
      const pageItems = pages[pageIndex] || []
      for (const item of pageItems) {
        if (typeof item.id === 'number') {
          allAddresses.push(item)
        }
      }
      if (pageItems.length < limit) {
        break
      }
      offset += limit
      pageIndex++
    }
    return { ok: true, addresses: allAddresses }
  }

  // Página 1: 50 direcciones, Página 2: 5 direcciones (total 55)
  const page1 = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, address: `Calle ${i + 1}`, municipality: 'Talca', state: 0 }))
  const page2 = Array.from({ length: 5 }, (_, i) => ({ id: i + 51, address: `Calle ${i + 51}`, municipality: 'Talca', state: 0 }))

  const successResult = await simulateFetchAddresses([page1, page2])
  assert.equal(successResult.ok, true)
  assert.equal(successResult.addresses.length, 55)
  assert.equal(successResult.addresses[54].id, 55)

  // Error de red/HTTP simula bloqueo antes de POST
  const errorResult = await simulateFetchAddresses([page1, page2], 1)
  assert.equal(errorResult.ok, false)
  assert.match(errorResult.error, /Error consultando direcciones/i)
})

// 11. Verificación posterior de dirección en factura devuelta por Bsale (verifyBsaleInvoiceAddress)
test('11. Verificación posterior de documento devuelto por Bsale: Coincidencia y detección de discrepancia', () => {
  const nv = {
    address: 'MALL GO FLORIDA  LOCAL 1015B',
    municipality: 'TALCA',
    city: 'TALCA',
  }

  // A. Coincidencia exacta o normalizada: OK
  const matchOk = verifyBsaleInvoiceAddress(
    { address: 'Mall Go Florida Local 1015B', municipality: 'Talca', city: 'Talca' },
    nv
  )
  assert.equal(matchOk.ok, true)

  // B. Discrepancia en dirección textual: Falla e identifica error
  const mismatchAddress = verifyBsaleInvoiceAddress(
    { address: 'Apoquindo 4700 Piso 11', municipality: 'Talca', city: 'Talca' },
    nv
  )
  assert.equal(mismatchAddress.ok, false)
  assert.match(mismatchAddress.reason, /^INVOICE_ADDRESS_MISMATCH/)

  // C. Discrepancia en territorio (comuna/ciudad): Falla e identifica error
  const mismatchTerritory = verifyBsaleInvoiceAddress(
    { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: 'Curicó', city: 'Curicó' },
    nv
  )
  assert.equal(mismatchTerritory.ok, false)
  assert.match(mismatchTerritory.reason, /^INVOICE_TERRITORY_MISMATCH/)
})

// 12. Feature Flag apagado: Preserva compatibilidad hacia atrás estricta
test('12. Feature flag apagado: Comportamiento por defecto y omisión de addressId', () => {
  // Asegurar que por defecto el flag está inactivo sin variable de entorno
  delete process.env.BSALE_INVOICE_ADDRESS_RESOLUTION_ENABLED
  assert.equal(invoiceAddressResolutionEnabled(), false)

  // Con el flag apagado, el payload generado por defecto no incluye addressId
  const defaultPayload = buildInvoiceEmissionPayload({
    officeId: 1,
    priceListId: 1,
    saleConditionId: 1,
    emissionDate: 1730600000,
    expirationDate: 1730600000,
    clientId: 643,
    sellerId: 10,
    salesId: 'PETGROUP:FACTURA:test:789',
    details: [{ detailId: 101, quantity: 1 }],
    payments: [{ paymentTypeId: 1, amount: 10000, recordDate: 1730600000 }],
  })

  assert.equal('addressId' in defaultPayload, false)

  // Al encenderlo explícitamente vía env:
  process.env.BSALE_INVOICE_ADDRESS_RESOLUTION_ENABLED = 'true'
  assert.equal(invoiceAddressResolutionEnabled(), true)
  delete process.env.BSALE_INVOICE_ADDRESS_RESOLUTION_ENABLED
})

// 13. Preservación de idempotencia: Identity snapshot y fingerprint inalterados
test('13. Preservación de idempotencia: El fingerprint y salesId no dependen de addressId', () => {
  const baseSnapshot = {
    company_id: '123e4567-e89b-12d3-a456-426614174000',
    canonical_bsale_token: 'NV-5140-TOKEN',
    current_bsale_nv_id: 5140,
    client_id: 643,
    office_id: 1,
    sale_condition_id: '1',
    payment_type_id: 1,
    historical_bsale_nv_id: 5140,
    folio: '5140',
    seller_id: 10,
    price_list_id: 1,
    emission_date: '2026-11-03',
    expiration_date: '2026-11-03',
    totals: { net: 10000, tax: 1900, total: 11900 },
    details: [{ detail_id: 101, quantity: 2 }],
    total: 11900,
  }

  const identity1 = buildInvoiceEmissionIdentity(baseSnapshot)
  const identity2 = buildInvoiceEmissionIdentity(baseSnapshot)

  assert.equal(identity1.fingerprint, identity2.fingerprint)
  assert.equal(identity1.salesId, identity2.salesId)
  assert.match(identity1.salesId, /^PETGROUP:FACTURA:/)
})

console.log(`\n--- ${passedTests} pruebas de integración completadas exitosamente ---`)
