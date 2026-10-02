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
}

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

const PERIOD_MONTHS = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC']
const PERIOD_MONTHS_FULL = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']

export function getCommonCoverage(
  sales: FinanceSalesNetResponse | null,
  cogs: FinanceCogsResponse | null,
  personnel: FinancePersonnelResponse | null,
  expenses: FinanceExpensesResponse | null,
  year = sales?.year ?? cogs?.year ?? personnel?.year ?? expenses?.year ?? 2026,
): CommonCoverage {
  const months: number[] = []
  for (let month = 1; month <= MONTH_COUNT; month += 1) {
    const salesMonth = sales?.months.find(item => item.month === month)
    const cogsMonth = cogs?.months.find(item => item.month === month)
    const personnelMonth = personnel?.months.find(item => item.month === month)
    const expenseMonth = expenses?.months.find(item => item.month === month)
    const available = Boolean(
      salesMonth?.amount !== null && salesMonth?.amount !== undefined
        // Cost coverage is shown separately; a calculated month is still part
        // of the common period when its cost source is marked incomplete.
        && cogsMonth?.net_cogs !== null && cogsMonth?.net_cogs !== undefined
        && personnelMonth?.status === 'AVAILABLE' && personnelMonth.totalPersonnel !== null
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
  const commonCoverage = getCommonCoverage(sales, cogs, personnel, expenses)

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
    const payrollMonths = visiblePersonnelMonths.filter(month => month.status === 'AVAILABLE')
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
      children: [
        child('Remuneraciones formales', month => month.formalEarnings, payrollMonths, payrollSalesYtd, true),
        child('Cargas del empleador', month => month.employerContributions, payrollMonths, payrollSalesYtd, true),
        child('Personal fuera de libro', month => month.offBook, visiblePersonnelMonths, visibleSalesYtd),
        child('Otros laborales', month => month.salariesOther, visiblePersonnelMonths, visibleSalesYtd),
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
    ): StatementRow => ({
      label,
      values: expenseMonths.map(month => month[field] as string | null),
      ytd: expenses.ytd[field] as string | null,
      percentageYtd: percentageOf(expenses.ytd[field] as string | null, expenseSalesYtd),
      missing,
      ytdMissing,
      ytdLabel: periodLabel,
      percentageLabel: `sobre ventas ${periodText}`,
      ytdTooltip: expenses.coverage.coverageStatus !== 'COMPLETE' ? `Fuente bancaria disponible hasta ${periodText}.` : undefined,
    })
    const operatingChildren = [
      expenseChild('Software y suscripciones', 'softwareSubscriptions'),
      expenseChild('Gastos de oficina y consumo interno', 'officeConsumption'),
      expenseChild('Combustible y gastos de vehículo', 'vehicleOperating'),
      expenseChild('Servicios notariales', 'notaryServices'),
      expenseChild('Gastos bancarios', 'bankFees'),
      expenseChild('Seguros', 'insurance'),
      expenseChild('Telecomunicaciones e Internet', 'telecom'),
      expenseChild('Servicios profesionales y externos', 'externalServices'),
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
      children: [expenseChild('Intereses y gastos financieros', 'financialInterest')],
    })
  }

  const commonValues = (values: Array<string | null>) => values.map((value, index) =>
    commonCoverage.months.includes(index + 1) ? value : null,
  )
  const sumCovered = (values: Array<string | null>) => {
    const covered = commonValues(values)
    return commonCoverage.months.length && covered.slice(0, commonCoverage.months.length).every(value => value !== null)
      ? sumMoney(covered)
      : null
  }
  const marginRow = rows.find(row => row.label === 'Margen Bruto')
  const personnelRow = rows.find(row => row.label === 'GASTOS DE PERSONAL')
  const operatingRow = rows.find(row => row.label === 'GASTOS OPERACIONALES IDENTIFICADOS')
  const financialRow = rows.find(row => row.label === 'GASTOS FINANCIEROS / NO OPERACIONALES')
  if (commonCoverage.months.length && marginRow && personnelRow && operatingRow && financialRow) {
    const coveredSales = sumCovered(salesValues)
    const operatingValues = commonValues(marginRow.values).map((margin, index) =>
      subtractMoney(subtractMoney(margin, commonValues(personnelRow.values)[index]), commonValues(operatingRow.values)[index]),
    )
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
    }
    const operationalIndex = rows.indexOf(operatingRow)
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
    }
    resultGerencial.ytd = sumCovered(resultGerencial.values)
    resultGerencial.percentageYtd = percentageOf(resultGerencial.ytd, coveredSales)
    rows.splice(rows.indexOf(financialRow) + 1, 0, resultGerencial)
  }

  return rows
}
