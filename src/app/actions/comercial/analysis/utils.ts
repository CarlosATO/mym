import { getActiveCompanyId } from '@/app/actions/companies'
import { createAdminClient } from '@/lib/supabase/admin'
import { createClient } from '@/lib/supabase/server'

export function toNum(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string') return parseFloat(v) || 0
  return 0
}

export function monthKey(date: string): string {
  return date.slice(0, 7)
}

export function monthLabel(date: string): string {
  const [year, month] = date.split('-')
  return `${month}/${year}`
}

export async function getAuthedCompany() {
  const supabase = await createClient()
  const { data: { user }, error } = await supabase.auth.getUser()
  if (error || !user) throw new Error('No autenticado')
  const companyId = await getActiveCompanyId(user)
  if (!companyId) throw new Error('No hay empresa activa')
  return { user, companyId }
}

export function integQuery(tbl: string) {
  return createAdminClient().schema('integraciones').from(tbl as never)
}

export function adqQuery(tbl: string) {
  return createAdminClient().schema('adquisiciones').from(tbl as never)
}

type RangeRunner<T> = {
  range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>
}

export async function fetchAll<T>(qb: unknown, pageSize = 1000): Promise<T[]> {
  const all: T[] = []
  let offset = 0
  const runner = qb as RangeRunner<T>
  while (true) {
    const { data, error } = await runner.range(offset, offset + pageSize - 1)
    if (error) throw new Error(`Error fetching page at offset ${offset}: ${error.message}`)
    if (!data || data.length === 0) break
    all.push(...data)
    offset += pageSize
    if (data.length < pageSize) break
  }
  return all
}
