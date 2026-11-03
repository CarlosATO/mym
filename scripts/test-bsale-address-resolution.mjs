/**
 * Suite de pruebas unitarias: Resolución determinística de direcciones Bsale (FAC-DIR-02A).
 *
 * Ejecución: node scripts/test-bsale-address-resolution.mjs
 */

import assert from 'node:assert/strict'
import {
  resolveBsaleClientAddress,
  normalizeBsaleAddressString,
  normalizeBsaleTerritoryString,
  evaluateAddressMatch,
  evaluateTerritoryMatch,
  verifyBsaleInvoiceAddress,
} from '../src/lib/integraciones/bsale-address-resolution.ts'

console.log('--- Iniciando suite de pruebas: FAC-DIR-02A ---')

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
// FIXTURES
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
  {
    id: 13,
    addressName: 'MIRAFLORES',
    address: 'SANTIAGO MIRAFLORES 419',
    municipality: 'SANTIAGO',
    city: 'SANTIAGO',
    state: 0,
  },
]

// Cliente 994
const CLIENT_994 = {
  address: 'Freire 854',
  commune: 'Constitución',
  city: 'Constitución',
}

const ADDRESSES_994 = [
  {
    id: 28,
    addressName: 'ACUARIO CENTER ROMERAL',
    address: 'Av. Livertad 1024 local 16',
    municipality: 'ROMERAL',
    city: 'ROMERAL',
    state: 0,
  },
  {
    id: 29,
    addressName: 'CASA MATRIZ',
    address: 'Av. Livertad 1024 local 16',
    municipality: 'CURICO',
    city: 'CURICO',
    state: 0,
  },
]

// Cliente 170
const CLIENT_170 = {
  address: '2 NORTE ESQ 30 ORIENTE',
  commune: 'TALCA',
  city: 'TALCA',
}

const ADDRESSES_170 = [
  {
    id: 9,
    addressName: 'LOCAL AV FLORIDA',
    address: '8 PONIENTE N ° 0267 SANTA MARIA DE COLIN',
    municipality: 'TALCA',
    city: 'TALCA',
    state: 0,
  },
]

// ==========================================
// TEST CASES
// ==========================================

test('1. Cliente 643: Resuelve exactamente Mall Go Florida (id 11)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'MALL GO FLORIDA  LOCAL 1015B',
      municipality: 'TALCA',
      city: 'TALCA',
    },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res.addressId, 11)
  assert.equal(res.precision, 'EXACT')
  assert.equal(res.matchedAddress?.id, 11)
})

test('2. Cliente 643: Resuelve exactamente Mall Brisas del Centro (id 12)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'MALL BRISAS DEL CENTRO LOCAL 4',
      municipality: 'TALCA',
      city: 'TALCA',
    },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res.addressId, 12)
  assert.equal(res.precision, 'EXACT')
  assert.equal(res.matchedAddress?.id, 12)
})

test('3. Cliente 643: Normalización conservadora (minúsculas y espacios colapsados)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'mall go florida local 1015b',
      municipality: 'talca',
    },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res.addressId, 11)
  assert.equal(res.precision, 'NORMALIZED')
})

test('4. Cliente 643: Normalización conservadora con puntuación (# y comas)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'Mall Go Florida, Local #1015B',
      municipality: 'Talca',
    },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res.addressId, 11)
  assert.equal(res.precision, 'NORMALIZED')
})

test('5. Cliente 643: Rechaza coincidencia parcial sin identificador de local', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'MALL GO FLORIDA',
      municipality: 'TALCA',
    },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'ADDRESS_NOT_FOUND')
  assert.equal(res.addressId, null)
  assert.equal(res.reason, 'NO_MATCHING_ADDRESS')
})

test('6. Cliente 643: No recurre a la dirección principal cuando difiere de la NV', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'Calle Nueva 999',
      municipality: 'TALCA',
    },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'ADDRESS_NOT_FOUND')
  assert.equal(res.addressId, null)
})

test('7. Cliente 994: Mismo texto de calle pero comuna Romeral (id 28)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'Av. Livertad 1024 local 16',
      municipality: 'ROMERAL',
    },
    client: CLIENT_994,
    bsaleAddresses: ADDRESSES_994,
  })

  assert.equal(res.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res.addressId, 28)
  assert.equal(res.matchedAddress?.municipality, 'ROMERAL')
})

test('8. Cliente 994: Mismo texto de calle pero comuna Curicó (id 29)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'Av. Livertad 1024 local 16',
      municipality: 'CURICO',
    },
    client: CLIENT_994,
    bsaleAddresses: ADDRESSES_994,
  })

  assert.equal(res.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res.addressId, 29)
  assert.equal(res.matchedAddress?.municipality, 'CURICO')
})

test('9. Cliente 994: Mismo texto de calle pero comuna no coincidente (Talca) -> Rechazado', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: 'Av. Livertad 1024 local 16',
      municipality: 'TALCA',
    },
    client: CLIENT_994,
    bsaleAddresses: ADDRESSES_994,
  })

  assert.equal(res.status, 'ADDRESS_NOT_FOUND')
  assert.equal(res.addressId, null)
})

test('10. Cliente 170: Normalización de abreviaturas complejas (N ° 0267)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: {
      address: '8 Poniente N°0267 Santa María de Colín',
      municipality: 'Talca',
    },
    client: CLIENT_170,
    bsaleAddresses: ADDRESSES_170,
  })

  assert.equal(res.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res.addressId, 9)
  assert.equal(res.precision, 'NORMALIZED')
})

test('11. Coincidencia ambigua: Múltiples direcciones adicionales activas idénticas', () => {
  const duplicateAddresses = [
    { id: 101, address: 'Los Alerces 500', municipality: 'CHILLAN', state: 0 },
    { id: 102, address: 'Los Alerces 500', municipality: 'CHILLAN', state: 0 },
  ]

  const res = resolveBsaleClientAddress({
    salesOrder: { address: 'Los Alerces 500', municipality: 'Chillán' },
    client: { address: 'Otra 123', commune: 'CHILLAN' },
    bsaleAddresses: duplicateAddresses,
  })

  assert.equal(res.status, 'AMBIGUOUS_MATCH')
  assert.equal(res.addressId, null)
  assert.deepEqual(res.candidateIds, [101, 102])
  assert.equal(res.reason, 'MULTIPLE_ACTIVE_ADDITIONAL_MATCHES')
})

test('12. Dirección inactiva: Rechaza candidate si state !== 0', () => {
  const inactiveAddresses = [
    { id: 201, address: 'Camino Viejo 450', municipality: 'LINARES', state: 1 },
  ]

  const res = resolveBsaleClientAddress({
    salesOrder: { address: 'Camino Viejo 450', municipality: 'Linares' },
    client: { address: 'Casa Matriz 1', commune: 'Linares' },
    bsaleAddresses: inactiveAddresses,
  })

  assert.equal(res.status, 'ADDRESS_NOT_FOUND')
  assert.equal(res.addressId, null)
  assert.equal(res.reason, 'MATCHING_ADDRESS_IS_INACTIVE')
  assert.deepEqual(res.candidateIds, [201])
})

test('13. Dirección principal coincidente normalizada (con #): Retorna PRIMARY_ADDRESS_MATCHED', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: { address: 'Freire #854', municipality: 'CONSTITUCION' },
    client: CLIENT_994,
    bsaleAddresses: ADDRESSES_994,
  })

  assert.equal(res.status, 'PRIMARY_ADDRESS_MATCHED')
  assert.equal(res.addressId, null)
  assert.equal(res.precision, 'NORMALIZED')
})

test('14. Dirección principal coincidente exacta', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: { address: 'Freire 854', municipality: 'Constitución' },
    client: CLIENT_994,
    bsaleAddresses: ADDRESSES_994,
  })

  assert.equal(res.status, 'PRIMARY_ADDRESS_MATCHED')
  assert.equal(res.addressId, null)
  assert.equal(res.precision, 'EXACT')
})

test('15. Datos insuficientes: NV sin dirección (null)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: { address: null, municipality: 'Talca' },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'INSUFFICIENT_DATA')
  assert.equal(res.reason, 'NV_ADDRESS_MISSING')
})

test('16. Datos insuficientes: NV con dirección en blanco ("   ")', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: { address: '   ', municipality: 'Talca' },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'INSUFFICIENT_DATA')
  assert.equal(res.reason, 'NV_ADDRESS_MISSING')
})

test('17. Datos insuficientes: NV sin comuna ni ciudad', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: null, city: null },
    client: CLIENT_643,
    bsaleAddresses: ADDRESSES_643,
  })

  assert.equal(res.status, 'INSUFFICIENT_DATA')
  assert.equal(res.reason, 'NV_TERRITORY_MISSING')
})

test('18. Sin coincidencia alguna: Cliente sin direcciones adicionales registradas (count: 0)', () => {
  const res = resolveBsaleClientAddress({
    salesOrder: { address: 'Arturo Prat 1410', municipality: 'Chillán' },
    client: { address: 'camino parque lantaño 373', commune: 'CHILLAN' },
    bsaleAddresses: [],
  })

  assert.equal(res.status, 'ADDRESS_NOT_FOUND')
  assert.equal(res.addressId, null)
  assert.equal(res.reason, 'NO_MATCHING_ADDRESS')
})

test('19. Aislamiento y pureza: Múltiples ejecuciones no comparten estado ni mutan entradas', () => {
  const originalInput = {
    salesOrder: Object.freeze({ address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: 'TALCA' }),
    client: Object.freeze({ ...CLIENT_643 }),
    bsaleAddresses: Object.freeze([...ADDRESSES_643]),
  }

  const res1 = resolveBsaleClientAddress(originalInput)
  const res2 = resolveBsaleClientAddress(originalInput)

  assert.deepEqual(res1, res2)
  assert.equal(res1.status, 'ADDITIONAL_ADDRESS_MATCHED')
  assert.equal(res1.addressId, 11)
})

test('20. Dirección con state: null (no presumida activa, FAC-DIR-02B): Rechazada', () => {
  const nullStateAddresses = [
    { id: 301, address: 'Avenida España 1234', municipality: 'TALCA', state: null },
  ]

  const res = resolveBsaleClientAddress({
    salesOrder: { address: 'Avenida España 1234', municipality: 'TALCA' },
    client: { address: 'Otra Calle 999', commune: 'TALCA' },
    bsaleAddresses: nullStateAddresses,
  })

  assert.equal(res.status, 'ADDRESS_NOT_FOUND')
  assert.equal(res.reason, 'MATCHING_ADDRESS_IS_INACTIVE')
  assert.deepEqual(res.candidateIds, [301])
})

test('21. Verificación posterior de factura emitida (verifyBsaleInvoiceAddress): Coincidencia y discrepancia', () => {
  const expectedNv = {
    address: 'MALL GO FLORIDA  LOCAL 1015B',
    municipality: 'TALCA',
    city: 'TALCA',
  }

  // Coincidencia normalizada válida
  const okResult = verifyBsaleInvoiceAddress(
    { address: 'Mall Go Florida Local 1015B', municipality: 'Talca', city: 'Talca' },
    expectedNv
  )
  assert.equal(okResult.ok, true)

  // Discrepancia en dirección
  const mismatchAddr = verifyBsaleInvoiceAddress(
    { address: 'Mall Brisas del Centro Local 4', municipality: 'Talca', city: 'Talca' },
    expectedNv
  )
  assert.equal(mismatchAddr.ok, false)
  assert.match(mismatchAddr.reason, /^INVOICE_ADDRESS_MISMATCH/)

  // Discrepancia en comuna/ciudad
  const mismatchTerr = verifyBsaleInvoiceAddress(
    { address: 'MALL GO FLORIDA  LOCAL 1015B', municipality: 'Curicó', city: 'Curicó' },
    expectedNv
  )
  assert.equal(mismatchTerr.ok, false)
  assert.match(mismatchTerr.reason, /^INVOICE_TERRITORY_MISMATCH/)
})

console.log(`\n--- ${passedTests} pruebas completadas exitosamente ---`)
