export type DailyStockState = 'CON_STOCK' | 'SIN_STOCK' | 'DESCONOCIDO'
export type ForecastModelName = 'SUAVIZAMIENTO_EXPONENCIAL_SIMPLE' | 'BASELINE_ULTIMA_SEMANA_VALIDA' | 'CROSTON' | 'SBA' | 'TSB' | 'MEDIA_MOVIL_SIMPLE' | 'MEDIA_MOVIL_PONDERADA'

export interface ForecastDay {
  date: string
  state: DailyStockState
  sales: number
  stateKnown: boolean
}

export interface ForecastWeek {
  weekStart: string
  sales: number
  salesWithStock: number
  demand: number | null
  daysWithStock: number
  daysWithoutStock: number
  daysUnknown: number
  evidenceCoverage: number
  validForTraining: boolean
  legacyValidForTraining: boolean
  days: ForecastDay[]
}

export interface ForecastModelResult {
  model: ForecastModelName
  mae: number | null
  wape: number | null
  mase: number | null
  origins: number
  forecastNextWeek: number | null
  forecastNext4Weeks: number[]
  valid: boolean
}

export interface SkuForecastResult {
  status: 'OK' | 'HISTORIAL INSUFICIENTE' | 'NO MEJORA SOBRE BASELINE'
  modelResults: ForecastModelResult[]
  selectedModel: ForecastModelName | null
  baseline: ForecastModelResult
  comparisonToBaseline: 'MEJORA' | 'NO MEJORA SOBRE BASELINE' | 'BASELINE INVALIDO'
  mae: number | null
  wape: number | null
  forecastNextWeek: number | null
  forecastNext4Weeks: number[]
  weeksAvailable: number
  weeksUsed: number
  weeksWithStockout: number
  weeksExcludedForEvidence: number
  weeks: ForecastWeek[]
}

const WINDOW = 4
const MIN_VALID_WEEKS = 8
const MIN_ORIGINS = 4
const MIN_KNOWN_DAYS = 4
const MIN_EVIDENCE_COVERAGE = 4 / 7
const SES_ALPHA = 0.3

export function reconstructDailyAvailability(input: {
  dateFrom: string
  dateTo: string
  events: Array<{ date: string; quantityDelta: number; stockAfter: number | null }>
}): ForecastDay[] {
  const rawByDate = new Map<string, RawDayState>()
  for (const event of input.events) {
    if (event.stockAfter === null) continue
    const day = rawByDate.get(event.date) || emptyRawDay()
    const stockBefore = event.stockAfter - event.quantityDelta
    day.hasPositive ||= event.stockAfter > 0 || stockBefore > 0
    day.hasZero ||= event.stockAfter <= 0
    day.edges.push({ from: stockBefore, to: event.stockAfter })
    rawByDate.set(event.date, day)
  }

  const days: ForecastDay[] = []
  let priorConfirmed: DailyStockState | null = null
  for (let cursor = parseDate(input.dateFrom); cursor <= parseDate(input.dateTo); cursor.setUTCDate(cursor.getUTCDate() + 1)) {
    const date = isoDate(cursor)
    const raw = rawByDate.get(date)
    const rawState = raw ? resolveRawState(raw) : null
    const state = rawState || priorConfirmed || 'DESCONOCIDO'
    const stateKnown = state !== 'DESCONOCIDO'
    if (rawState) priorConfirmed = rawState
    days.push({ date, state, sales: 0, stateKnown })
  }
  return days
}

export function buildWeeklyDemand(input: {
  dateFrom: string
  dateTo: string
  sales: Array<{ date: string; quantity: number }>
  stockEvents: Array<{ date: string; quantityDelta: number; stockAfter: number | null }>
}): ForecastWeek[] {
  const days = reconstructDailyAvailability({ dateFrom: input.dateFrom, dateTo: input.dateTo, events: input.stockEvents })
  const salesByDate = new Map<string, number>()
  for (const sale of input.sales) salesByDate.set(sale.date, (salesByDate.get(sale.date) || 0) + sale.quantity)
  for (const day of days) day.sales = salesByDate.get(day.date) || 0
  const legacyEvidenceByWeek = new Map<string, { evidence: boolean; stockout: boolean }>()
  for (const event of input.stockEvents) {
    if (event.stockAfter === null) continue
    const week = startOfWeek(event.date)
    const current = legacyEvidenceByWeek.get(week) || { evidence: false, stockout: false }
    current.evidence = true
    current.stockout ||= event.stockAfter <= 0
    legacyEvidenceByWeek.set(week, current)
  }

  const weeks: ForecastWeek[] = []
  const daysByDate = new Map(days.map(day => [day.date, day]))
  for (let cursor = parseDate(startOfWeek(input.dateFrom)); cursor <= parseDate(startOfWeek(input.dateTo)); cursor.setUTCDate(cursor.getUTCDate() + 7)) {
    const weekStart = isoDate(cursor)
    const slice: ForecastDay[] = []
    for (let offset = 0; offset < 7; offset++) {
      const date = new Date(cursor)
      date.setUTCDate(date.getUTCDate() + offset)
      const day = daysByDate.get(isoDate(date))
      if (day) slice.push(day)
    }
    if (!slice.length) continue
    const daysWithStock = slice.filter(day => day.state === 'CON_STOCK').length
    const daysWithoutStock = slice.filter(day => day.state === 'SIN_STOCK').length
    const daysUnknown = slice.filter(day => day.state === 'DESCONOCIDO').length
    const sales = slice.reduce((sum, day) => sum + day.sales, 0)
    const salesWithStock = slice.reduce((sum, day) => day.state === 'CON_STOCK' ? sum + day.sales : sum, 0)
    const evidenceCoverage = (daysWithStock + daysWithoutStock) / slice.length
    const validForTraining = daysWithStock >= MIN_KNOWN_DAYS && evidenceCoverage >= MIN_EVIDENCE_COVERAGE
    const legacy = legacyEvidenceByWeek.get(weekStart) || { evidence: false, stockout: false }
    weeks.push({
      weekStart,
      sales,
      salesWithStock,
      demand: validForTraining ? (salesWithStock / daysWithStock) * 7 : null,
      daysWithStock,
      daysWithoutStock,
      daysUnknown,
      evidenceCoverage,
      validForTraining,
      legacyValidForTraining: legacy.evidence && !legacy.stockout,
      days: slice,
    })
  }
  return weeks
}

export function forecastSku(weeks: ForecastWeek[]): SkuForecastResult {
  return evaluateForecast(weeks.filter(week => week.validForTraining).map(week => week.demand!), weeks, true)
}

export function forecastSkuBaseline(weeks: ForecastWeek[]): SkuForecastResult {
  const legacyWeeks = weeks.filter(week => week.legacyValidForTraining)
  return evaluateForecast(legacyWeeks.map(week => week.sales), weeks, false)
}

function evaluateForecast(demand: number[], weeks: ForecastWeek[], adjusted: boolean): SkuForecastResult {
  const candidateModels: ForecastModelName[] = ['SUAVIZAMIENTO_EXPONENCIAL_SIMPLE', 'CROSTON', 'SBA', 'TSB']
  const modelResults = candidateModels.map(model => evaluateModel(model, demand))
  const baseline = evaluateModel('BASELINE_ULTIMA_SEMANA_VALIDA', demand)
  const selected = [...modelResults, baseline]
    .filter(result => result.valid && result.wape !== null)
    .sort((left, right) => (left.wape! - right.wape!) || ((left.mae || 0) - (right.mae || 0)))[0]
  const enoughHistory = demand.length >= MIN_VALID_WEEKS && selected !== undefined
  const improvesBaseline = enoughHistory && baseline.valid && selected!.model !== baseline.model
  const status = !enoughHistory
    ? 'HISTORIAL INSUFICIENTE'
    : selected!.model === baseline.model ? 'NO MEJORA SOBRE BASELINE' : 'OK'
  const selectedForOutput = enoughHistory ? selected! : null
  return {
    status,
    modelResults,
    selectedModel: selectedForOutput?.model || null,
    baseline,
    comparisonToBaseline: !baseline.valid ? 'BASELINE INVALIDO' : selected!.model === baseline.model ? 'NO MEJORA SOBRE BASELINE' : 'MEJORA',
    mae: selectedForOutput?.mae ?? null,
    wape: selectedForOutput?.wape ?? null,
    forecastNextWeek: selectedForOutput?.forecastNextWeek ?? null,
    forecastNext4Weeks: selectedForOutput?.forecastNext4Weeks || [],
    weeksAvailable: weeks.length,
    weeksUsed: demand.length,
    weeksWithStockout: weeks.filter(week => week.daysWithoutStock > 0).length,
    weeksExcludedForEvidence: weeks.filter(week => !week.validForTraining && week.daysWithoutStock === 0).length,
    weeks: adjusted ? weeks : weeks,
  }
}

function evaluateModel(model: ForecastModelName, demand: number[]): ForecastModelResult {
  const actual: number[] = []
  const predicted: number[] = []
  const scaledErrors: number[] = []
  for (let origin = model === 'BASELINE_ULTIMA_SEMANA_VALIDA' ? 1 : WINDOW; origin < demand.length; origin++) {
    const prediction = predictNext(model, demand.slice(0, origin))
    if (prediction === null) continue
    actual.push(demand[origin])
    predicted.push(prediction)
    const scale = naiveScale(demand.slice(0, origin))
    if (scale !== null) scaledErrors.push(Math.abs(demand[origin] - prediction) / scale)
  }
  const errors = actual.map((value, index) => Math.abs(value - predicted[index]))
  const denominator = actual.reduce((sum, value) => sum + Math.abs(value), 0)
  const mae = errors.length > 0 ? errors.reduce((sum, value) => sum + value, 0) / errors.length : null
  const wape = errors.length > 0 && denominator > 0 ? errors.reduce((sum, value) => sum + value, 0) / denominator : null
  const mase = scaledErrors.length > 0 ? scaledErrors.reduce((sum, value) => sum + value, 0) / scaledErrors.length : null
  const valid = errors.length >= MIN_ORIGINS && wape !== null
  const forecastNext4Weeks = valid ? predictNext4(model, demand) : []
  return { model, mae, wape, mase, origins: errors.length, forecastNextWeek: forecastNext4Weeks[0] ?? null, forecastNext4Weeks, valid }
}

function predictNext(model: ForecastModelName, history: number[]) {
  if (model === 'BASELINE_ULTIMA_SEMANA_VALIDA') return history.length ? history[history.length - 1] : null
  if (model === 'MEDIA_MOVIL_SIMPLE') return history.length >= WINDOW ? average(history.slice(-WINDOW)) : null
  if (model === 'MEDIA_MOVIL_PONDERADA') {
    if (history.length < WINDOW) return null
    const values = history.slice(-WINDOW)
    const total = values.reduce((sum, _, index) => sum + index + 1, 0)
    return values.reduce((sum, value, index) => sum + value * (index + 1), 0) / total
  }
  if (model === 'CROSTON' || model === 'SBA') return crostonForecast(history, model === 'SBA')
  if (model === 'TSB') return tsbForecast(history)
  if (!history.length) return null
  let level = history[0]
  for (const value of history.slice(1)) level = SES_ALPHA * value + (1 - SES_ALPHA) * level
  return level
}

function predictNext4(model: ForecastModelName, original: number[]) {
  const history = [...original]
  const forecast: number[] = []
  for (let index = 0; index < 4; index++) {
    const next = predictNext(model, history)
    if (next === null) return []
    forecast.push(next)
    history.push(next)
  }
  return forecast
}

interface RawDayState { hasPositive: boolean; hasZero: boolean; edges: Array<{ from: number; to: number }> }

function emptyRawDay(): RawDayState { return { hasPositive: false, hasZero: false, edges: [] } }

function resolveRawState(day: RawDayState): DailyStockState | null {
  if (!day.edges.length) return null
  const degrees = new Map<number, { out: number; in: number }>()
  for (const edge of day.edges) {
    const from = degrees.get(edge.from) || { out: 0, in: 0 }
    from.out++
    degrees.set(edge.from, from)
    const to = degrees.get(edge.to) || { out: 0, in: 0 }
    to.in++
    degrees.set(edge.to, to)
  }
  const reached = new Set<number>([...degrees.keys()].slice(0, 1))
  const queue = [...reached]
  while (queue.length) {
    const node = queue.shift()!
    for (const edge of day.edges) {
      if (edge.from !== node && edge.to !== node) continue
      const next = edge.from === node ? edge.to : edge.from
      if (!reached.has(next)) { reached.add(next); queue.push(next) }
    }
  }
  const degreeValues = [...degrees.values()]
  const connected = reached.size === degrees.size
  const balanced = degreeValues.every(degree => Math.abs(degree.out - degree.in) <= 1)
  const starts = degreeValues.filter(degree => degree.out - degree.in === 1).length
  const ends = degreeValues.filter(degree => degree.in - degree.out === 1).length
  const complete = connected && balanced && ((starts === 0 && ends === 0) || (starts === 1 && ends === 1))
  if (complete) {
    const finalCount = starts === 1 ? 1 : degrees.size
    if (finalCount > 1) return 'DESCONOCIDO'
    const finalStock = starts === 1 ? [...degrees.entries()].find(([, degree]) => degree.in - degree.out === 1)![0] : Math.min(...degrees.keys())
    return finalStock <= 0 ? 'SIN_STOCK' : 'CON_STOCK'
  }
  if (day.hasPositive && day.hasZero) return 'DESCONOCIDO'
  if (day.hasZero) return 'SIN_STOCK'
  if (day.hasPositive) return 'CON_STOCK'
  return null
}

function average(values: number[]) { return values.reduce((sum, value) => sum + value, 0) / values.length }
function naiveScale(values: number[]) {
  if (values.length < 2) return null
  const differences = values.slice(1).map((value, index) => Math.abs(value - values[index]))
  const scale = average(differences)
  return scale > 0 ? scale : null
}

function crostonForecast(values: number[], biasCorrected: boolean) {
  const firstIndex = values.findIndex(value => value > 0)
  if (firstIndex < 0) return 0
  const alpha = 0.1
  let size = values[firstIndex]
  let interval = firstIndex + 1
  let gap = 1
  for (const value of values.slice(firstIndex + 1)) {
    if (value > 0) {
      size = alpha * value + (1 - alpha) * size
      interval = alpha * gap + (1 - alpha) * interval
      gap = 1
    } else {
      gap++
    }
  }
  const forecast = size / interval
  return biasCorrected ? forecast * (1 - alpha / 2) : forecast
}

function tsbForecast(values: number[]) {
  const firstIndex = values.findIndex(value => value > 0)
  if (firstIndex < 0) return 0
  const alpha = 0.1
  const beta = 0.1
  let size = values[firstIndex]
  let probability = 1 / (firstIndex + 1)
  for (const value of values.slice(firstIndex + 1)) {
    const occurrence = value > 0 ? 1 : 0
    probability = beta * occurrence + (1 - beta) * probability
    if (occurrence) size = alpha * value + (1 - alpha) * size
  }
  return probability * size
}
function parseDate(value: string) { return new Date(`${value}T00:00:00Z`) }
function isoDate(value: Date) { return value.toISOString().slice(0, 10) }
function startOfWeek(value: string) {
  const date = parseDate(value)
  const day = date.getUTCDay()
  date.setUTCDate(date.getUTCDate() - (day === 0 ? 6 : day - 1))
  return isoDate(date)
}
