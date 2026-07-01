const fs = require('fs');
const file = 'src/app/actions/logistica/recepciones.ts';

const contentToAppend = `
export async function getReceiptDocumentSignedUrl(document: any) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return { error: 'No autorizado' }

  const companyId = await getActiveCompanyId()
  if (!companyId) return { error: 'No se ha seleccionado una empresa activa' }

  const logistica = logDb()
  
  if (!document.storage_path) return { error: 'Documento sin ruta de almacenamiento' }

  const { data: receipt, error: receiptError } = await logistica
    .from('purchase_receipts')
    .select('id, company_id, purchase_order_id')
    .eq('id', document.receipt_id)
    .maybeSingle()

  if (receiptError) {
    console.error('getReceiptDocumentSignedUrl receipt error:', receiptError)
    return { error: 'Error al validar la recepción' }
  }

  if (!receipt) return { error: 'Recepción no encontrada' }
  if (receipt.company_id !== companyId) return { error: 'Acceso denegado a la recepción' }

  const adquisiciones = adqDb()
  const { data: purchaseOrder, error: poError } = await adquisiciones
    .from('purchase_orders')
    .select('id, company_id')
    .eq('id', receipt.purchase_order_id)
    .maybeSingle()

  if (poError) {
    console.error('getReceiptDocumentSignedUrl purchase order error:', poError)
    return { error: 'Error al validar la orden de compra' }
  }

  if (!purchaseOrder || purchaseOrder.company_id !== companyId) {
    return { error: 'Acceso denegado a la orden de compra' }
  }

  const expiresIn = 300
  const { data: signedData, error: signedError } = await logistica.storage
    .from(document.storage_bucket || 'recepciones')
    .createSignedUrl(document.storage_path, expiresIn)

  if (signedError || !signedData?.signedUrl) {
    console.error('getReceiptDocumentSignedUrl storage error:', signedError)
    return { error: 'No se pudo generar la previsualización del documento' }
  }

  return {
    signedUrl: signedData.signedUrl,
    fileName: document.file_name || 'Documento de recepción',
    mimeType: document.mime_type || null,
    expiresIn
  }
}
`;
fs.appendFileSync(file, contentToAppend, 'utf8');
