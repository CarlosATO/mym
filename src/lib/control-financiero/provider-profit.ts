import type { FinanceProviderCogs, FinanceProviderFamilyCogs, SalesFamilyGroup } from './finance-api'
// @ts-expect-error Standalone Node harnesses use explicit TypeScript extensions.
import { percentageOf, subtractMoney } from './money.ts'

export type ProviderProfitabilityLoadState = 'READY' | 'VALID_EMPTY' | 'INCOMPLETE'

export function providerProfitabilityLoadState(
  salesYtd: string | number | null | undefined,
  salesFamilyCount: number,
  providers: FinanceProviderCogs[],
  families: FinanceProviderFamilyCogs[],
): ProviderProfitabilityLoadState {
  const hasSalesActivity = Number(salesYtd ?? 0) > 0
  if (!hasSalesActivity && providers.length === 0 && families.length === 0) return 'VALID_EMPTY'
  if (hasSalesActivity && (providers.length === 0 || (salesFamilyCount > 0 && families.length === 0))) return 'INCOMPLETE'
  return 'READY'
}

/**
 * Provider gross margin is sales net of the provider's own assigned COGS.
 * It never distributes the global COGS proportionally: each provider receives
 * only the cost previously attributed to its provider_key (the validated engine).
 * Providers without a resolved COGS keep null so the UI shows "—" instead of a
 * fabricated margin.
 */
export function applyProviderProfit(
  groups: SalesFamilyGroup[],
  providers: FinanceProviderCogs[],
  families: FinanceProviderFamilyCogs[],
): SalesFamilyGroup[] {
  const byKey = new Map(providers.map(provider => [provider.provider_key, provider]))
  const familyByKey = new Map(families.map(family => [family.family_key, family]))
  return groups.map(group => {
    const cogsYtd = byKey.get(group.group_key)?.net_cogs_ytd ?? null
    const profitYtd = cogsYtd === null ? null : subtractMoney(group.ytd, cogsYtd)
    return {
      ...group,
      children: group.children.map(child => {
        const familyCogs = familyByKey.get(child.family_key)?.net_cogs_ytd ?? null
        const familyProfit = familyCogs === null ? null : subtractMoney(child.ytd, familyCogs)
        return {
          ...child,
          cogsYtd: familyCogs,
          profitYtd: familyProfit,
          profitPercentageYtd: familyProfit === null ? null : percentageOf(familyProfit, child.ytd),
        }
      }),
      cogsYtd,
      profitYtd,
      profitPercentageYtd: profitYtd === null ? null : percentageOf(profitYtd, group.ytd),
    }
  })
}
