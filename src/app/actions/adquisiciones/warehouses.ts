'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { getActiveCompanyId } from '@/app/actions/companies'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!

function db() {
  return createSupabaseClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceKey, {
    db: { schema: 'adquisiciones' }, auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface Warehouse {
  id: string; code: string; name: string; warehouse_type: string; manager_name: string | null
  manager_email: string | null; manager_phone: string | null; address: string | null
  city: string | null; commune: string | null; region: string | null
  capacity_m2: number | null; capacity_pallets: number | null; is_default: boolean
  notes: string | null; status: string; is_active: boolean; created_at: string; updated_at: string
}

export interface WarehouseFilters {
  search?: string; warehouse_type?: string; status?: string; is_active?: string
  page?: number; pageSize?: number
}

export async function getWarehouses(filters: WarehouseFilters = {}): Promise<{ data: Warehouse[]; total: number }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { data: [], total: 0 }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { data: [], total: 0 }

  const d = db()
  let q = d.from('warehouses')
    .select('*', { count: 'exact' })
    .eq('company_id', companyId)

  if (filters.search) { const s = filters.search; q = q.or(`code.ilike.%${s}%,name.ilike.%${s}%,city.ilike.%${s}%,commune.ilike.%${s}%`) }
  if (filters.warehouse_type) q = q.eq('warehouse_type', filters.warehouse_type)
  if (filters.status) q = q.eq('status', filters.status)
  if (filters.is_active === 'true') q = q.eq('is_active', true)
  else if (filters.is_active === 'false') q = q.eq('is_active', false)
  const p = filters.page ?? 1; const ps = filters.pageSize ?? 50
  const { data, error, count } = await q.order('code').range((p - 1) * ps, p * ps - 1)
  if (error) return { data: [], total: 0 }
  return { data: (data ?? []) as Warehouse[], total: count ?? 0 }
}

export async function createWarehouse(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const code = ((formData.get('code') as string) ?? '').trim().toUpperCase()
  if (!code) return { error: 'El código es obligatorio' }
  const name = ((formData.get('name') as string) ?? '').trim().toUpperCase()
  if (!name) return { error: 'El nombre es obligatorio' }
  const d = db()
  const { data: dup } = await d.from('warehouses').select('id').eq('code', code).eq('company_id', companyId).maybeSingle()
  if (dup) return { error: `El código "${code}" ya existe en esta empresa` }
  const { data: dupName } = await d.from('warehouses').select('id').eq('name', name).eq('company_id', companyId).maybeSingle()
  if (dupName) return { error: `El nombre "${name}" ya existe en esta empresa` }
  function v(n: string) { return ((formData.get(n) as string) ?? '').trim() || null }
  function vn(n: string) { return ((formData.get(n) as string) ?? '').trim().toUpperCase() || null }
  const email = v('manager_email')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Correo inválido' }
  const is_default = formData.get('is_default') === 'true'
  const { data, error } = await d.from('warehouses').insert({
    company_id: companyId,
    code, name, warehouse_type: vn('warehouse_type') ?? 'CENTRAL',
    manager_name: vn('manager_name'), manager_email: email, manager_phone: v('manager_phone'),
    address: vn('address'), city: vn('city'), commune: vn('commune'), region: vn('region'),
    capacity_m2: parseFloat(v('capacity_m2') ?? '') || null,
    capacity_pallets: parseInt(v('capacity_pallets') ?? '') || null,
    is_default, notes: vn('notes'), status: vn('status') ?? 'ACTIVE', created_by: user.id,
  }).select()
  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'No se insertó el registro' }
  return { success: true }
}

export async function updateWarehouse(whId: string, formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const name = ((formData.get('name') as string) ?? '').trim().toUpperCase()
  if (!name) return { error: 'El nombre es obligatorio' }
  const d = db()
  function v(n: string) { return ((formData.get(n) as string) ?? '').trim() || null }
  function vn(n: string) { return ((formData.get(n) as string) ?? '').trim().toUpperCase() || null }
  const email = v('manager_email')
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { error: 'Correo inválido' }
  const is_default = formData.get('is_default') === 'true'
  const { data, error } = await d.from('warehouses').update({
    name, warehouse_type: vn('warehouse_type') ?? 'CENTRAL',
    manager_name: vn('manager_name'), manager_email: email, manager_phone: v('manager_phone'),
    address: vn('address'), city: vn('city'), commune: vn('commune'), region: vn('region'),
    capacity_m2: parseFloat(v('capacity_m2') ?? '') || null,
    capacity_pallets: parseInt(v('capacity_pallets') ?? '') || null,
    is_default, notes: vn('notes'), status: vn('status') ?? 'ACTIVE', updated_by: user.id,
  }).eq('id', whId).eq('company_id', companyId).select()
  if (error) return { error: error.message }
  if (!data || data.length === 0) return { error: 'No se actualizó el registro' }
  return { success: true }
}

export async function deactivateWarehouse(whId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const d = db()
  const { data: wh } = await d.from('warehouses').select('is_active, status').eq('id', whId).eq('company_id', companyId).single()
  if (!wh) return { error: 'Bodega no encontrada' }
  const { error } = await d.from('warehouses').update({ is_active: !wh.is_active, status: !wh.is_active ? 'ACTIVE' : 'INACTIVE', updated_by: user.id }).eq('id', whId).eq('company_id', companyId)
  if (error) return { error: error.message }
  return { success: true, newActive: !wh.is_active }
}

export async function importWarehouses(rows: Record<string, unknown>[]) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const d = db()
  let created = 0; const errors: { row: number; message: string }[] = []
  let defaultCount = 0
  for (const row of rows) { if (['SI','TRUE','1'].includes(String(row.predeterminada ?? '').trim().toUpperCase())) defaultCount++ }
  if (defaultCount > 1) return { created: 0, errors: [{ row: 0, message: 'Solo una bodega puede ser predeterminada' }], total: rows.length }
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]; const idx = i + 1
    const code = String(row.codigo ?? '').trim().toUpperCase()
    if (!code) { errors.push({ row: idx, message: 'Código obligatorio' }); continue }
    const name = String(row.nombre ?? '').trim().toUpperCase()
    if (!name) { errors.push({ row: idx, message: 'Nombre obligatorio' }); continue }
    const type = String(row.tipo ?? '').trim().toUpperCase()
    if (!type) { errors.push({ row: idx, message: 'Tipo obligatorio' }); continue }
    const validTypes = ['CENTRAL','SUCURSAL','TRANSITO','DEVOLUCIONES','CONSIGNACION','OTRO']
    if (!validTypes.includes(type)) { errors.push({ row: idx, message: `Tipo inválido: ${type}` }); continue }
    const { data: dup } = await d.from('warehouses').select('id').eq('code', code).eq('company_id', companyId).maybeSingle()
    if (dup) { errors.push({ row: idx, message: `Código "${code}" ya existe en esta empresa` }); continue }
    const { data: dupName } = await d.from('warehouses').select('id').eq('name', name).eq('company_id', companyId).maybeSingle()
    if (dupName) { errors.push({ row: idx, message: `Nombre "${name}" ya existe en esta empresa` }); continue }
    const email = String(row.correo_encargado ?? '').trim()
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errors.push({ row: idx, message: `Correo inválido: ${email}` }); continue }
    const m2 = parseFloat(String(row.capacidad_m2 ?? '')), pallets = parseInt(String(row.capacidad_pallets ?? ''))
    if (row.capacidad_m2 && (isNaN(m2) || m2 < 0)) { errors.push({ row: idx, message: 'capacidad_m2 debe ser >= 0' }); continue }
    if (row.capacidad_pallets && (isNaN(pallets) || pallets < 0)) { errors.push({ row: idx, message: 'capacidad_pallets debe ser >= 0' }); continue }
    const est = String(row.estado ?? '').trim().toUpperCase()
    const statusMap: Record<string, string> = { 'ACTIVA': 'ACTIVE', 'ACTIVE': 'ACTIVE', 'INACTIVA': 'INACTIVE', 'INACTIVE': 'INACTIVE', 'BLOQUEADA': 'BLOCKED', 'BLOCKED': 'BLOCKED' }
    const status = statusMap[est] || 'ACTIVE'
    const is_def = ['SI','TRUE','1'].includes(String(row.predeterminada ?? '').trim().toUpperCase())
    const { data, error: ie } = await d.from('warehouses').insert({
      company_id: companyId,
      code, name, warehouse_type: type, notes: String(row.observacion ?? '').trim().toUpperCase() || null,
      manager_name: String(row.encargado ?? '').trim().toUpperCase() || null, manager_email: email || null,
      manager_phone: String(row.telefono_encargado ?? '').trim() || null,
      address: String(row.direccion ?? '').trim().toUpperCase() || null,
      city: String(row.ciudad ?? '').trim().toUpperCase() || null,
      commune: String(row.comuna ?? '').trim().toUpperCase() || null,
      region: String(row.region ?? '').trim().toUpperCase() || null,
      capacity_m2: isNaN(m2) ? null : m2, capacity_pallets: isNaN(pallets) ? null : pallets,
      is_default: is_def, status, created_by: user.id,
    }).select()
    if (ie) { errors.push({ row: idx, message: ie.message }) }
    else if (!data || data.length === 0) { errors.push({ row: idx, message: 'No se insertó' }) }
    else { created += data.length }
  }
  return { created, errors, total: rows.length }
}
