/**
 * Resolución determinística de direcciones Bsale (FAC-DIR-02A).
 *
 * Determina qué addressId de un cliente corresponde a la dirección de su Nota de Venta.
 * Módulo puramente funcional: sin efectos secundarios, sin llamadas de red y sin mutaciones.
 */

export interface BsaleAddressInput {
  address?: string | null
  municipality?: string | null
  commune?: string | null
  city?: string | null
}

export interface BsaleAdditionalAddressItem {
  id: number
  addressName?: string | null
  address: string
  municipality?: string | null
  city?: string | null
  state?: number | null
}

export type BsaleAddressResolutionStatus =
  | 'ADDITIONAL_ADDRESS_MATCHED'
  | 'PRIMARY_ADDRESS_MATCHED'
  | 'ADDRESS_NOT_FOUND'
  | 'AMBIGUOUS_MATCH'
  | 'INSUFFICIENT_DATA'

export type BsaleAddressMatchPrecision = 'EXACT' | 'NORMALIZED'

export interface BsaleAddressResolutionResult {
  status: BsaleAddressResolutionStatus
  addressId: number | null
  matchedAddress: BsaleAdditionalAddressItem | null
  precision: BsaleAddressMatchPrecision | null
  candidateIds?: number[]
  reason?: string
}

export interface ResolveBsaleClientAddressInput {
  salesOrder: BsaleAddressInput
  client: BsaleAddressInput | null | undefined
  bsaleAddresses?: BsaleAdditionalAddressItem[] | null | undefined
}

/**
 * Normaliza cadenas de dirección preservando números e identificadores de local (e.g. "LOCAL 1015B", "DPTO 249").
 * Remueve diacríticos, normaliza espacios, minúsculas y puntuación equivalente (#, N°, etc.).
 */
export function normalizeBsaleAddressString(input: string | null | undefined): string {
  if (!input) return ''
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\b(n\s*[º°.]|no\.|numero|num\.)\s*(?=\d)/gi, ' ')
    .replace(/[#.,º°/\\()\-–—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Normaliza nombres territoriales (comuna, ciudad).
 */
export function normalizeBsaleTerritoryString(input: string | null | undefined): string {
  if (!input) return ''
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[#.,º°/\\()\-–—_]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Evalúa si la dirección textual coincide de forma exacta o normalizada.
 * Rechaza coincidencias parciales o subcadenas.
 */
export function evaluateAddressMatch(
  nvAddressRaw: string | null | undefined,
  candAddressRaw: string | null | undefined
): { matched: boolean; precision: BsaleAddressMatchPrecision | null } {
  if (!nvAddressRaw || !candAddressRaw) {
    return { matched: false, precision: null }
  }

  const rawTrimmedNv = nvAddressRaw.trim()
  const rawTrimmedCand = candAddressRaw.trim()

  if (rawTrimmedNv === rawTrimmedCand) {
    return { matched: true, precision: 'EXACT' }
  }

  const normNv = normalizeBsaleAddressString(nvAddressRaw)
  const normCand = normalizeBsaleAddressString(candAddressRaw)

  if (normNv && normCand && normNv === normCand) {
    return { matched: true, precision: 'NORMALIZED' }
  }

  return { matched: false, precision: null }
}

/**
 * Evalúa la coincidencia geográfica entre la Nota de Venta y la dirección candidata.
 * - Si ambas tienen comuna, deben coincidir estrictamente.
 * - Si alguna carece de comuna, utiliza la ciudad como desempate.
 * - Rechaza si hay diferencia de comuna o datos insuficientes.
 */
export function evaluateTerritoryMatch(
  nvTerritory: { commune?: string | null; city?: string | null },
  candTerritory: { commune?: string | null; city?: string | null }
): { ok: boolean; reason?: string } {
  const nvCommune = normalizeBsaleTerritoryString(nvTerritory.commune)
  const nvCity = normalizeBsaleTerritoryString(nvTerritory.city)
  const candCommune = normalizeBsaleTerritoryString(candTerritory.commune)
  const candCity = normalizeBsaleTerritoryString(candTerritory.city)

  // 1. Ambas especifican comuna: deben coincidir estrictamente
  if (nvCommune && candCommune) {
    if (nvCommune !== candCommune) {
      return { ok: false, reason: `COMMUNE_MISMATCH:${nvCommune}_VS_${candCommune}` }
    }
    // Regla Finding 2: Si ambas ciudades están informadas y son distintas, no considerar suficiente la comuna
    if (nvCity && candCity && nvCity !== candCity) {
      return { ok: false, reason: `CITY_MISMATCH_WITH_MATCHING_COMMUNE:${nvCity}_VS_${candCity}` }
    }
    return { ok: true }
  }

  // 2. NV especifica comuna y candidato solo ciudad
  if (nvCommune && candCity && !candCommune) {
    if (nvCommune === candCity) {
      return { ok: true }
    }
    return { ok: false, reason: `COMMUNE_CITY_MISMATCH:${nvCommune}_VS_${candCity}` }
  }

  // 3. NV solo especifica ciudad y candidato especifica comuna
  if (nvCity && !nvCommune && candCommune) {
    if (nvCity === candCommune) {
      return { ok: true }
    }
    return { ok: false, reason: `CITY_COMMUNE_MISMATCH:${nvCity}_VS_${candCommune}` }
  }

  // 4. Ambas solo especifican ciudad
  if (nvCity && candCity) {
    if (nvCity === candCity) {
      return { ok: true }
    }
    return { ok: false, reason: `CITY_MISMATCH:${nvCity}_VS_${candCity}` }
  }

  return { ok: false, reason: 'INSUFFICIENT_TERRITORIAL_DATA' }
}

/**
 * Función pura de resolución de dirección de cliente Bsale.
 */
export function resolveBsaleClientAddress(
  input: ResolveBsaleClientAddressInput
): BsaleAddressResolutionResult {
  const normNvAddr = normalizeBsaleAddressString(input.salesOrder.address)
  const nvCommune = input.salesOrder.municipality || input.salesOrder.commune
  const nvCity = input.salesOrder.city
  const normNvCommune = normalizeBsaleTerritoryString(nvCommune)
  const normNvCity = normalizeBsaleTerritoryString(nvCity)

  // Validación de datos mínimos de la Nota de Venta
  if (!normNvAddr) {
    return {
      status: 'INSUFFICIENT_DATA',
      addressId: null,
      matchedAddress: null,
      precision: null,
      reason: 'NV_ADDRESS_MISSING',
    }
  }

  if (!normNvCommune && !normNvCity) {
    return {
      status: 'INSUFFICIENT_DATA',
      addressId: null,
      matchedAddress: null,
      precision: null,
      reason: 'NV_TERRITORY_MISSING',
    }
  }

  // Explorar colección de direcciones adicionales del cliente en Bsale
  const activeMatches: Array<{ item: BsaleAdditionalAddressItem; precision: BsaleAddressMatchPrecision }> = []
  const inactiveMatches: Array<{ item: BsaleAdditionalAddressItem; precision: BsaleAddressMatchPrecision }> = []

  const additionalList = Array.isArray(input.bsaleAddresses) ? input.bsaleAddresses : []

  for (const item of additionalList) {
    const addrMatch = evaluateAddressMatch(input.salesOrder.address, item.address)
    if (!addrMatch.matched || !addrMatch.precision) continue

    const territoryMatch = evaluateTerritoryMatch(
      { commune: nvCommune, city: nvCity },
      { commune: item.municipality, city: item.city }
    )
    if (!territoryMatch.ok) continue

    // Regla estricta FAC-DIR-02B: únicamente state === 0 se considera activo.
    // state !== 0, así como null o undefined, no se presumen activos automáticamente.
    const isActive = item.state === 0
    if (isActive) {
      activeMatches.push({ item, precision: addrMatch.precision })
    } else {
      inactiveMatches.push({ item, precision: addrMatch.precision })
    }
  }

  // Explorar dirección principal del cliente
  let primaryMatch: { precision: BsaleAddressMatchPrecision } | null = null
  if (input.client?.address) {
    const clientCommune = input.client.commune || input.client.municipality
    const clientCity = input.client.city
    const addrMatch = evaluateAddressMatch(input.salesOrder.address, input.client.address)
    if (addrMatch.matched && addrMatch.precision) {
      const territoryMatch = evaluateTerritoryMatch(
        { commune: nvCommune, city: nvCity },
        { commune: clientCommune, city: clientCity }
      )
      if (territoryMatch.ok) {
        primaryMatch = { precision: addrMatch.precision }
      }
    }
  }

  // Resolución determinística por prioridad:

  // 1. Múltiples coincidencias activas adicionales -> AMBIGUOUS_MATCH
  if (activeMatches.length > 1) {
    return {
      status: 'AMBIGUOUS_MATCH',
      addressId: null,
      matchedAddress: null,
      precision: null,
      candidateIds: activeMatches.map(m => m.item.id),
      reason: 'MULTIPLE_ACTIVE_ADDITIONAL_MATCHES',
    }
  }

  // 2. Coincidencia única activa adicional -> ADDITIONAL_ADDRESS_MATCHED
  if (activeMatches.length === 1) {
    const match = activeMatches[0]
    return {
      status: 'ADDITIONAL_ADDRESS_MATCHED',
      addressId: match.item.id,
      matchedAddress: match.item,
      precision: match.precision,
    }
  }

  // 3. Coincidencia con dirección principal -> PRIMARY_ADDRESS_MATCHED
  if (primaryMatch) {
    return {
      status: 'PRIMARY_ADDRESS_MATCHED',
      addressId: null,
      matchedAddress: null,
      precision: primaryMatch.precision,
    }
  }

  // 4. Coincidencia con dirección inactiva -> ADDRESS_NOT_FOUND (rechazo de inactiva)
  if (inactiveMatches.length > 0) {
    return {
      status: 'ADDRESS_NOT_FOUND',
      addressId: null,
      matchedAddress: null,
      precision: null,
      candidateIds: inactiveMatches.map(m => m.item.id),
      reason: 'MATCHING_ADDRESS_IS_INACTIVE',
    }
  }

  // 5. Sin coincidencia -> ADDRESS_NOT_FOUND
  return {
    status: 'ADDRESS_NOT_FOUND',
    addressId: null,
    matchedAddress: null,
    precision: null,
    reason: 'NO_MATCHING_ADDRESS',
  }
}

/**
 * Verificación posterior (FAC-DIR-02B, Regla 7 y Cierre de Auditoría):
 * Comprueba que el documento devuelto por Bsale contenga dirección, comuna y ciudad
 * coincidentes con la Nota de Venta esperada.
 *
 * Reglas de integridad:
 * 1. La dirección textual debe estar presente en ambos documentos y coincidir de forma exacta o normalizada.
 * 2. Si la NV especifica comuna, la factura devuelta debe informarla obligatoriamente (INVOICE_TERRITORY_UNVERIFIABLE).
 * 3. Si la NV especifica ciudad, la factura devuelta debe informarla obligatoriamente (INVOICE_TERRITORY_UNVERIFIABLE).
 * 4. Si la NV carece de todo dato territorial o la factura carece de ambos, se rechaza como no verificable.
 * 5. Si ambas comunas y/o ciudades están informadas, se evalúan con evaluateTerritoryMatch.
 *    Cualquier discrepancia (incluyendo comuna igual pero ciudad distinta) deriva en ok: false para conciliación.
 */
export function verifyBsaleInvoiceAddress(
  invoice: { address?: string | null; municipality?: string | null; city?: string | null },
  expectedNv: BsaleAddressInput
): { ok: true } | { ok: false; reason: string } {
  if (!expectedNv?.address || !invoice?.address) {
    return {
      ok: false,
      reason: `INVOICE_ADDRESS_UNVERIFIABLE: missing address data (expected="${expectedNv?.address ?? ''}" got="${invoice?.address ?? ''}")`,
    }
  }

  const addrMatch = evaluateAddressMatch(expectedNv.address, invoice.address)
  if (!addrMatch.matched) {
    return {
      ok: false,
      reason: `INVOICE_ADDRESS_MISMATCH: expected="${expectedNv.address}" got="${invoice.address}"`,
    }
  }

  const nvCommune = expectedNv.municipality || expectedNv.commune
  const invoiceCommune = invoice.municipality
  const nvCity = expectedNv.city
  const invoiceCity = invoice.city

  const normNvCommune = normalizeBsaleTerritoryString(nvCommune)
  const normNvCity = normalizeBsaleTerritoryString(nvCity)
  const normInvoiceCommune = normalizeBsaleTerritoryString(invoiceCommune)
  const normInvoiceCity = normalizeBsaleTerritoryString(invoiceCity)

  // Si la NV carece de todo dato territorial -> INVOICE_TERRITORY_UNVERIFIABLE
  if (!normNvCommune && !normNvCity) {
    return {
      ok: false,
      reason: `INVOICE_TERRITORY_UNVERIFIABLE: sales order missing all territorial data (expected="${nvCommune ?? ''}/${nvCity ?? ''}")`,
    }
  }

  // Si la factura carece de todo dato territorial -> INVOICE_TERRITORY_UNVERIFIABLE
  if (!normInvoiceCommune && !normInvoiceCity) {
    return {
      ok: false,
      reason: `INVOICE_TERRITORY_UNVERIFIABLE: invoice missing all territorial data (got="${invoiceCommune ?? ''}/${invoiceCity ?? ''}")`,
    }
  }

  // Si la NV especifica comuna, la factura debe informarla obligatoriamente para verificarla
  if (normNvCommune && !normInvoiceCommune) {
    return {
      ok: false,
      reason: `INVOICE_TERRITORY_UNVERIFIABLE: invoice missing commune required by sales order (expected="${nvCommune}" got null/empty)`,
    }
  }

  // Si la NV especifica ciudad, la factura debe informarla obligatoriamente para verificarla
  if (normNvCity && !normInvoiceCity) {
    return {
      ok: false,
      reason: `INVOICE_TERRITORY_UNVERIFIABLE: invoice missing city required by sales order (expected="${nvCity}" got null/empty)`,
    }
  }

  const territoryMatch = evaluateTerritoryMatch(
    { commune: nvCommune, city: nvCity },
    { commune: invoiceCommune, city: invoiceCity }
  )
  if (!territoryMatch.ok) {
    return {
      ok: false,
      reason: `INVOICE_TERRITORY_MISMATCH: ${territoryMatch.reason ?? 'TERRITORY_MISMATCH'} (expected="${nvCommune ?? ''}/${nvCity ?? ''}" got="${invoiceCommune ?? ''}/${invoiceCity ?? ''}")`,
    }
  }

  return { ok: true }
}
