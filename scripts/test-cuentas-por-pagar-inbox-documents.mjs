import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { inboxDocumentMimeType } from '../src/modules/cuentas-por-pagar/document-security.ts'

const company = 'd1000000-0000-0000-0000-000000000001'
const pdf = { storage_bucket: 'recepciones', storage_path: `${company}/recepcion/factura.pdf`, file_name: 'factura.pdf', mime_type: 'application/pdf' }

test('admite archivos privados de Caylo con tipos conocidos', () => {
  assert.equal(inboxDocumentMimeType(pdf, company), 'application/pdf')
  assert.equal(inboxDocumentMimeType({ ...pdf, storage_bucket: 'cuentas-por-pagar', mime_type: null, file_name: 'imagen.png' }, company), 'image/png')
})

test('rechaza buckets, rutas y tipos ajenos o manipulados', () => {
  for (const bad of [
    { storage_bucket: 'public' },
    { storage_path: `otra-empresa/${company}/factura.pdf` },
    { storage_path: `${company}/../otra/factura.pdf` },
    { storage_path: `${company}//factura.pdf` },
    { mime_type: 'text/html' },
    { mime_type: null, file_name: 'documento.exe' },
  ]) assert.equal(inboxDocumentMimeType({ ...pdf, ...bad }, company), null)
})

test('la consulta de respaldos exige acceso e identidad y no modifica obligaciones', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20261120160000_cuentas_por_pagar_inbox_documents.sql', import.meta.url), 'utf8')
  assert.match(sql, /cuentas_por_pagar\.can_access\(v_company\)/)
  assert.match(sql, /c\.invoice_id IS NULL AND r\.id = ANY\(c\.receipt_ids\)/)
  assert.match(sql, /invoice_receipt_links/)
  assert.match(sql, /p\.supplier_id = c\.supplier_id/)
  assert.match(sql, /i\.document_folio = c\.folio/)
  assert.match(sql, /i\.purchase_type = 'SERVICES'/)
  assert.match(sql, /REVOKE ALL[\s\S]*FROM PUBLIC, anon/)
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO|FROM|cuentas_por_pagar|logistica)/i)
})
