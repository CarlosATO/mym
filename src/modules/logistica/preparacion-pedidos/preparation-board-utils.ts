export type PreparationSort = 'default' | 'nv' | 'date' | 'comuna'

export type PreparationSearchableCard = {
  card_id: string
  nv_folio: string | number
  client_name: string | null
  normalized_city?: string | null
  city_raw?: string | null
  municipality_raw?: string | null
  address_raw?: string | null
  seller_name?: string | null
  nv_emission_date?: string | null
  route_date?: string | null
  status?: string | null
  total_quantity?: number | null
}

export type PreparationSelectionSummary = {
  nvCount: number
  units: number
  comunas: string[]
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

function normalizeFolio(value: string | number | null | undefined): string {
  return String(value ?? '').toLowerCase().trim()
}

function dateTokens(value: string | null | undefined): string[] {
  if (!value) return []

  const tokens = [value]
  const isoCandidate = value.slice(0, 10)

  if (/^\d{4}-\d{2}-\d{2}$/.test(isoCandidate)) {
    const [year, month, day] = isoCandidate.split('-')
    tokens.push(
      `${day}-${month}-${year}`,
      `${day}/${month}/${year}`,
      `${day}${month}${year}`,
    )
  }

  return tokens
}

export function getPreparationComuna(card: PreparationSearchableCard): string {
  const comuna = card.normalized_city?.trim()
    || card.municipality_raw?.trim()
    || card.city_raw?.trim()
  return comuna || 'SIN COMUNA'
}

export function matchesPreparationSearch(
  card: PreparationSearchableCard,
  searchTerm: string,
): boolean {
  const terms = normalizeText(searchTerm).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true

  const haystack = normalizeText([
    String(card.nv_folio),
    card.client_name,
    card.normalized_city,
    card.municipality_raw,
    card.city_raw,
    card.address_raw,
    card.seller_name,
    ...dateTokens(card.nv_emission_date),
    ...dateTokens(card.route_date),
  ].filter(Boolean).join(' '))

  return terms.every(term => haystack.includes(term))
}

function compareFolio(a: PreparationSearchableCard, b: PreparationSearchableCard): number {
  const folioA = Number(a.nv_folio)
  const folioB = Number(b.nv_folio)

  if (Number.isFinite(folioA) && Number.isFinite(folioB) && folioA !== folioB) {
    return folioA - folioB
  }

  return normalizeFolio(a.nv_folio).localeCompare(normalizeFolio(b.nv_folio), 'es')
}

function compareDate(a: PreparationSearchableCard, b: PreparationSearchableCard): number {
  const timeA = a.nv_emission_date ? new Date(a.nv_emission_date).getTime() : Number.MAX_SAFE_INTEGER
  const timeB = b.nv_emission_date ? new Date(b.nv_emission_date).getTime() : Number.MAX_SAFE_INTEGER

  if (timeA !== timeB) return timeA - timeB
  return compareFolio(a, b)
}

export function sortPreparationCards<T extends PreparationSearchableCard>(
  cards: T[],
  sort: PreparationSort,
): T[] {
  if (sort === 'default') return [...cards]

  return [...cards].sort((a, b) => {
    if (sort === 'nv') return compareFolio(a, b)

    if (sort === 'date') return compareDate(a, b)

    const comunaA = normalizeText(getPreparationComuna(a))
    const comunaB = normalizeText(getPreparationComuna(b))
    const comunaComparison = comunaA.localeCompare(comunaB, 'es')

    if (comunaComparison !== 0) return comunaComparison
    return compareDate(a, b)
  })
}

export function prunePreparationSelection<T extends PreparationSearchableCard>(
  selectedIds: ReadonlySet<string>,
  cards: T[],
): Set<string> {
  if (selectedIds.size === 0) return new Set()

  const selectableIds = new Set(
    cards
      .filter(card => card.status === 'PENDING_ROUTE_PREP')
      .map(card => card.card_id),
  )

  const next = new Set<string>()
  for (const id of selectedIds) {
    if (selectableIds.has(id)) next.add(id)
  }
  return next
}

export function summarizePreparationSelection<T extends PreparationSearchableCard>(
  cards: T[],
): PreparationSelectionSummary {
  const units = cards.reduce(
    (total, card) => total + Number(card.total_quantity ?? 0),
    0,
  )
  const comunas = [...new Set(cards.map(getPreparationComuna))].sort((a, b) => a.localeCompare(b, 'es'))

  return { nvCount: cards.length, units, comunas }
}

export function groupCardsByComuna<T extends PreparationSearchableCard>(
  cards: T[],
): Array<{ comuna: string; cards: T[] }> {
  const groups: Array<{ comuna: string; cards: T[] }> = []

  for (const card of cards) {
    const comuna = getPreparationComuna(card)
    const last = groups[groups.length - 1]

    if (last && normalizeText(last.comuna) === normalizeText(comuna)) {
      last.cards.push(card)
    } else {
      groups.push({ comuna, cards: [card] })
    }
  }

  return groups
}
