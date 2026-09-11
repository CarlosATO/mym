'use server'

import { revalidatePath } from 'next/cache'
import { randomUUID } from 'crypto'
import { createClient } from '@/lib/supabase/server'
import { isValidRut, normalizeRut } from '@/modules/rrhh/lib/rut'
import { isContractType } from '@/modules/rrhh/lib/contract-types'

export type Employee = {
  id: string
  rut: string
  rut_normalized: string
  commune_id: string | null
  nombres: string
  apellido_paterno: string
  apellido_materno: string | null
  fecha_nacimiento: string | null
  telefono: string | null
  email_personal: string | null
  email_corporativo: string | null
  direccion: string | null
  comuna: string | null
  ciudad: string | null
  cargo: string
  area_departamento: string
  fecha_ingreso: string
  tipo_contrato: string | null
  estado: 'ACTIVO' | 'INACTIVO'
  observaciones: string | null
  portal_user_id: string | null
  created_at: string
  updated_at: string
  created_by: string | null
  updated_by: string | null
  profile_photo_path: string | null
}

export type EmployeePayload = {
  rut: string
  nombres: string
  apellido_paterno: string
  apellido_materno?: string
  fecha_nacimiento?: string
  telefono?: string
  email_personal?: string
  email_corporativo?: string
  direccion?: string
  comuna?: string
  commune_id?: string
  ciudad?: string
  cargo: string
  area_departamento: string
  fecha_ingreso: string
  tipo_contrato?: string
  estado?: 'ACTIVO' | 'INACTIVO'
  observaciones?: string
}

type ActionResult = { ok: true; employee: Employee } | { ok: false; error: string }

async function authorized(permission: 'rrhh.personal.view' | 'rrhh.personal.manage') {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { supabase, user: null, error: 'Sesión no válida.' }
  const { data: profile } = await supabase.from('users').select('is_active').eq('id', user.id).maybeSingle()
  if (!profile?.is_active) return { supabase, user: null, error: 'El usuario no está activo.' }
  const { data: allowed, error } = await supabase.rpc('has_permission', { p_permission_code: permission })
  if (error || allowed !== true) return { supabase, user: null, error: 'No tienes permisos para esta acción.' }
  return { supabase, user, error: null }
}

function clean(value: string | undefined) {
  const trimmed = value?.trim() ?? ''
  return trimmed || null
}

function toRow(payload: EmployeePayload, userId: string) {
  return {
    rut: payload.rut.trim(),
    nombres: payload.nombres.trim(),
    apellido_paterno: payload.apellido_paterno.trim(),
    apellido_materno: clean(payload.apellido_materno),
    fecha_nacimiento: clean(payload.fecha_nacimiento),
    telefono: clean(payload.telefono),
    email_personal: clean(payload.email_personal),
    email_corporativo: clean(payload.email_corporativo),
    direccion: clean(payload.direccion),
    comuna: clean(payload.comuna),
    commune_id: clean(payload.commune_id ?? undefined),
    ciudad: clean(payload.ciudad),
    cargo: payload.cargo.trim(),
    area_departamento: payload.area_departamento.trim(),
    fecha_ingreso: payload.fecha_ingreso,
    tipo_contrato: clean(payload.tipo_contrato),
    estado: payload.estado === 'INACTIVO' ? 'INACTIVO' : 'ACTIVO',
    observaciones: clean(payload.observaciones),
    updated_by: userId,
  }
}

function validate(payload: EmployeePayload) {
  if (!isValidRut(payload.rut)) return 'El RUT no es válido.'
  if (!payload.nombres.trim() || !payload.apellido_paterno.trim() || !payload.cargo.trim() || !payload.area_departamento.trim() || !payload.fecha_ingreso) {
    return 'Completa los campos obligatorios.'
  }
  if (payload.tipo_contrato?.trim() && !isContractType(payload.tipo_contrato.trim())) return 'Selecciona un tipo de contrato válido.'
  return null
}

export async function getRrhhPermissions() {
  const { supabase, user, error } = await authorized('rrhh.personal.view')
  if (!user) return { canView: false, canManage: false }
  const { data: canManage } = await supabase.rpc('has_permission', { p_permission_code: 'rrhh.personal.manage' })
  return { canView: !error, canManage: canManage === true }
}

export async function getEmployees() {
  const { supabase, user } = await authorized('rrhh.personal.view')
  if (!user) return [] as Employee[]
  const { data } = await supabase.schema('rrhh').from('employees').select('*').order('nombres').order('apellido_paterno')
  return (data ?? []) as Employee[]
}

export async function getCommunesCatalog() {
  const { supabase, user } = await authorized('rrhh.personal.view')
  if (!user) return [] as { id: string; name: string }[]
  const { data } = await supabase.from('communes').select('id, name').eq('is_active', true).order('name')
  return (data ?? []) as { id: string; name: string }[]
}

export async function getEmployee(id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null
  const { supabase, user } = await authorized('rrhh.personal.view')
  if (!user) return null
  const { data } = await supabase.schema('rrhh').from('employees').select('*').eq('id', id).maybeSingle()
  return (data as Employee | null) ?? null
}

export async function createEmployee(payload: EmployeePayload): Promise<ActionResult> {
  const validationError = validate(payload)
  if (validationError) return { ok: false, error: validationError }
  if (!payload.commune_id) return { ok: false, error: 'Selecciona una comuna del catálogo.' }
  const { supabase, user, error } = await authorized('rrhh.personal.manage')
  if (!user) return { ok: false, error: error ?? 'No autorizado.' }
  const { data: commune } = await supabase.from('communes').select('name').eq('id', payload.commune_id).eq('is_active', true).maybeSingle()
  if (!commune) return { ok: false, error: 'La comuna seleccionada no es válida.' }
  const { data, error: insertError } = await supabase.schema('rrhh').from('employees').insert({ ...toRow(payload, user.id), comuna: commune.name, created_by: user.id }).select('*').single()
  if (insertError) return { ok: false, error: insertError.code === '23505' ? 'Ya existe un trabajador con ese RUT.' : insertError.message }
  revalidatePath('/dashboard/rrhh/personal')
  return { ok: true, employee: data as Employee }
}

export async function updateEmployee(id: string, payload: EmployeePayload): Promise<ActionResult> {
  const validationError = validate(payload)
  if (validationError) return { ok: false, error: validationError }
  const { supabase, user, error } = await authorized('rrhh.personal.manage')
  if (!user) return { ok: false, error: error ?? 'No autorizado.' }
  if (!payload.commune_id) return { ok: false, error: 'Selecciona una comuna del catálogo.' }
  const { data: commune } = await supabase.from('communes').select('name').eq('id', payload.commune_id).eq('is_active', true).maybeSingle()
  if (!commune) return { ok: false, error: 'La comuna seleccionada no es válida.' }
  const { data, error: updateError } = await supabase.schema('rrhh').from('employees').update({ ...toRow(payload, user.id), comuna: commune.name }).eq('id', id).select('*').single()
  if (updateError) return { ok: false, error: updateError.code === '23505' ? 'Ya existe un trabajador con ese RUT.' : updateError.message }
  revalidatePath('/dashboard/rrhh/personal')
  revalidatePath(`/dashboard/rrhh/personal/${id}`)
  return { ok: true, employee: data as Employee }
}

export async function updateEmployeePersonal(id: string, values: Record<string, string>) {
  if (!isValidRut(values.rut ?? '') || !values.nombres?.trim() || !values.apellido_paterno?.trim() || !values.commune_id) return { error: 'Completa los datos personales, comuna y un RUT válido.' }
  const { supabase, user, error } = await authorized('rrhh.personal.manage')
  if (!user) return { error: error ?? 'No autorizado.' }
  const { data: commune } = await supabase.from('communes').select('name').eq('id', values.commune_id).eq('is_active', true).maybeSingle()
  if (!commune) return { error: 'La comuna seleccionada no es válida.' }
  const { error: updateError } = await supabase.schema('rrhh').from('employees').update({ rut: values.rut.trim(), nombres: values.nombres.trim(), apellido_paterno: values.apellido_paterno.trim(), apellido_materno: clean(values.apellido_materno), fecha_nacimiento: clean(values.fecha_nacimiento), telefono: clean(values.telefono), email_personal: clean(values.email_personal), email_corporativo: clean(values.email_corporativo), direccion: clean(values.direccion), comuna: commune.name, commune_id: values.commune_id, ciudad: clean(values.ciudad), updated_by: user.id }).eq('id', id)
  if (updateError) return { error: updateError.code === '23505' ? 'Ya existe un trabajador con ese RUT.' : updateError.message }
  revalidatePath(`/dashboard/rrhh/personal/${id}`)
  return { ok: true }
}

export async function updateEmployeeLabor(id: string, values: Record<string, string>) {
  if (!values.cargo?.trim() || !values.area_departamento?.trim() || !values.fecha_ingreso) return { error: 'Completa los datos laborales obligatorios.' }
  if (values.tipo_contrato?.trim() && !isContractType(values.tipo_contrato.trim())) return { error: 'Selecciona un tipo de contrato válido.' }
  const { supabase, user, error } = await authorized('rrhh.personal.manage')
  if (!user) return { error: error ?? 'No autorizado.' }
  const { error: updateError } = await supabase.schema('rrhh').from('employees').update({ cargo: values.cargo.trim(), area_departamento: values.area_departamento.trim(), fecha_ingreso: values.fecha_ingreso, tipo_contrato: clean(values.tipo_contrato), estado: values.estado === 'INACTIVO' ? 'INACTIVO' : 'ACTIVO', observaciones: clean(values.observaciones), updated_by: user.id }).eq('id', id)
  if (updateError) return { error: updateError.message }
  revalidatePath(`/dashboard/rrhh/personal/${id}`)
  return { ok: true }
}

export async function setEmployeeStatus(id: string, estado: 'ACTIVO' | 'INACTIVO'): Promise<ActionResult> {
  const { supabase, user, error } = await authorized('rrhh.personal.manage')
  if (!user) return { ok: false, error: error ?? 'No autorizado.' }
  const { data, error: updateError } = await supabase.schema('rrhh').from('employees').update({ estado, updated_by: user.id }).eq('id', id).select('*').single()
  if (updateError) return { ok: false, error: updateError.message }
  revalidatePath('/dashboard/rrhh/personal')
  revalidatePath(`/dashboard/rrhh/personal/${id}`)
  return { ok: true, employee: data as Employee }
}

const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const PHOTO_EXTENSIONS: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

export async function prepareEmployeePhotoUpload(id: string, mimeType: string, sizeBytes: number) {
  if (!PHOTO_MIMES.has(mimeType) || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 5 * 1024 * 1024) return { error: 'La foto debe ser JPG, PNG o WebP y pesar hasta 5 MB.' }
  const { supabase, user, error } = await authorized('rrhh.personal.manage')
  if (!user) return { error: error ?? 'No autorizado.' }
  const { data: employee } = await supabase.schema('rrhh').from('employees').select('id').eq('id', id).maybeSingle()
  if (!employee) return { error: 'Trabajador no encontrado.' }
  const path = `${id}/${randomUUID()}.${PHOTO_EXTENSIONS[mimeType]}`
  const { data, error: uploadError } = await supabase.storage.from('rrhh-profile-photos').createSignedUploadUrl(path)
  if (uploadError || !data?.token) return { error: 'No se pudo preparar la carga de la fotografía.' }
  return { path, token: data.token }
}

export async function saveEmployeePhoto(id: string, path: string, mimeType: string, sizeBytes: number) {
  if (!PHOTO_MIMES.has(mimeType) || !Number.isInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 5 * 1024 * 1024 || !new RegExp(`^${id}/[0-9a-f-]{36}\\.(jpg|png|webp)$`, 'i').test(path)) return { error: 'Los datos de la fotografía no son válidos.' }
  const { supabase, user, error } = await authorized('rrhh.personal.manage')
  if (!user) return { error: error ?? 'No autorizado.' }
  const { data: employee } = await supabase.schema('rrhh').from('employees').select('profile_photo_path').eq('id', id).maybeSingle()
  if (!employee) return { error: 'Trabajador no encontrado.' }
  const { error: updateError } = await supabase.schema('rrhh').from('employees').update({ profile_photo_path: path, updated_by: user.id }).eq('id', id)
  if (updateError) return { error: updateError.message }
  if (employee.profile_photo_path && employee.profile_photo_path !== path) await supabase.storage.from('rrhh-profile-photos').remove([employee.profile_photo_path])
  revalidatePath(`/dashboard/rrhh/personal/${id}`)
  revalidatePath('/dashboard/rrhh/personal')
  return { ok: true }
}

export async function getEmployeePhotoUrl(path: string | null) {
  if (!path) return null
  const { supabase, user } = await authorized('rrhh.personal.view')
  if (!user) return null
  const { data } = await supabase.storage.from('rrhh-profile-photos').createSignedUrl(path, 300)
  return data?.signedUrl ?? null
}

export { normalizeRut }
