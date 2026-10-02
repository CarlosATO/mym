import { createAdminClient } from '@/lib/supabase/admin'
import type { SalesFamily, SalesFamilyMatrixResponse } from './finance-api'
import type { SalesFamilyGroupRule, NormalizedSalesFamilies } from './statement'
import { addMoney } from './money'

type StoredRule = SalesFamilyGroupRule & {
  company_id: string
}

function prefixOf(familyName: string) {
  const separator = familyName.indexOf('/')
  return separator > 0 ? familyName.slice(0, separator).trim() : null
}

function prefixKey(prefix: string) {
  return prefix.toLocaleLowerCase('es-CL')
}

function detectRepeatedPrefixes(families: SalesFamilyMatrixResponse['families']) {
  const candidates = new Map<string, string>()
  const counts = new Map<string, number>()
  for (const family of families) {
    const prefix = prefixOf(family.family_name)
    if (!prefix) continue
    const key = prefixKey(prefix)
    candidates.set(key, prefix)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([key]) => candidates.get(key)!)
}

const RULES_READ_TIMEOUT_MS = 1500

function withTimeout<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`La lectura de reglas excedió ${timeoutMs} ms.`)), timeoutMs)
    promise.then(value => {
      clearTimeout(timeout)
      resolve(value)
    }, error => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

export async function getFinancialFamilyGroupRules(companyId: string): Promise<SalesFamilyGroupRule[]> {
  const admin = createAdminClient()
  const db = admin.schema('comercial')
  try {
    const result = await withTimeout(
      db
        .from('financial_family_group_rules')
        .select('company_id, source_prefix, normalized_name, active')
        .eq('company_id', companyId),
      RULES_READ_TIMEOUT_MS,
    )
    if (result.error) throw new Error(`No se pudieron cargar las reglas de familias: ${result.error.message}`)
    return (result.data ?? []) as StoredRule[]
  } catch (error) {
    console.error('No se pudieron leer las reglas de agrupación; se usará el fallback determinista.', error)
    return []
  }
}

export function buildFinancialFamilyGroups(
  families: SalesFamilyMatrixResponse['families'],
  _rules: SalesFamilyGroupRule[],
): NormalizedSalesFamilies {
  void _rules
  const byProvider = new Map<string, {
    group_key: string
    group_name: string
    months: Record<string, string>
    ytd: string
    line_count: number
    children: Array<SalesFamily & { detail_name: string }>
  }>()
  for (const family of families) {
    const providerKey = family.provider_key ?? 'unassigned'
    const group = byProvider.get(providerKey) ?? {
      group_key: providerKey,
      group_name: family.provider_name ?? (providerKey === 'unassigned' ? 'SIN PROVEEDOR' : 'Proveedor sin nombre'),
      months: {},
      ytd: '0.00',
      line_count: 0,
      children: [],
    }
    for (const [month, amount] of Object.entries(family.months)) {
      group.months[month] = addMoney(group.months[month] ?? '0.00', amount) ?? '0.00'
    }
    group.ytd = addMoney(group.ytd, family.ytd) ?? '0.00'
    group.line_count += family.line_count
    group.children.push({ ...family, detail_name: family.family_name })
    byProvider.set(providerKey, group)
  }
  return {
    groups: [...byProvider.values()]
      .sort((left, right) => left.group_name.localeCompare(right.group_name, 'es-CL'))
      .map(group => ({
        ...group,
        children: group.children.sort((left, right) => left.family_name.localeCompare(right.family_name, 'es-CL')),
      })),
    individuals: [],
  }
}

export async function reconcileFinancialFamilyGroupRules(
  companyId: string,
  families: SalesFamilyMatrixResponse['families'],
): Promise<SalesFamilyGroupRule[]> {
  const repeatedPrefixes = detectRepeatedPrefixes(families)
  if (repeatedPrefixes.length === 0) return getFinancialFamilyGroupRules(companyId)

  const admin = createAdminClient()
  const { error } = await admin.schema('comercial').from('financial_family_group_rules').upsert(
    repeatedPrefixes.map(prefix => ({
      company_id: companyId,
      source_prefix: prefix,
      normalized_name: prefix,
      active: true,
    })),
    { onConflict: 'company_id,source_prefix', ignoreDuplicates: false },
  )
  if (error) throw new Error(`No se pudieron guardar las reglas de familias: ${error.message}`)
  return getFinancialFamilyGroupRules(companyId)
}
