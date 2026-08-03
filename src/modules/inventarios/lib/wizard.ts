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
  sessionId?: string | null
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

export const DRAFT_STORAGE_KEY = 'mym.inventory.wizardDraft'

export function loadWizardDraft(): WizardData | null {
  if (typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(DRAFT_STORAGE_KEY)
    if (!raw) return null
    return JSON.parse(raw) as WizardData
  } catch {
    return null
  }
}

export function saveWizardDraft(data: WizardData): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(data))
  } catch {
    // localStorage no disponible
  }
}

export function clearWizardDraft(): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.removeItem(DRAFT_STORAGE_KEY)
  } catch {
    // ignorar
  }
}

export function ensureDraftIdempotencyKey(companyId: string, sessionId?: string | null): string {
  if (typeof window === 'undefined') return ''
  const stableKey = sessionId ? `session:${sessionId}` : `company:${companyId}:unnamed`
  const stored = window.sessionStorage.getItem(stableKey)
  if (stored) return stored
  const generated = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  window.sessionStorage.setItem(stableKey, generated)
  return generated
}

export function selectedVariantsByIds(
  variantIds: number[],
  variants: VariantOption[]
): VariantOption[] {
  const byId = new Map(variants.map(v => [v.bsale_variant_id, v]))
  return variantIds.map(id => byId.get(id)).filter((v): v is VariantOption => Boolean(v))
}
