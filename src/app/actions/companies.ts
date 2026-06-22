'use server'

import { createClient } from '@/lib/supabase/server'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { cookies } from 'next/headers'
import { revalidatePath } from 'next/cache'

const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!

function coreAdmin() {
  return createSupabaseClient(supabaseUrl, serviceKey, {
    db: { schema: 'core' },
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export interface Company {
  id: string
  rut: string | null
  business_name: string
  trade_name: string | null
  email: string | null
  phone: string | null
  address: string | null
  logo_url: string | null
  is_active: boolean
  giro: string | null
  region: string | null
  comuna: string | null
  city: string | null
  purchase_email: string | null
  finance_email: string | null
  website: string | null
  admin_contact_name: string | null
  observations: string | null
  document_footer: string | null
  purchase_terms: string | null
  legal_text: string | null
  default_po_prefix: string | null
  default_currency: string | null
  default_tax_rate: number | null
  default_payment_days: number | null
}

export interface UserCompany {
  company_id: string
  role: string
  is_default: boolean
  company: Company
}

export async function getUserCompanies(): Promise<UserCompany[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return []

  const db = coreAdmin()
  const { data, error } = await db
    .from('user_company_access')
    .select('company_id, role, is_default, companies:company_id (*)')
    .eq('user_id', user.id)
    .eq('is_active', true)

  if (error) {
    console.error('Error in getUserCompanies:', error)
    return []
  }

  return (data ?? []).map(item => ({
    company_id: item.company_id,
    role: item.role,
    is_default: item.is_default,
    company: item.companies as unknown as Company
  }))
}

export async function getActiveCompanyId(cachedUser?: any): Promise<string | null> {
  let user = cachedUser
  if (!user) {
    const supabase = await createClient()
    const { data } = await supabase.auth.getUser()
    user = data.user
  }
  if (!user) return null

  const cookieStore = await cookies()
  const activeCompanyCookie = cookieStore.get('active_company_id')?.value

  const db = coreAdmin()
  const { data: accesses } = await db
    .from('user_company_access')
    .select('company_id, is_default')
    .eq('user_id', user.id)
    .eq('is_active', true)



  if (!accesses || accesses.length === 0) return null

  if (activeCompanyCookie) {
    const hasAccess = accesses.some(a => a.company_id === activeCompanyCookie)
    if (hasAccess) return activeCompanyCookie
  }

  const defaultAccess = accesses.find(a => a.is_default)
  if (defaultAccess) return defaultAccess.company_id

  return accesses[0].company_id
}

export async function getActiveCompany(): Promise<Company | null> {
  const companyId = await getActiveCompanyId()
  if (!companyId) return null

  const db = coreAdmin()
  const { data } = await db
    .from('companies')
    .select('*')
    .eq('id', companyId)
    .eq('is_active', true)
    .maybeSingle()

  return data as Company | null
}

export async function setActiveCompanyId(companyId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const db = coreAdmin()
  const { data } = await db
    .from('user_company_access')
    .select('id')
    .eq('user_id', user.id)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .maybeSingle()



  if (!data) return { error: 'No tiene acceso a esta empresa' }

  const cookieStore = await cookies()
  cookieStore.set('active_company_id', companyId, {
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 days
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  })



  revalidatePath('/', 'layout')

  return { success: true }
}

export async function validateUserCompanyAccess(companyId: string): Promise<boolean> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return false

  const db = coreAdmin()
  const { data } = await db
    .from('user_company_access')
    .select('id')
    .eq('user_id', user.id)
    .eq('company_id', companyId)
    .eq('is_active', true)
    .maybeSingle()

  return !!data
}

export async function updateActiveCompanyData(data: Partial<Company>) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  // 1. Validar el rol SUPER_USUARIO
  const { data: profile } = await supabase
    .from('users')
    .select('role_id')
    .eq('id', user.id)
    .maybeSingle()

  if (!profile) return { error: 'Usuario no encontrado' }

  const { data: role } = await supabase
    .from('roles')
    .select('name')
    .eq('id', profile.role_id)
    .single()

  if (!role || role.name !== 'SUPER_USUARIO') {
    return { error: 'Permisos insuficientes. Solo el SUPER_USUARIO puede editar los datos de la empresa.' }
  }

  // 2. Obtener y validar la empresa activa
  const activeCompanyId = await getActiveCompanyId()
  if (!activeCompanyId) return { error: 'No hay empresa activa seleccionada' }

  // 3. Validar que el usuario tenga acceso activo a esa empresa
  const db = coreAdmin()
  const { data: access } = await db
    .from('user_company_access')
    .select('id')
    .eq('user_id', user.id)
    .eq('company_id', activeCompanyId)
    .eq('is_active', true)
    .maybeSingle()

  if (!access) return { error: 'No tiene acceso a la empresa activa' }

  // 4. Formatear y validar RUT si viene especificado
  let formattedRut = data.rut ? data.rut.trim() : null
  if (formattedRut) {
    // Normalizar y formatear
    const cleaned = formattedRut.replace(/[^0-9kK]/g, '')
    if (cleaned.length >= 2) {
      const dv = cleaned.slice(-1).toUpperCase()
      const body = cleaned.slice(0, -1)
      formattedRut = `${body.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}-${dv}`
    }
  }

  // 5. Preparar datos a actualizar
  const updateData = {
    business_name: data.business_name,
    trade_name: data.trade_name,
    rut: formattedRut,
    giro: data.giro,
    address: data.address,
    region: data.region,
    comuna: data.comuna,
    city: data.city,
    phone: data.phone,
    email: data.email,
    purchase_email: data.purchase_email,
    finance_email: data.finance_email,
    website: data.website,
    logo_url: data.logo_url,
    admin_contact_name: data.admin_contact_name,
    observations: data.observations,
    document_footer: data.document_footer,
    purchase_terms: data.purchase_terms,
    legal_text: data.legal_text,
    default_po_prefix: data.default_po_prefix,
    default_currency: data.default_currency,
    default_tax_rate: data.default_tax_rate,
    default_payment_days: data.default_payment_days,
    updated_at: new Date().toISOString(),
    updated_by: user.id
  }

  // Quitar valores indefinidos
  Object.keys(updateData).forEach(key => {
    if ((updateData as any)[key] === undefined) {
      delete (updateData as any)[key]
    }
  })

  // 6. Ejecutar actualización
  const { error: updateError } = await db
    .from('companies')
    .update(updateData)
    .eq('id', activeCompanyId)

  if (updateError) {
    console.error('Error al actualizar datos de la empresa:', updateError)
    return { error: 'Error al actualizar los datos en la base de datos' }
  }

  // Revalidar rutas para limpiar la caché de Next.js
  revalidatePath('/dashboard')
  revalidatePath('/dashboard/configurar-empresa')
  revalidatePath('/dashboard/adquisiciones')

  // 7. Registro de auditoría
  // COMENTARIO TÉCNICO: Se registra el cambio de datos de la empresa de forma implícita mediante updated_at y updated_by en core.companies.
  // No hay patrón explícito de auditoría funcional integrado para modificaciones de empresa en el portal por el momento.

  return { success: true }
}
