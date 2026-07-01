'use server'

import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import { getActiveCompanyId } from '@/app/actions/companies'
import {
  SETTLEMENT_ATTACHMENT_BUCKET,
  SETTLEMENT_ATTACHMENT_ALLOWED_MIMES,
  SETTLEMENT_ATTACHMENT_MAX_SIZE,
} from '@/modules/adquisiciones/rendicion-rutas/utils/settlement-attachment-config'



export interface SettlementItemAttachment {
  id: string
  company_id: string
  settlement_id: string
  settlement_item_id: string
  file_name: string
  storage_bucket: string
  storage_path: string
  file_mime_type: string | null
  file_size: number | null
  notes: string | null
  uploaded_by: string
  uploaded_at: string
}

async function createAdquisicionesClient() {
  const cookieStore = await cookies()
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      db: { schema: 'adquisiciones' },
      cookies: {
        getAll() { return cookieStore.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        },
      },
    }
  )
}

async function requirePermission(db: any, userId: string, permissionCode: string) {
  const { data, error } = await db.schema('portal').rpc('user_has_permission', {
    p_user_id: userId,
    p_permission_code: permissionCode,
  })

  if (error) throw error
  if (!data) throw new Error('No tiene permisos para realizar esta acción.')
}

/**
 * 8. saveSettlementItemAttachment
 * Guarda los metadatos del adjunto DESPUÉS de que el cliente haya subido el archivo
 * a Supabase Storage. El archivo ya existe en storage; aquí solo se registra en BD.
 * Verifica que el settlement_item pertenezca a la empresa activa.
 */
export async function saveSettlementItemAttachment(params: {
  settlementItemId: string
  settlementId: string
  filePath: string
  fileName: string
  fileMimeType: string
  fileSize: number
  notes?: string
}) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.update')

    if (params.fileSize > SETTLEMENT_ATTACHMENT_MAX_SIZE) {
      throw new Error('El archivo supera el límite de 10 MB.')
    }
    if (!(SETTLEMENT_ATTACHMENT_ALLOWED_MIMES as readonly string[]).includes(params.fileMimeType)) {
      throw new Error('Tipo de archivo no permitido. Solo PDF, PNG, JPG o WebP.')
    }

    const expectedPathPrefix = `${companyId}/rendicion-rutas/${params.settlementId}/`
    if (!params.filePath.startsWith(expectedPathPrefix)) {
      throw new Error('Ruta de archivo inválida para esta empresa o rendición.')
    }

    // Verificar que el item pertenece a la empresa
    const { data: item, error: itemErr } = await adquisicionesDb
      .from('route_settlement_items')
      .select('id, company_id, settlement_id')
      .eq('id', params.settlementItemId)
      .eq('company_id', companyId)
      .single()

    if (itemErr || !item) throw new Error('Ítem no encontrado o sin acceso.')
    if (item.settlement_id !== params.settlementId) throw new Error('El ítem no pertenece a esta rendición.')

    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const adminDb = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      serviceKey,
      {
        db: { schema: 'adquisiciones' },
        cookies: { getAll() { return [] }, setAll() {} },
      }
    )

    const { data: inserted, error: insertErr } = await adminDb
      .from('route_settlement_item_attachments')
      .insert({
        company_id: companyId,
        settlement_id: params.settlementId,
        settlement_item_id: params.settlementItemId,
        file_name: params.fileName,
        storage_bucket: SETTLEMENT_ATTACHMENT_BUCKET,
        storage_path: params.filePath,
        file_mime_type: params.fileMimeType,
        file_size: params.fileSize,
        notes: params.notes ?? null,
        uploaded_by: userData.user.id,
      })
      .select()
      .single()

    if (insertErr) throw insertErr

    return { data: inserted as SettlementItemAttachment, error: null }
  } catch (err: any) {
    console.error('saveSettlementItemAttachment error:', err)
    return { data: null, error: err.message as string }
  }
}

/**
 * 9. getSettlementItemAttachments
 * Carga los adjuntos de UN ítem específico. No carga adjuntos de otros ítems.
 * Solo se llama al abrir el panel de edición de una factura.
 */
export async function getSettlementItemAttachments(settlementItemId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')

    const { data, error } = await adquisicionesDb
      .from('route_settlement_item_attachments')
      .select('*')
      .eq('settlement_item_id', settlementItemId)
      .eq('company_id', companyId)
      .order('uploaded_at', { ascending: true })

    if (error) throw error

    return { data: (data || []) as SettlementItemAttachment[], error: null }
  } catch (err: any) {
    console.error('getSettlementItemAttachments error:', err)
    return { data: null, error: err.message as string }
  }
}

/**
 * 9.1 getSettlementAttachmentsBySettlement
 * Carga todos los adjuntos de una rendición en una sola llamada.
 * Permite que la guía muestre documentos sin N+1 desde frontend.
 */
export async function getSettlementAttachmentsBySettlement(settlementId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')

    const { data: settlement, error: settlementErr } = await adquisicionesDb
      .from('route_settlements')
      .select('id, company_id')
      .eq('id', settlementId)
      .eq('company_id', companyId)
      .single()

    if (settlementErr || !settlement) throw new Error('Rendición no encontrada o sin acceso.')

    const { data, error } = await adquisicionesDb
      .from('route_settlement_item_attachments')
      .select('*')
      .eq('settlement_id', settlementId)
      .eq('company_id', companyId)
      .order('uploaded_at', { ascending: true })

    if (error) throw error

    return { data: (data || []) as SettlementItemAttachment[], error: null }
  } catch (err: any) {
    console.error('getSettlementAttachmentsBySettlement error:', err)
    return { data: null, error: err.message as string }
  }
}

/**
 * 10. getSettlementAttachmentSignedUrl
 * Genera una URL firmada (5 min) para ver/descargar un adjunto.
 * Verifica acceso a la empresa antes de generar la URL.
 */
export async function getSettlementAttachmentSignedUrl(attachmentId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.view')

    const { data: attachment, error: attErr } = await adquisicionesDb
      .from('route_settlement_item_attachments')
      .select('id, company_id, storage_bucket, storage_path, file_name, file_mime_type')
      .eq('id', attachmentId)
      .eq('company_id', companyId)
      .single()

    if (attErr || !attachment) throw new Error('Adjunto no encontrado o sin acceso.')

    const { data: signed, error: signErr } = await adquisicionesDb.storage
      .from(attachment.storage_bucket || SETTLEMENT_ATTACHMENT_BUCKET)
      .createSignedUrl(attachment.storage_path, 300) // 5 min

    if (signErr || !signed?.signedUrl) throw new Error('No se pudo generar la URL de previsualización.')

    return {
      data: {
        signedUrl: signed.signedUrl,
        fileName: attachment.file_name,
        mimeType: attachment.file_mime_type,
        expiresIn: 300,
      },
      error: null,
    }
  } catch (err: any) {
    console.error('getSettlementAttachmentSignedUrl error:', err)
    return { data: null, error: err.message as string }
  }
}

/**
 * 11. deleteSettlementItemAttachment
 * Elimina el registro de BD y el archivo en storage.
 */
export async function deleteSettlementItemAttachment(attachmentId: string) {
  const adquisicionesDb = await createAdquisicionesClient()

  try {
    const { data: userData, error: userError } = await adquisicionesDb.auth.getUser()
    if (userError || !userData?.user) throw new Error('No autorizado')

    const companyId = await getActiveCompanyId(userData.user)
    if (!companyId) throw new Error('No se pudo cargar la empresa activa.')
    await requirePermission(adquisicionesDb, userData.user.id, 'adquisiciones.route_settlements.update')

    const { data: attachment, error: attErr } = await adquisicionesDb
      .from('route_settlement_item_attachments')
      .select('id, company_id, storage_bucket, storage_path')
      .eq('id', attachmentId)
      .eq('company_id', companyId)
      .single()

    if (attErr || !attachment) throw new Error('Adjunto no encontrado o sin acceso.')

    // Borrar de storage primero usando adquisicionesDb para aprovechar token u adminDb
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!
    const adminDb = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      serviceKey,
      {
        db: { schema: 'adquisiciones' },
        cookies: { getAll() { return [] }, setAll() {} },
      }
    )

    const { error: storageErr } = await adminDb.storage
      .from(attachment.storage_bucket || SETTLEMENT_ATTACHMENT_BUCKET)
      .remove([attachment.storage_path])

    if (storageErr) throw new Error(`No se pudo eliminar el archivo del storage: ${storageErr.message}`)

    // Borrar de BD
    const { error: delErr } = await adminDb
      .from('route_settlement_item_attachments')
      .delete()
      .eq('id', attachmentId)

    if (delErr) throw delErr

    return { data: { deleted: true }, error: null }
  } catch (err: any) {
    console.error('deleteSettlementItemAttachment error:', err)
    return { data: null, error: err.message as string }
  }
}
