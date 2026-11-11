import type { previewSalesOrderAuditCommercialAcceptance } from '@/app/actions/logistica/sales-order-audit-commercial-preview'
import type { confirmSalesOrderAuditCommercialAcceptance } from '@/app/actions/logistica/sales-order-audit-commercial-confirm'

export type CommercialPreview = NonNullable<Awaited<ReturnType<typeof previewSalesOrderAuditCommercialAcceptance>>['data']>
type Context = { companyId: string; cardId: string; auditId: string }

export function commercialErrorMessage(error: string): string {
  if (/AUDIT_REVIEW_INVALID|AUDIT_COMMERCIAL_REVIEW_CHANGED|AUDIT_PHYSICAL_SNAPSHOT_CHANGED|AUDIT_CURRENT_DOCUMENT_STALE|AUDIT_ACCEPTANCE_PREVIOUS_VERSION_STALE|AUDIT_ACCEPTANCE_IDENTITY_CHANGED/.test(error)) return 'La revisión venció o los datos cambiaron. Vuelve a revisar el cambio comercial.'
  if (/AUDIT_OPEN_INCIDENTS|AUDIT_ACCEPTANCE_OPEN_INCIDENTS/.test(error)) return 'Hay incidencias abiertas que impiden aceptar el cambio comercial.'
  if (/AUDIT_NOT_OPEN|AUDIT_ACCEPTANCE_AUDIT_NOT_OPEN|AUDIT_ACCEPTANCE_CARD_NOT_IN_AUDIT/.test(error)) return 'La Auditoría ya no está abierta o la tarjeta cambió de estado.'
  if (/AUDIT_PHYSICAL|AUDIT_ACCEPTANCE_PHYSICAL|AUDIT_ACCEPTANCE_PACKAGES_REQUIRED/.test(error)) return 'Las cantidades auditadas o los bultos no cumplen los requisitos para aceptar el cambio.'
  if (/PERMISSION|DENIED|No autorizado|no tienes permiso/i.test(error)) return 'No tienes autorización para aceptar el cambio comercial.'
  if (/BSALE|Bsale|fetch|network/i.test(error)) return 'No se pudo consultar Bsale. Inténtalo nuevamente.'
  return error
}

export async function loadCommercialReview(context: Context, action: typeof previewSalesOrderAuditCommercialAcceptance): Promise<CommercialPreview> {
  try {
    const result = await action(context)
    if (result.error || !result.data) throw new Error(result.error || 'No se pudo revisar el cambio comercial.')
    return result.data
  } catch (error) { throw new Error(commercialErrorMessage(error instanceof Error ? error.message : 'No se pudo revisar el cambio comercial.')) }
}

export async function acceptCommercialReview(context: Context, preview: CommercialPreview | null, approved: boolean, action: typeof confirmSalesOrderAuditCommercialAcceptance) {
  if (!approved || !preview?.eligible || !preview.reviewedReference) throw new Error('Confirma explícitamente una revisión comercial elegible.')
  try {
    const result = await action({ ...context, reviewedReference: preview.reviewedReference })
    if (result.error || !result.data) throw new Error(result.error || 'No se pudo aceptar el cambio comercial.')
    return result.data
  } catch (error) { throw new Error(commercialErrorMessage(error instanceof Error ? error.message : 'No se pudo aceptar el cambio comercial.')) }
}
