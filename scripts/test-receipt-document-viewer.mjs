import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const action = await readFile(new URL('../src/app/actions/logistica/recepciones.ts', import.meta.url), 'utf8')
const panel = await readFile(new URL('../src/modules/logistica/recepciones/recepciones-panel.tsx', import.meta.url), 'utf8')
const viewer = await readFile(new URL('../src/modules/logistica/recepciones/receipt-document-viewer-modal.tsx', import.meta.url), 'utf8')

test('el acceso al documento recibe solo el identificador y valida el registro server-side', () => {
  assert.match(action, /getReceiptDocumentSignedUrl\(documentId: string\)/)
  assert.match(action, /\.from\('receipt_documents'\)/)
  assert.match(action, /\.eq\('id', documentId\)/)
  assert.match(action, /document\.company_id !== companyId/)
  assert.match(action, /document\.receipt_id/)
  assert.match(action, /purchaseOrder\.company_id !== companyId/)
  assert.match(action, /RECEIPT_DOCUMENT_BUCKET = 'recepciones'/)
  assert.match(action, /document\.storage_bucket !== RECEIPT_DOCUMENT_BUCKET/)
  assert.match(action, /document\.storage_path\.startsWith\(expectedPrefix\)/)
  assert.doesNotMatch(action, /getReceiptDocumentSignedUrl\(document: any\)/)
})

test('la acción genera enlaces temporales de vista y descarga desde el registro validado', () => {
  assert.match(action, /storage\.createSignedUrl\(document\.storage_path, expiresIn\)/)
  assert.match(action, /download: document\.file_name \|\| true/)
  assert.match(action, /downloadUrl: downloadData\.signedUrl/)
})

test('la interfaz muestra todos los documentos y omite el botón si no hay archivo', () => {
  assert.match(action, /receipt_documents: Array\.isArray\(receipt_documents\)/)
  assert.match(action, /has_file: Boolean\(document\.storage_path\)/)
  assert.match(panel, /documents\.map\(\(doc: any\)/)
  assert.match(panel, /doc\.has_file && <button/)
})

test('el visor soporta imagen/PDF, descarga y errores', () => {
  assert.match(viewer, /getReceiptDocumentSignedUrl\(documentId\)/)
  assert.match(viewer, /mimeType\.startsWith\('image\/'\)/)
  assert.match(viewer, /mimeType === 'application\/pdf'/)
  assert.match(viewer, /href=\{link\.downloadUrl\}/)
  assert.match(viewer, /No se pudo obtener el enlace temporal del documento/)
})
