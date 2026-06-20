'use server'

import { createAdminClient } from '@/lib/supabase/admin'

export interface AuditFilter {
  performedBy: string
  dateFrom?: string
  dateTo?: string
  moduleCode?: string
  action?: string
  severity?: string
  search?: string
  page?: number
  pageSize?: number
}

export interface AuditEntry {
  id: string
  table_name: string
  record_id: string | null
  action: string
  old_data: Record<string, unknown> | null
  new_data: Record<string, unknown> | null
  performed_by: string | null
  performed_at: string
  ip_address: string | null
  schema_name: string
  module_code: string
  event_type: string
  severity: string
  metadata: Record<string, unknown>
  diff_data: Record<string, unknown> | null
  performed_by_email: string | null
  performed_by_name: string | null
}

export async function getAuditLogs(filters: AuditFilter): Promise<{ data: AuditEntry[]; total: number }> {
  if (!filters.performedBy) {
    return { data: [], total: 0 }
  }

  const admin = createAdminClient()

  let query = admin
    .from('audit_logs')
    .select(`
      *,
      performed_by_user:users!performed_by(email, nombre, apellido)
    `, { count: 'exact' })
    .eq('performed_by', filters.performedBy)

  if (filters.dateFrom) {
    query = query.gte('performed_at', filters.dateFrom)
  }
  if (filters.dateTo) {
    query = query.lte('performed_at', filters.dateTo + 'T23:59:59Z')
  }
  if (filters.moduleCode) {
    query = query.eq('module_code', filters.moduleCode)
  }
  if (filters.action) {
    query = query.eq('action', filters.action)
  }
  if (filters.severity) {
    query = query.eq('severity', filters.severity)
  }
  if (filters.search) {
    query = query.or(`table_name.ilike.%${filters.search}%,event_type.ilike.%${filters.search}%`)
  }

  const page = filters.page ?? 1
  const pageSize = filters.pageSize ?? 50
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1

  query = query
    .order('performed_at', { ascending: false })
    .range(from, to)

  const { data, error, count } = await query

  if (error) {
    console.error('Audit query error:', error)
    return { data: [], total: 0 }
  }

  const mapped: AuditEntry[] = (data ?? []).map((row: Record<string, unknown>) => {
    const userData = row.performed_by_user as Record<string, unknown> | null
    return {
      id: row.id as string,
      table_name: row.table_name as string,
      record_id: row.record_id as string | null,
      action: row.action as string,
      old_data: row.old_data as Record<string, unknown> | null,
      new_data: row.new_data as Record<string, unknown> | null,
      performed_by: row.performed_by as string | null,
      performed_at: row.performed_at as string,
      ip_address: row.ip_address as string | null,
      schema_name: (row.schema_name as string) ?? 'portal',
      module_code: (row.module_code as string) ?? 'PORTAL',
      event_type: (row.event_type as string) ?? '',
      severity: (row.severity as string) ?? 'INFO',
      metadata: (row.metadata as Record<string, unknown>) ?? {},
      diff_data: row.diff_data as Record<string, unknown> | null,
      performed_by_email: userData?.email as string | null,
      performed_by_name: userData ? `${userData.nombre ?? ''} ${userData.apellido ?? ''}`.trim() : null,
    }
  })

  return { data: mapped, total: count ?? 0 }
}

export async function getAuditUsers(): Promise<{ id: string; nombre: string; apellido: string; email: string }[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('users')
    .select('id, nombre, apellido, email')
    .eq('is_active', true)
    .order('nombre')
  return data ?? []
}

export async function getAuditFilterOptions(): Promise<{
  modules: string[]
  severities: string[]
  actions: string[]
}> {
  const admin = createAdminClient()

  const [modRes, sevRes, actRes] = await Promise.all([
    admin.rpc('get_audit_distinct_values', { column_name: 'module_code' }),
    admin.rpc('get_audit_distinct_values', { column_name: 'severity' }),
    admin.rpc('get_audit_distinct_values', { column_name: 'action' }),
  ])

  return {
    modules: (modRes.data ?? []).map((r: { value: string }) => r.value).filter(Boolean),
    severities: (sevRes.data ?? []).map((r: { value: string }) => r.value).filter(Boolean),
    actions: (actRes.data ?? []).map((r: { value: string }) => r.value).filter(Boolean),
  }
}
