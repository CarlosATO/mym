'use server'

import { createAdminClient } from '@/lib/supabase/admin'

export interface SecurityLogEntry {
  id: string
  event_type: string
  description: string | null
  user_id: string | null
  email: string | null
  ip_address: string | null
  user_agent: string | null
  success: boolean
  metadata: Record<string, unknown> | null
  created_at: string
}

export async function getSecurityLogs(filters: {
  email?: string
  dateFrom?: string
  dateTo?: string
  eventType?: string
  success?: string
  page?: number
  pageSize?: number
}): Promise<{ data: SecurityLogEntry[]; total: number }> {
  const admin = createAdminClient()

  let query = admin
    .from('security_logs')
    .select('*', { count: 'exact' })

  if (filters.email) {
    query = query.or(`email.ilike.%${filters.email}%,user_id.eq.${filters.email}`)
  }
  if (filters.dateFrom) {
    query = query.gte('created_at', filters.dateFrom)
  }
  if (filters.dateTo) {
    query = query.lte('created_at', filters.dateTo + 'T23:59:59Z')
  }
  if (filters.eventType) {
    query = query.eq('event_type', filters.eventType)
  }
  if (filters.success === 'true') {
    query = query.eq('success', true)
  } else if (filters.success === 'false') {
    query = query.eq('success', false)
  }

  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  query = query
    .order('created_at', { ascending: false })
    .range(from, to)

  const { data, error, count } = await query

  if (error) {
    console.error('Security logs query error:', error)
    return { data: [], total: 0 }
  }

  return {
    data: (data ?? []) as SecurityLogEntry[],
    total: count ?? 0,
  }
}
