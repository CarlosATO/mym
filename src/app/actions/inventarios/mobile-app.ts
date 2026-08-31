'use server'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'

const MOBILE_APP_BUCKET = 'mobile-apps'
const SIGNED_URL_EXPIRES_IN = 30 * 60
const MOBILE_APP_MAX_SIZE = 200 * 1024 * 1024

export interface ActiveMobileRelease {
  app_name: string
  version: string
  build_number: number
  storage_path: string
  published_at: string
}

type SuperAuth = { user: { id: string } } | { error: string }

async function requireSuperUsuario(): Promise<SuperAuth> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'Debes iniciar sesión.' }

  const admin = createAdminClient()
  const { data: profile, error } = await admin
    .from('users')
    .select('roles:role_id(name, is_active)')
    .eq('id', user.id)
    .eq('is_active', true)
    .is('deleted_at', null)
    .single()
  const role = profile?.roles as { name?: string; is_active?: boolean } | null
  if (error || role?.name !== 'SUPER_USUARIO' || role.is_active !== true) {
    return { error: 'Se requiere rol SUPER_USUARIO.' }
  }
  return { user: { id: user.id } }
}

export async function canPublishMobileApp() {
  const auth = await requireSuperUsuario()
  return 'error' in auth ? false : true
}

export async function createMobileAppUploadAuthorization(params: {
  fileName: string
  fileSize: number
  version: string
  buildNumber: number
}) {
  const auth = await requireSuperUsuario()
  if ('error' in auth) return { error: auth.error }
  const { fileName, fileSize, version, buildNumber } = params
  if (!fileName.toLowerCase().endsWith('.apk')) return { error: 'Solo se permiten archivos .apk.' }
  if (!Number.isFinite(fileSize) || fileSize <= 0 || fileSize > MOBILE_APP_MAX_SIZE) return { error: 'La APK supera el máximo de 200 MB.' }
  if (!version.trim()) return { error: 'La versión es obligatoria.' }
  if (!Number.isInteger(buildNumber) || buildNumber <= 0) return { error: 'El build debe ser un entero positivo.' }

  const safeName = `PetGroup-Inventarios-v${version.trim()}-build${buildNumber}.apk`
  const storagePath = `inventarios/${safeName}`
  const admin = createAdminClient()
  const { data: existing, error: existingError } = await admin
    .from('mobile_app_releases').select('id').eq('app_key', 'inventory_mobile')
    .eq('version', version.trim()).eq('build_number', buildNumber).maybeSingle()
  if (existingError) return { error: 'No se pudo validar la versión.' }
  if (existing) return { error: 'La versión y build ya están registrados.' }

  const supabase = await createClient()
  const { data: sessionData } = await supabase.auth.getSession()
  if (!sessionData.session?.access_token) return { error: 'La sesión expiró. Inicia sesión nuevamente.' }
  return { error: null, accessToken: sessionData.session.access_token, storagePath }
}

export async function activateMobileAppRelease(params: { version: string; buildNumber: number; storagePath: string }) {
  const auth = await requireSuperUsuario()
  if ('error' in auth) return { release: null, error: auth.error }
  if (!params.storagePath.startsWith('inventarios/') || !params.storagePath.endsWith('.apk')) {
    return { release: null, error: 'Ruta de almacenamiento inválida.' }
  }
  const admin = createAdminClient()
  const fileName = params.storagePath.split('/').pop()!
  const { data: objects, error: objectError } = await admin.storage.from(MOBILE_APP_BUCKET).list('inventarios', { search: fileName, limit: 100 })
  if (objectError || !objects?.some(object => object.name === fileName)) {
    return { release: null, error: 'La APK no quedó disponible en Storage. Reintenta la carga.' }
  }
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('publish_mobile_release', {
    p_version: params.version.trim(), p_build_number: params.buildNumber, p_storage_path: params.storagePath,
  })
  if (error) {
    console.error('activateMobileAppRelease error:', error)
    const messages: Record<string, string> = {
      VERSION_BUILD_ALREADY_REGISTERED: 'La versión y build ya están registrados.',
      PERMISSION_DENIED: 'Se requiere rol SUPER_USUARIO.',
    }
    return { release: null, error: messages[error.message] ?? 'No se pudo activar la versión. La versión anterior se conserva activa.' }
  }
  return { release: (data?.[0] as ActiveMobileRelease | undefined) ?? null, error: null }
}

async function getAuthenticatedMobileRelease() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) return { release: null, error: 'Debes iniciar sesión para consultar la aplicación.' }

  const { data, error } = await supabase.rpc('get_active_mobile_release')
  if (error) {
    console.error('getActiveMobileRelease error:', error)
    return { release: null, error: 'No se pudo consultar la versión disponible.' }
  }

  return {
    release: (data?.[0] as ActiveMobileRelease | undefined) ?? null,
    error: null,
  }
}

export async function getActiveMobileRelease(): Promise<ActiveMobileRelease | null> {
  const { release } = await getAuthenticatedMobileRelease()
  return release
}

export async function createMobileAppSignedUrl() {
  const { release, error } = await getAuthenticatedMobileRelease()
  if (error) return { signedUrl: null, release: null, error }
  if (!release) return { signedUrl: null, release: null, error: 'No hay una versión disponible para descargar.' }

  const admin = createAdminClient()
  const { data, error: signedError } = await admin.storage
    .from(MOBILE_APP_BUCKET)
    .createSignedUrl(release.storage_path, SIGNED_URL_EXPIRES_IN)

  if (signedError || !data?.signedUrl) {
    console.error('createMobileAppSignedUrl storage error:', signedError)
    return { signedUrl: null, release: null, error: 'No se pudo preparar la descarga.' }
  }

  return { signedUrl: data.signedUrl, release, expiresIn: SIGNED_URL_EXPIRES_IN, error: null }
}
