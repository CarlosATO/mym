import type { CatalogUserOption, OfficeOption, VariantOption, WarehouseOption } from '@/app/actions/inventarios/sessions'

export interface GeneralData {
  name: string
  inventory_type: string
  warehouse_id: string
  bsale_office_id: string
  responsible_user_id: string
  scope_mode: 'GENERAL' | 'PARTIAL'
}

export interface ScopeData {
  variant_ids: number[]
}

export interface WizardData {
  general: GeneralData
  scope: ScopeData
}

export interface WizardCatalogs {
  warehouses: WarehouseOption[]
  offices: OfficeOption[]
  users: CatalogUserOption[]
}

export const EMPTY_GENERAL: GeneralData = {
  name: '',
  inventory_type: '',
  warehouse_id: '',
  bsale_office_id: '',
  responsible_user_id: '',
  scope_mode: 'GENERAL',
}

export const EMPTY_SCOPE: ScopeData = {
  variant_ids: [],
}

export const EMPTY_WIZARD_DATA: WizardData = {
  general: { ...EMPTY_GENERAL },
  scope: { ...EMPTY_SCOPE },
}

export function selectedVariantsByIds(
  variantIds: number[],
  variants: VariantOption[]
): VariantOption[] {
  const byId = new Map(variants.map(v => [v.bsale_variant_id, v]))
  return variantIds.map(id => byId.get(id)).filter((v): v is VariantOption => Boolean(v))
}
