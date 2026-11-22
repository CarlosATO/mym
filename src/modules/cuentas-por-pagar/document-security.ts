export interface InboxDocumentStorage {
  storage_bucket: string
  storage_path: string
  file_name: string | null
  mime_type: string | null
}

export function inboxDocumentMimeType(doc: InboxDocumentStorage, companyId: string): string | null {
  if (!['recepciones', 'cuentas-por-pagar'].includes(doc.storage_bucket) ||
      typeof doc.storage_path !== 'string' || !doc.storage_path.startsWith(`${companyId}/`) ||
      doc.storage_path.includes('..') || doc.storage_path.includes('//')) return null

  const extension = (doc.file_name || doc.storage_path).split('.').pop()?.toLowerCase()
  const inferred = extension === 'pdf' ? 'application/pdf'
    : extension === 'jpg' || extension === 'jpeg' ? 'image/jpeg'
      : extension === 'png' ? 'image/png'
        : extension === 'webp' ? 'image/webp' : null
  const mime = doc.mime_type || inferred
  return mime && ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'].includes(mime) ? mime : null
}
