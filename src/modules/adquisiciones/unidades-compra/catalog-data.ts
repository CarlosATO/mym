export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: unknown; count?: number | null }>,
  pageSize = 1000,
): Promise<T[]> {
  const rows: T[] = []
  for (let from = 0; ; from += pageSize) {
    const { data, error, count } = await fetchPage(from, from + pageSize - 1)
    if (error) throw error
    if (!data) throw new Error('Respuesta de catálogo vacía')
    rows.push(...data)
    if (from === 0 && count != null && data.length === pageSize) {
      const offsets = Array.from({ length: Math.max(0, Math.ceil(count / pageSize) - 1) }, (_, i) => (i + 1) * pageSize)
      for (let i = 0; i < offsets.length; i += 8) {
        const pages = await Promise.all(offsets.slice(i, i + 8).map(offset => fetchPage(offset, offset + pageSize - 1)))
        for (const page of pages) {
          if (page.error) throw page.error
          if (!page.data) throw new Error('Respuesta de catálogo vacía')
          rows.push(...page.data)
        }
      }
      if (rows.length !== count) throw new Error('El catálogo cambió durante la carga; inténtelo nuevamente')
      return rows
    }
    if (data.length < pageSize) return rows
  }
}

export function resolveRealSupplier<T extends { supplier_kind: string | null; parent_supplier_id: string | null }>(
  supplier: T | undefined,
  suppliers: Map<string, T>,
): T | null {
  if (supplier?.supplier_kind === 'REAL') return supplier
  if (supplier?.supplier_kind !== 'BSALE_OPERATIVE' || !supplier.parent_supplier_id) return null
  const parent = suppliers.get(supplier.parent_supplier_id)
  return parent?.supplier_kind === 'REAL' ? parent : null
}
