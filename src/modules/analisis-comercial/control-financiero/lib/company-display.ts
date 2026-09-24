import type { Company } from '@/app/actions/companies'

const CAYLO_ALIASES = new Set([
  'DISTRIBUIDORA MYM',
  'DISTRIBUIDORA MYM SPA',
  'MYM DISTRIBUIDORA',
  'MYM DISTRIBUIDORA SPA',
])

const AMIMASCOTA_ALIASES = new Set([
  'AMIMASCOTA',
  'AMIMASCOTA SPA',
  'AMIMASCOTAS',
  'AMIMASCOTAS SPA',
])

function normalizeCompanyLabel(value: string | null | undefined) {
  return (value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toUpperCase()
}

export function getFinancialCompanyDisplayName(company: Pick<Company, 'business_name' | 'trade_name'> | null) {
  if (!company) return 'Sin empresa seleccionada'

  const sourceNames = [company.business_name, company.trade_name].map(normalizeCompanyLabel)
  if (sourceNames.some(name => CAYLO_ALIASES.has(name))) return 'CAYLO PREMIUM SPA'
  if (sourceNames.some(name => AMIMASCOTA_ALIASES.has(name))) return 'AMIMASCOTA SPA'

  return company.trade_name || company.business_name
}
