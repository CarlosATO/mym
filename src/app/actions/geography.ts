'use server'

import { createAdminClient } from '@/lib/supabase/admin'

export async function getRegions() {
  const admin = createAdminClient()
  const { data } = await admin.from('regions').select('id, code, name').eq('is_active', true).order('code')
  return (data ?? []) as { id: string; code: string; name: string }[]
}

export async function getCommunes(regionId: string) {
  const admin = createAdminClient()
  const { data } = await admin.from('communes').select('id, code, name').eq('region_id', regionId).eq('is_active', true).order('name')
  return (data ?? []) as { id: string; code: string; name: string }[]
}
