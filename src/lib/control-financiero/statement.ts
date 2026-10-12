import type { FinanceCogsResponse, FinanceExpensesResponse, FinanceExpensesTotals, FinancePersonnelResponse, FinanceSalesNetResponse, SalesFamily, SalesFamilyGroup } from './finance-api'
// @ts-expect-error Standalone Node harnesses use explicit TypeScript extensions.
import { percentageOf, subtractMoney, sumMoney } from './money.ts'

const MONTH_COUNT = 12

export type StatementRow = {
  label: string
  values: (string | null)[]
  ytd: string | null
  percentageYtd: number | null
  missing: (number | null)[]
  ytdMissing: number | null
  ytdLabel?: string
  percentageLabel?: string
  ytdTooltip?: string
  emphasis?: boolean
  result?: boolean
  group?: boolean
  children?: StatementRow[]
  sectionKey?: 'personnel' | 'operating-expenses' | 'non-operating-expenses'
  drilldownKey?: StatementDrilldownKey
  estimated?: boolean[]
  ytdEstimated?: boolean
  confirmedYtd?: string | null
  confirmedPercentageYtd?: number | null
  confirmedCoverage?: CommonCoverage
  estimateAsOfDate?: string | null
  provisional?: boolean
  provisionalNote?: string
}

export type StatementDrilldownKey =
  | 'PERSONNEL_GROUP'
  | 'PERSONNEL_FORMAL'
  | 'PERSONNEL_EMPLOYER'
  | 'PERSONNEL_OFF_BOOK'
  | 'PERSONNEL_OTHER'
  | 'OPERATING_GROUP'
  | 'EXPENSE_SOFTWARE_SUBSCRIPTIONS'
  | 'EXPENSE_OFFICE_CONSUMPTION'
  | 'EXPENSE_VEHICLE_OPERATING'
  | 'EXPENSE_NOTARY'
  | 'EXPENSE_BANK_FEES'
  | 'EXPENSE_INSURANCE'
  | 'EXPENSE_TELECOM'
   | 'EXPENSE_EXTERNAL_SERVICES'
   | 'EXPENSE_OTHER'
   | 'EXPENSE_REIMBURSEMENTS'
   | 'EXPENSE_SERVIPAG_SERVICES'
   | 'EXPENSE_SERVICE_COLLECTION_PAYMENTS'
  | 'NON_OPERATING_GROUP'
  | 'EXPENSE_FINANCIAL_INTEREST'
  | 'OTHER_INCOME'

export type SalesNetDetailScope = { month: number } | { month: null }

export type SalesFamilyRow = SalesFamily & {
  percentageYtd: number | null
}

export type SalesFamilyGroupRule = {
  source_prefix: string
  normalized_name: string
  active: boolean
}

export type NormalizedSalesFamilies = {
  groups: SalesFamilyGroup[]
  individuals: SalesFamily[]
}

export type CommonCoverage = {
  months: number[]
  throughMonth: number | null
  label: string
  text: string
}

/** expenses.dataThrough is the last bank-statement transaction, not a daily processing watermark. */
export function getManagerialAsOfDate(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
  todayInChile: string,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayInChile)) return null
  const month = Number(todayInChile.slice(5, 7))
  const year = Number(todayInChile.slice(0, 4))
  if (sales?.year !== year || cogs?.year !== year
    || sales.months.find(item => item.month === month)?.amount == null
    || cogs.months.find(item => item.month === month)?.coverage_status !== 'COMPLETE'
    || cogs.months.find(item => item.month === month)?.net_cogs == null) return null
  const prefix = todayInChile.slice(0, 7)
  if (!sales.data_through?.startsWith(`${prefix}-`) || !cogs.data_through?.startsWith(`${prefix}-`)) return null
  return [todayInChile, sales.data_through, cogs.data_through].sort()[0]
}

function accruedClp(monthly: string, elapsedDays: number, daysInMonth: number): string {
  const whole = BigInt(monthly.split('.')[0])
  const numerator = whole * BigInt(elapsedDays)
  const denominator = BigInt(daysInMonth)
  const absolute = numerator < BigInt(0) ? -numerator : numerator
  const rounded = (absolute + denominator / BigInt(2)) / denominator
  return String(numerator < BigInt(0) ? -rounded : rounded)
}

/** Return a derived EERR personnel view; the API's monthly average remains unmodified. */
export function accrueOpenMonthPersonnel(
  personnel: FinancePersonnelResponse | null,
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
  todayInChile: string,
): FinancePersonnelResponse | null {
  if (!personnel) return null
  const asOf = getManagerialAsOfDate(sales, cogs, todayInChile)
  if (!asOf || personnel.year !== Number(asOf.slice(0, 4))) return personnel
  const month = Number(asOf.slice(5, 7))
  const elapsedDays = Number(asOf.slice(8, 10))
  const daysInMonth = new Date(Date.UTC(personnel.year, month, 0)).getUTCDate()
  return {
    ...personnel,
    months: personnel.months.map(item => {
      if (item.month !== month || item.status !== 'ESTIMATED' || item.formalEarnings === null || item.employerContributions === null) return item
      const formalEarnings = accruedClp(item.formalEarnings, elapsedDays, daysInMonth)
      const employerContributions = accruedClp(item.employerContributions, elapsedDays, daysInMonth)
      const formalLaborCost = sumMoney([formalEarnings, employerContributions])
      return {
        ...item,
        monthlyFormalEstimate: item.formalEarnings,
        monthlyEmployerEstimate: item.employerContributions,
        estimateAsOfDate: asOf,
        estimateElapsedDays: elapsedDays,
        estimateDaysInMonth: daysInMonth,
        formalEarnings,
        employerContributions,
        formalLaborCost,
        totalPersonnel: sumMoney([formalLaborCost, item.offBook, item.salariesOther]),
      }
    }),
  }
}

export function buildPersonnelEstimateDetails(
  personnel: FinancePersonnelResponse,
  throughMonth: number,
  month: number | null,
) {
  return personnel.months
    .filter(item => item.status === 'ESTIMATED' && (month === null ? item.month <= throughMonth : item.month === month))
    .map(item => ({ month: item.month, formalEarnings: item.formalEarnings!, employerContributions: item.employerContributions!, sources: item.estimateSources,
      monthlyFormalEstimate: item.monthlyFormalEstimate ?? item.formalEarnings!, monthlyEmployerEstimate: item.monthlyEmployerEstimate ?? item.employerContributions!,
      asOfDate: item.estimateAsOfDate ?? null, elapsedDays: item.estimateElapsedDays ?? null, daysInMonth: item.estimateDaysInMonth ?? null }))
}

const PERIOD_MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
const PERIOD_MONTHS_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

export function getCommonCoverage(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
  personnel: FinancePersonnelResponse | null,
  expenses: FinanceExpensesResponse | null,
  year = sales?.year ?? cogs?.year ?? personnel?.year ?? expenses?.year ?? 2026,
): CommonCoverage {
  return getConfirmedCoverage(sales, cogs, personnel, expenses, year)
}

function coverageFor(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
  personnel: FinancePersonnelResponse | null,
  expenses: FinanceExpensesResponse | null,
  year: number,
  managerial: boolean,
): CommonCoverage {
  const months: number[] = []
  for (let month = 1; month <= MONTH_COUNT; month += 1) {
    const salesMonth = sales?.months.find(item => item.month === month)
    const cogsMonth = cogs?.months.find(item => item.month === month)
    const personnelMonth = personnel?.months.find(item => item.month === month)
    const expenseMonth = expenses?.months.find(item => item.month === month)
    const available = Boolean(
      salesMonth?.amount !== null && salesMonth?.amount !== undefined
        // Only a complete COGS month can participate in the common result.
        && cogsMonth?.net_cogs !== null && cogsMonth?.net_cogs !== undefined
        && cogsMonth.coverage_status === 'COMPLETE'
         && (personnelMonth?.status === 'AVAILABLE' || (managerial && personnelMonth?.status === 'ESTIMATED')) && personnelMonth.totalPersonnel !== null
        && expenseMonth?.status === 'AVAILABLE'
        && expenseMonth.operatingIdentifiedTotal !== null
        && expenseMonth.nonOperatingIdentifiedTotal !== null,
    )
    if (!available) break
    months.push(month)
  }
  const throughMonth = months.at(-1) ?? null
  return {
    months,
    throughMonth,
    label: throughMonth ? `ACUMULADO DISPONIBLE · ENE–${PERIOD_MONTHS[throughMonth - 1]}` : 'ACUMULADO DISPONIBLE',
    text: throughMonth ? `enero–${PERIOD_MONTHS_FULL[throughMonth - 1]} ${year}` : `sin cobertura común ${year}`,
  }
}

export function getConfirmedCoverage(sales: FinanceSalesNetResponse | null, cogs: FinanceCogsResponse | null, personnel: FinancePersonnelResponse | null, expenses: FinanceExpensesResponse | null, year = sales?.year ?? cogs?.year ?? personnel?.year ?? expenses?.year ?? 2026): CommonCoverage {
  return coverageFor(sales, cogs, personnel, expenses, year, false)
}

export function getManagerialCoverage(sales: FinanceSalesNetResponse | null, cogs: FinanceCogsResponse | null, personnel: FinancePersonnelResponse | null, expenses: FinanceExpensesResponse | null, year = sales?.year ?? cogs?.year ?? personnel?.year ?? expenses?.year ?? 2026): CommonCoverage {
  return coverageFor(sales, cogs, personnel, expenses, year, true)
}

export function buildSalesFamilyRows(
  families: SalesFamily[],
  salesYtd: string | null,
): SalesFamilyRow[] {
  return [...families]
    .sort((left, right) => left.family_name.localeCompare(right.family_name, 'es-CL'))
    .map(family => ({
      ...family,
      percentageYtd: salesYtd && Number(salesYtd) !== 0
        ? (Number(family.ytd) / Number(salesYtd)) * 100
        : null,
    }))
}

function familyPrefix(familyName: string) {
  const separator = familyName.indexOf('/')
  return separator > 0 ? familyName.slice(0, separator).trim() : null
}

export function familyDetailName(familyName: string) {
  const separator = familyName.indexOf('/')
  return separator > 0 ? familyName.slice(separator + 1).trim() : familyName
}

function sourcePrefixKey(prefix: string) {
  return prefix.toLocaleLowerCase('es-CL')
}

function groupFromChildren(groupKey: string, groupName: string, children: SalesFamily[]): SalesFamilyGroup {
  const monthKeys = [...new Set(children.flatMap(child => Object.keys(child.months)))].sort((left, right) => Number(left) - Number(right))
  const months = Object.fromEntries(monthKeys.map(month => [
    month,
    sumMoney(children.map(child => child.months[month] ?? null)),
  ]))
  return {
    group_key: groupKey,
    group_name: groupName,
    months,
    ytd: sumMoney(children.map(child => child.ytd)),
    line_count: children.reduce((total, child) => total + child.line_count, 0),
    children: children.map(child => ({ ...child, detail_name: familyDetailName(child.family_name) })),
  }
}

export function buildUnassignedSalesFamilyGroup(families: SalesFamily[]): SalesFamilyGroup {
  return groupFromChildren(
    'synthetic:unassigned',
    'SIN AGRUPACIÓN',
    [...families].sort((left, right) => left.family_name.localeCompare(right.family_name, 'es-CL')),
  )
}

export function normalizeSalesFamilies(
  families: SalesFamily[],
  rules: SalesFamilyGroupRule[],
): NormalizedSalesFamilies {
  const activeRules = new Map(
    rules
      .filter(rule => rule.active)
      .map(rule => [sourcePrefixKey(rule.source_prefix), rule]),
  )
  const repeatedPrefixes = new Map<string, { prefix: string; count: number }>()
  for (const family of families) {
    const prefix = familyPrefix(family.family_name)
    if (!prefix) continue
    const key = sourcePrefixKey(prefix)
    const current = repeatedPrefixes.get(key) ?? { prefix, count: 0 }
    current.count += 1
    repeatedPrefixes.set(key, current)
  }
  const grouped = new Map<string, { prefix: string; name: string; children: SalesFamily[] }>()
  const individuals: SalesFamily[] = []

  for (const family of families) {
    const prefix = familyPrefix(family.family_name)
    const key = prefix ? sourcePrefixKey(prefix) : null
    const rule = key ? activeRules.get(key) : undefined
    const fallback = key ? (repeatedPrefixes.get(key)?.count ?? 0) >= 2 : false
    if (!prefix || (!rule && !fallback)) {
      individuals.push(family)
      continue
    }
    const current = grouped.get(key!) ?? {
      prefix,
      name: rule?.normalized_name ?? prefix,
      children: [],
    }
    current.children.push(family)
    grouped.set(key!, current)
  }

  const groups = [...grouped.values()]
    .map(group => ({
      ...groupFromChildren(`prefix:${sourcePrefixKey(group.prefix)}`, group.name, [...group.children].sort((left, right) => familyDetailName(left.family_name).localeCompare(familyDetailName(right.family_name), 'es-CL'))),
    }))
    .sort((left, right) => left.group_name.localeCompare(right.group_name, 'es-CL'))

  individuals.sort((left, right) => left.family_name.localeCompare(right.family_name, 'es-CL'))
  return { groups, individuals }
}

export function getSalesNetDetailScope(columnIndex: number, value: string | null): SalesNetDetailScope | null {
  if (value === null) return null
  return columnIndex === 12 ? { month: null } : columnIndex < 12 ? { month: columnIndex + 1 } : null
}

export function hasStatementInformation(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
  personnel: FinancePersonnelResponse | null = null,
  expenses: FinanceExpensesResponse | null = null,
) {
  return Boolean(
    sales?.has_information
      || sales?.months.some(month => month.amount !== null)
      || cogs?.has_information
      || cogs?.months.some(month => month.net_cogs !== null || month.gross_cogs !== null || month.credit_note_reversal !== null)
      || personnel !== null
      || expenses !== null
  )
}

export function buildStatementRows(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
  personnel: FinancePersonnelResponse | null = null,
  reportThroughMonth = MONTH_COUNT,
  expenses: FinanceExpensesResponse | null = null,
): StatementRow[] {
  const emptyMonths = Array.from({ length: MONTH_COUNT }, () => null)
  const salesValues = sales?.months.map(month => month.amount) ?? emptyMonths
  const salesYtd = sales?.total_ytd ?? null
  const cogsMonths = cogs?.months ?? Array.from({ length: MONTH_COUNT }, (_, index) => ({
    month: index + 1,
    net_cogs: null,
    missing_document_count: null,
  }))
  const cogsValues = cogsMonths.map(month => month.net_cogs)
  const cogsMissing = cogsMonths.map(month => month.missing_document_count)
  const grossMargin = salesValues.map((value, index) => subtractMoney(value, cogsValues[index]))
  const marginYtd = subtractMoney(salesYtd, cogs?.ytd.net_cogs ?? null)
  const confirmedCoverage = getConfirmedCoverage(sales, cogs, personnel, expenses)
  const commonCoverage = getManagerialCoverage(sales, cogs, personnel, expenses)
  const estimatedMonths = personnel?.months.map(month => month.status === 'ESTIMATED') ?? Array.from({ length: MONTH_COUNT }, () => false)
  const estimateAsOfDate = personnel?.months.find(month => month.estimateAsOfDate)?.estimateAsOfDate ?? null

  const rows: StatementRow[] = [
    { label: 'Ventas Netas', values: salesValues, ytd: salesYtd, percentageYtd: percentageOf(salesYtd, salesYtd), missing: emptyMonths, ytdMissing: null },
    { label: 'Costo de Ventas', values: cogsValues, ytd: cogs?.ytd.net_cogs ?? null, percentageYtd: percentageOf(cogs?.ytd.net_cogs ?? null, salesYtd), missing: cogsMissing, ytdMissing: cogs?.ytd.missing_document_count ?? null },
    { label: 'Margen Bruto', values: grossMargin, ytd: marginYtd, percentageYtd: percentageOf(marginYtd, salesYtd), missing: cogsMissing, ytdMissing: cogs?.ytd.missing_document_count ?? null, emphasis: true },
  ]

  const sumKnown = (values: Array<string | null>, requireValue = false) => {
    if (values.length === 0) return null
    if (requireValue && values.some(value => value === null)) return null
    return sumMoney(values)
  }
  const salesFor = (months: Array<{ month: number }>) =>
    sumKnown(months.map(month => salesValues[month.month - 1] ?? null), true)

  if (personnel) {
    const personnelMonths = personnel.months
    const visiblePersonnelMonths = personnelMonths.filter(month => month.month <= reportThroughMonth)
    const payrollMonths = visiblePersonnelMonths.filter(month => month.status === 'AVAILABLE' || month.status === 'ESTIMATED')
    const missing = personnelMonths.map(month => month.month <= reportThroughMonth && month.status === 'MISSING' ? 1 : null)
    const ytdMissing = visiblePersonnelMonths.filter(month => month.status === 'MISSING').length || null
    const sumPersonnel = (
      value: (month: FinancePersonnelResponse['months'][number]) => string | null,
      months: FinancePersonnelResponse['months'] = payrollMonths,
    ) => sumKnown(months.map(value), months.length === 0)
    const payrollSalesYtd = salesFor(payrollMonths)
    const visibleSalesYtd = salesFor(visiblePersonnelMonths)
    const periodMonths = payrollMonths.map(month => month.month)
    const periodLabel = periodMonths.length
      ? `ACUMULADO DISPONIBLE · ENE–${PERIOD_MONTHS[periodMonths[periodMonths.length - 1] - 1]}`
      : 'ACUMULADO DISPONIBLE'
    const periodText = periodMonths.length
      ? `enero–${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][periodMonths[periodMonths.length - 1] - 1]} ${personnel.year}`
      : `sin remuneraciones disponibles ${personnel.year}`
    const child = (
      label: string,
      value: (month: FinancePersonnelResponse['months'][number]) => string | null,
      ytdMonths: FinancePersonnelResponse['months'],
      denominator: string | null,
      incomplete = false,
      drilldownKey?: StatementDrilldownKey,
    ): StatementRow => ({
      label,
      values: personnelMonths.map(value),
      ytd: sumPersonnel(value, ytdMonths),
      percentageYtd: percentageOf(sumPersonnel(value, ytdMonths), denominator),
      missing: label === 'Remuneraciones formales' || label === 'Cargas del empleador' ? missing : emptyMonths,
      ytdMissing: incomplete ? ytdMissing : null,
       ytdLabel: incomplete ? periodLabel : `ACUMULADO · ENE–${PERIOD_MONTHS[reportThroughMonth - 1]}`,
      percentageLabel: incomplete ? `sobre ventas ${periodText}` : `sobre ventas enero–${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][reportThroughMonth - 1]}`,
      ytdTooltip: incomplete ? `Fuente disponible hasta ${periodText}.` : undefined,
      drilldownKey,
      estimated: personnelMonths.map(month => (label === 'Remuneraciones formales' ? month.formalEarningsEstimated : label === 'Cargas del empleador' ? month.employerContributionsEstimated : false) ?? false),
      ytdEstimated: (label === 'Remuneraciones formales' || label === 'Cargas del empleador') && ytdMonths.some(month => month.status === 'ESTIMATED'),
      estimateAsOfDate: label === 'Remuneraciones formales' || label === 'Cargas del empleador' ? estimateAsOfDate : null,
      confirmedYtd: label === 'Remuneraciones formales' || label === 'Cargas del empleador' ? sumPersonnel(value, personnelMonths.filter(month => confirmedCoverage.months.includes(month.month))) : undefined,
    })

    rows.push({
      label: 'GASTOS DE PERSONAL',
      values: personnelMonths.map(month => month.totalPersonnel),
      ytd: sumPersonnel(month => month.totalPersonnel),
      percentageYtd: percentageOf(sumPersonnel(month => month.totalPersonnel), payrollSalesYtd),
      missing,
      ytdMissing,
      ytdLabel: periodLabel,
      percentageLabel: `sobre ventas ${periodText}`,
      ytdTooltip: `Acumulado disponible ${periodText}. Faltan remuneraciones de los meses restantes del período mostrado para completar YTD.`,
      group: true,
      sectionKey: 'personnel',
      drilldownKey: 'PERSONNEL_GROUP',
      estimated: estimatedMonths,
      ytdEstimated: payrollMonths.some(month => month.status === 'ESTIMATED'),
      estimateAsOfDate,
      confirmedYtd: sumPersonnel(month => month.totalPersonnel, personnelMonths.filter(month => confirmedCoverage.months.includes(month.month))),
      children: [
        child('Remuneraciones formales', month => month.formalEarnings, payrollMonths, payrollSalesYtd, true, 'PERSONNEL_FORMAL'),
        child('Cargas del empleador', month => month.employerContributions, payrollMonths, payrollSalesYtd, true, 'PERSONNEL_EMPLOYER'),
        child('Personal fuera de libro', month => month.offBook, visiblePersonnelMonths, visibleSalesYtd, false, 'PERSONNEL_OFF_BOOK'),
        child('Otros laborales', month => month.salariesOther, visiblePersonnelMonths, visibleSalesYtd, false, 'PERSONNEL_OTHER'),
      ],
    })
  }

  if (expenses) {
    const expenseMonths = expenses.months
    const availableMonths = expenseMonths.filter(month => month.status === 'AVAILABLE')
    const missing = expenseMonths.map(month => month.status === 'MISSING' ? 1 : null)
    const ytdMissing = expenseMonths.filter(month => month.month <= reportThroughMonth && month.status === 'MISSING').length || null
    const expenseSalesYtd = salesFor(availableMonths)
    const lastMonth = expenses.coverage.latestAvailableMonth
    const periodText = lastMonth
      ? `enero–${['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'][lastMonth - 1]} ${expenses.year}`
      : `sin gastos identificados disponibles ${expenses.year}`
    const periodLabel = lastMonth
      ? `ACUMULADO DISPONIBLE · ENE–${PERIOD_MONTHS[lastMonth - 1]}`
      : 'ACUMULADO DISPONIBLE'
    const expenseChild = (
      label: string,
      field: keyof FinanceExpensesTotals,
      drilldownKey: StatementDrilldownKey,
    ): StatementRow => ({
      label,
      values: expenseMonths.map(month => month.status === 'AVAILABLE' ? month[field] as string | null : null),
      ytd: expenses.ytd[field] as string | null,
      percentageYtd: percentageOf(expenses.ytd[field] as string | null, expenseSalesYtd),
      missing,
      ytdMissing,
      ytdLabel: periodLabel,
      percentageLabel: `sobre ventas ${periodText}`,
      ytdTooltip: expenses.coverage.coverageStatus !== 'COMPLETE' ? `Fuente bancaria disponible hasta ${periodText}.` : undefined,
      drilldownKey,
    })
    const otherIncomeRow: StatementRow = {
      label: 'Otros ingresos',
      values: expenseMonths.map(month => month.status === 'AVAILABLE' ? month.otherIncome ?? '0' : null),
      ytd: expenses.ytd.otherIncome ?? '0',
      percentageYtd: percentageOf(expenses.ytd.otherIncome ?? '0', expenseSalesYtd),
      missing,
      ytdMissing,
      ytdLabel: periodLabel,
      percentageLabel: `sobre ventas ${periodText}`,
      ytdTooltip: expenses.coverage.coverageStatus !== 'COMPLETE' ? `Fuente de entradas externas disponible hasta ${periodText}.` : undefined,
      drilldownKey: 'OTHER_INCOME',
    }
    rows.push(otherIncomeRow)
    const operatingChildren = [
      expenseChild('Software y suscripciones', 'softwareSubscriptions', 'EXPENSE_SOFTWARE_SUBSCRIPTIONS'),
      expenseChild('Gastos de oficina y consumo interno', 'officeConsumption', 'EXPENSE_OFFICE_CONSUMPTION'),
      expenseChild('Combustible y gastos de vehículo', 'vehicleOperating', 'EXPENSE_VEHICLE_OPERATING'),
      expenseChild('Servicios notariales', 'notaryServices', 'EXPENSE_NOTARY'),
      expenseChild('Gastos bancarios', 'bankFees', 'EXPENSE_BANK_FEES'),
      expenseChild('Seguros', 'insurance', 'EXPENSE_INSURANCE'),
      expenseChild('Telecomunicaciones e Internet', 'telecom', 'EXPENSE_TELECOM'),
      expenseChild('Servicios profesionales y externos', 'externalServices', 'EXPENSE_EXTERNAL_SERVICES'),
      expenseChild('Otros gastos reconocidos', 'otherExpenses', 'EXPENSE_OTHER'),
      expenseChild('Reembolsos de gastos / rendiciones', 'reimbursements', 'EXPENSE_REIMBURSEMENTS'),
      expenseChild('Servicios Servipag', 'servipagServices', 'EXPENSE_SERVIPAG_SERVICES'),
      {
        ...expenseChild('Recaudación y pago de servicios', 'serviceCollectionPayments', 'EXPENSE_SERVICE_COLLECTION_PAYMENTS'),
        provisional: true,
        provisionalNote: 'Clasificación provisional: requiere validación documental para determinar la naturaleza definitiva del gasto.',
      },
    ]
    rows.push({
      label: 'GASTOS OPERACIONALES IDENTIFICADOS',
      values: expenseMonths.map(month => month.operatingIdentifiedTotal),
      ytd: expenses.ytd.operatingIdentifiedTotal,
      percentageYtd: percentageOf(expenses.ytd.operatingIdentifiedTotal, expenseSalesYtd),
      missing,
      ytdMissing,
      ytdLabel: periodLabel,
      percentageLabel: `sobre ventas ${periodText}`,
      ytdTooltip: `Gastos operacionales: cobertura parcial. Se muestran sólo partidas identificadas con impacto en resultados. Fuente bancaria disponible hasta ${periodText}.`,
      group: true,
      sectionKey: 'operating-expenses',
      drilldownKey: 'OPERATING_GROUP',
      children: operatingChildren,
    })
    rows.push({
      label: 'GASTOS FINANCIEROS / NO OPERACIONALES',
      values: expenseMonths.map(month => month.nonOperatingIdentifiedTotal),
      ytd: expenses.ytd.nonOperatingIdentifiedTotal,
      percentageYtd: percentageOf(expenses.ytd.nonOperatingIdentifiedTotal, expenseSalesYtd),
      missing,
      ytdMissing,
      ytdLabel: periodLabel,
      percentageLabel: `sobre ventas ${periodText}`,
      ytdTooltip: expenses.coverage.coverageStatus !== 'COMPLETE' ? `Fuente bancaria disponible hasta ${periodText}.` : undefined,
      group: true,
      sectionKey: 'non-operating-expenses',
      drilldownKey: 'NON_OPERATING_GROUP',
      children: [expenseChild('Intereses y gastos financieros', 'financialInterest', 'EXPENSE_FINANCIAL_INTEREST')],
    })
  }

  const commonValues = (values: Array<string | null>, coverage = commonCoverage) => values.map((value, index) =>
    coverage.months.includes(index + 1) ? value : null,
  )
  const sumCovered = (values: Array<string | null>, coverage = commonCoverage) => {
    const covered = commonValues(values, coverage)
    return coverage.months.length && covered.slice(0, coverage.months.length).every(value => value !== null)
      ? sumMoney(covered)
      : null
  }
  const marginRow = rows.find(row => row.label === 'Margen Bruto')
  const personnelRow = rows.find(row => row.label === 'GASTOS DE PERSONAL')
  const operatingRow = rows.find(row => row.label === 'GASTOS OPERACIONALES IDENTIFICADOS')
  const financialRow = rows.find(row => row.label === 'GASTOS FINANCIEROS / NO OPERACIONALES')
  const otherIncomeRow = rows.find(row => row.drilldownKey === 'OTHER_INCOME')

  const addKnownExpenses = (left: string | null, right: string | null) =>
    left == null || right == null ? null : sumMoney([left, right])
  const totalOperatingSales = personnelRow && operatingRow
    ? salesValues.filter((value, index) => value !== null && personnelRow.values[index] !== null && operatingRow.values[index] !== null)
    : []
  const totalOperatingSalesYtd = totalOperatingSales.length ? sumMoney(totalOperatingSales) : null
  const totalOperatingRow = personnelRow && operatingRow
    ? {
        label: 'TOTAL GASTOS OPERATIVOS',
        values: personnelRow.values.map((value, index) => addKnownExpenses(value, operatingRow.values[index])),
        ytd: addKnownExpenses(personnelRow.ytd, operatingRow.ytd),
        percentageYtd: percentageOf(addKnownExpenses(personnelRow.ytd, operatingRow.ytd), totalOperatingSalesYtd),
        missing: personnelRow.missing.map((value, index) => value ?? operatingRow.missing[index]),
        ytdMissing: personnelRow.ytdMissing ?? operatingRow.ytdMissing,
        ytdLabel: operatingRow.ytdLabel,
        percentageLabel: `sobre ventas ${salesYtd ? 'YTD' : 'período disponible'}`,
        estimated: personnelRow.estimated?.map((estimated, index) => estimated || Boolean(operatingRow.estimated?.[index])),
        ytdEstimated: Boolean(personnelRow.ytdEstimated || operatingRow.ytdEstimated),
        estimateAsOfDate: personnelRow.estimateAsOfDate ?? operatingRow.estimateAsOfDate,
        emphasis: true,
      }
    : null
  if (totalOperatingRow && operatingRow) rows.splice(rows.indexOf(operatingRow) + 1, 0, totalOperatingRow)

  if (commonCoverage.months.length && marginRow && personnelRow && operatingRow && financialRow) {
    const coveredSales = sumCovered(salesValues)
    const operatingValues = commonValues(marginRow.values).map((margin, index) => {
      const afterExpenses = subtractMoney(subtractMoney(margin, commonValues(personnelRow.values)[index]), commonValues(operatingRow.values)[index])
      return afterExpenses === null
        ? null
        : sumMoney([afterExpenses, otherIncomeRow ? commonValues(otherIncomeRow.values)[index] : null])
    })
    const resultOperational: StatementRow = {
      label: 'RESULTADO OPERACIONAL',
      values: operatingValues,
      ytd: sumCovered(operatingValues),
      percentageYtd: percentageOf(sumCovered(operatingValues), coveredSales),
      missing: emptyMonths,
      ytdMissing: null,
      ytdLabel: commonCoverage.label,
      percentageLabel: `sobre ventas ${commonCoverage.text}`,
      result: true,
      estimated: estimatedMonths,
      ytdEstimated: commonCoverage.months.some(month => estimatedMonths[month - 1]),
      estimateAsOfDate,
      confirmedYtd: sumCovered(operatingValues, confirmedCoverage),
      confirmedPercentageYtd: percentageOf(sumCovered(operatingValues, confirmedCoverage), sumCovered(salesValues, confirmedCoverage)),
      confirmedCoverage,
    }
    const operationalIndex = totalOperatingRow ? rows.indexOf(totalOperatingRow) : rows.indexOf(operatingRow)
    rows.splice(operationalIndex + 1, 0, resultOperational)
    const resultGerencial: StatementRow = {
      label: 'RESULTADO GERENCIAL',
      values: operatingValues.map((value, index) => subtractMoney(value, commonValues(financialRow.values)[index])),
      ytd: null,
      percentageYtd: null,
      missing: emptyMonths,
      ytdMissing: null,
      ytdLabel: commonCoverage.label,
      percentageLabel: `sobre ventas ${commonCoverage.text}`,
      result: true,
      estimated: estimatedMonths,
      ytdEstimated: commonCoverage.months.some(month => estimatedMonths[month - 1]),
      estimateAsOfDate,
      confirmedCoverage,
    }
    resultGerencial.ytd = sumCovered(resultGerencial.values)
    resultGerencial.percentageYtd = percentageOf(resultGerencial.ytd, coveredSales)
    resultGerencial.confirmedYtd = sumCovered(resultGerencial.values, confirmedCoverage)
    resultGerencial.confirmedPercentageYtd = percentageOf(resultGerencial.confirmedYtd, sumCovered(salesValues, confirmedCoverage))
    rows.splice(rows.indexOf(financialRow) + 1, 0, resultGerencial)
  }

  return rows
}
