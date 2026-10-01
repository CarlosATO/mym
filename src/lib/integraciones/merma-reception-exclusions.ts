import { createAdminClient } from '@/lib/supabase/admin'
export { filterExcludedMermaReceptionIds } from './merma-reception-exclusion-core'

export async function excludedMermaReceptionIds(companyId: string) {
  const { data, error } = await createAdminClient()
    .schema('mermas')
    .from('bsale_reception_operations')
    .select('reception_id')
    .eq('company_id', companyId)
    .not('reception_id', 'is', null)
  if (error) throw error
  return new Set((data ?? []).map(row => Number(row.reception_id)).filter(id => Number.isInteger(id) && id > 0))
}
