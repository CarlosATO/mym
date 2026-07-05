// ─── Aliases de proveedores desde Tipo de Producto Bsale ────────────
// Reglas:
//   1. Si el nombre contiene "/" → proveedor = texto antes de "/"
//   2. Si el nombre completo coincide con un alias → usa el alias
//   3. Si no hay "/" ni alias → se conserva el nombre completo (marcar como dudoso)
//
// Mantener esta lista ordenada alfabéticamente.

export interface SupplierAlias {
  /** Nombre original en Bsale (puede contener "/" o no) */
  from: string
  /** Nombre normalizado del proveedor */
  to: string
}

export const SUPPLIER_ALIASES: SupplierAlias[] = [
  // Guiones que deben agruparse bajo un mismo proveedor
  { from: 'HAGEN-HIGIENE', to: 'HAGEN' },
  { from: 'HAGEN-SNACK', to: 'HAGEN' },
  { from: 'DOGGO-SNACK', to: 'DOGGO' },
  { from: 'NB-ALIMENTO', to: 'NB' },

  // Errores ortográficos
  { from: 'LUDIPECK', to: 'LUDIPEK' },
  { from: 'SOUTHPOINTALIMENTO', to: 'SOUTHPOINT' },
  { from: 'PROMERCO-SNACK', to: 'PROMERCO' },
  { from: 'SOUHTPOINT', to: 'SOUTHPOINT' },

  // Nombres que no deben convertirse en proveedores (basura técnica)
  { from: 'TIPO DE PRODUCTO O SERVICIO', to: '__IGNORE__' },
  { from: 'CARGA MASIVA DE PRODUCTOS DE BSALE', to: '__IGNORE__' },
  { from: 'DEMO BSALE', to: '__IGNORE__' },
  { from: 'SIN TIPO', to: '__IGNORE__' },
  { from: 'INSTRUCCIONES: COMPLETA EL EXCEL SEGÚN LO INDICADO EN CADA COLUMNA. COPIA DESDE', to: '__IGNORE__' },
]

const ALIAS_MAP = new Map<string, string>()
for (const a of SUPPLIER_ALIASES) {
  ALIAS_MAP.set(a.from.toUpperCase(), a.to)
}

const IGNORE_SET = new Set<string>()
for (const [k, v] of ALIAS_MAP) {
  if (v === '__IGNORE__') IGNORE_SET.add(k)
}

/** Extrae el nombre del proveedor desde un product_type.name */
export function extractSupplierFromProductType(rawName: string): {
  supplierName: string | null
  isDoubtful: boolean
  isIgnored: boolean
} {
  let name = (rawName || '').trim().toUpperCase()
  name = name.replace(/\s+/g, ' ').trim()
  if (!name || name.length < 2) return { supplierName: null, isDoubtful: false, isIgnored: true }

  // Check ignore list first
  if (IGNORE_SET.has(name)) {
    return { supplierName: null, isDoubtful: false, isIgnored: true }
  }

  // Check explicit aliases
  if (ALIAS_MAP.has(name) && ALIAS_MAP.get(name) !== '__IGNORE__') {
    return { supplierName: ALIAS_MAP.get(name)!, isDoubtful: false, isIgnored: false }
  }

  // If contains "/", take first part
  if (name.includes('/')) {
    const base = name.split('/')[0].trim()
    if (base && base.length >= 2) {
      return { supplierName: base, isDoubtful: false, isIgnored: false }
    }
  }

  // Name without "/" — check if it's already a known supplier alias
  // If it has a hyphen but no alias, keep full name (doubtful)
  const finalName = name
  if (finalName.length >= 2) {
    return { supplierName: finalName, isDoubtful: true, isIgnored: false }
  }

  return { supplierName: null, isDoubtful: false, isIgnored: true }
}

export function isIgnoredProductType(rawName: string): boolean {
  const name = (rawName || '').trim().toUpperCase()
  return IGNORE_SET.has(name)
}
