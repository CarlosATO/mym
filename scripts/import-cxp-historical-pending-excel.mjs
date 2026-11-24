import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'))
const XLSX = requireFromRepo('xlsx')
const pg = requireFromRepo('pg')

export const CAYLO_COMPANY_ID = 'd1000000-0000-0000-0000-000000000001'
export const EXPECTED_EXCEL_SHA256 =
  '44d49cbabfcfbbae1d75b35165fce13d77448b948f6bcbbe2f2e2607819bd543'
export const EXPECTED_PENDING_COUNT = 70
export const EXPECTED_ORIGINAL_TOTAL_CLP = 153579937
export const EXPECTED_CREDIT_NOTE_TOTAL_CLP = 11548591
export const EXPECTED_PENDING_TOTAL_CLP = 142031346

function normalizeRut(raw) {
  const s = String(raw ?? '')
    .trim()
    .toUpperCase()
    .replace(/[.-\s]/g, '')
  return /^[0-9]{7,8}[0-9K]$/.test(s) ? s : null
}

function normalizeFolio(raw) {
  const s = String(raw ?? '')
    .trim()
    .replace(/\.0+$/, '')
  if (!/^[0-9]+$/.test(s)) return null
  return s.replace(/^0+([0-9])/, '$1')
}

function excelSerialToIso(val) {
  if (val == null || val === '') return null
  if (typeof val === 'number') {
    const d = XLSX.SSF.parse_date_code(val)
    if (!d) return null
    return `${String(d.y).padStart(4, '0')}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`
  }
  const s = String(val).trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  const m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s)
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`
  return null
}

export function extractPendingInvoicesFromWorkbookBuffer(buf) {
  const sha256 = crypto.createHash('sha256').update(buf).digest('hex')
  const wb = XLSX.read(buf, { type: 'buffer' })
  const ws = wb.Sheets.CAYLO
  assert.ok(ws, 'Debe existir la hoja CAYLO en el archivo Excel')

  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null })
  const pendingRecords = []
  const seenKeys = new Set()

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]
    if (!r || r.every(c => c == null || String(c).trim() === '')) continue
    const statusColL = String(r[11] ?? '').trim().toUpperCase()
    if (statusColL !== '') continue

    const rut = normalizeRut(r[1])
    const folio = normalizeFolio(r[3])
    const issueDate = excelSerialToIso(r[4])
    // Columna G (r[6]) = Vencimiento; la columna H (r[7]) es Fecha Pago y nunca se usa como vencimiento.
    const excelDueDate = excelSerialToIso(r[6])
    const originalAmount = Math.round(Number(r[8] ?? 0))
    const creditNoteAmount =
      r[9] != null && r[9] !== '' ? Math.round(Number(r[9])) : 0
    const pendingBalance =
      r[10] != null && r[10] !== ''
        ? Math.round(Number(r[10]))
        : originalAmount - creditNoteAmount

    assert.ok(rut, `Fila ${i + 1}: RUT inválido`)
    assert.ok(folio, `Fila ${i + 1}: Folio inválido`)
    assert.ok(issueDate, `Fila ${i + 1}: Fecha de documento inválida`)
    assert.ok(originalAmount > 0, `Fila ${i + 1}: Monto original debe ser > 0`)
    assert.ok(creditNoteAmount >= 0, `Fila ${i + 1}: NC no puede ser negativa`)
    assert.equal(
      originalAmount - creditNoteAmount,
      pendingBalance,
      `Fila ${i + 1}: original - NC debe coincidir exactamente con saldo`
    )

    const identityKey = `${rut}:${folio}`
    assert.ok(!seenKeys.has(identityKey), `Identidad duplicada en Excel: ${identityKey}`)
    seenKeys.add(identityKey)

    pendingRecords.push({
      sourceRow: i + 1,
      issuerRutNormalized: rut,
      supplierName: String(r[2] ?? '').trim() || null,
      documentFolio: folio,
      documentIssueDate: issueDate,
      excelDueDate,
      originalAmountClp: originalAmount,
      creditNoteAmountClp: creditNoteAmount,
      pendingBalanceClp: pendingBalance,
      excelObservation: r[12] != null ? String(r[12]).trim() || null : null,
    })
  }

  const totalOriginal = pendingRecords.reduce((s, r) => s + r.originalAmountClp, 0)
  const totalCreditNotes = pendingRecords.reduce((s, r) => s + r.creditNoteAmountClp, 0)
  const totalPending = pendingRecords.reduce((s, r) => s + r.pendingBalanceClp, 0)

  assert.equal(pendingRecords.length, EXPECTED_PENDING_COUNT)
  assert.equal(totalOriginal, EXPECTED_ORIGINAL_TOTAL_CLP)
  assert.equal(totalCreditNotes, EXPECTED_CREDIT_NOTE_TOTAL_CLP)
  assert.equal(totalPending, EXPECTED_PENDING_TOTAL_CLP)

  return {
    sha256,
    pendingRecords,
    totals: {
      count: pendingRecords.length,
      originalAmountClp: totalOriginal,
      creditNoteAmountClp: totalCreditNotes,
      pendingBalanceClp: totalPending,
    },
  }
}

async function main() {
  const executeMode = process.argv.includes('--execute')
  const fileArg = process.argv.find(a => a.startsWith('--file='))
  const defaultPaths = [
    fileArg ? fileArg.slice('--file='.length) : null,
    path.join(process.env.HOME || '', 'Downloads', 'COMPRAS(1).xlsx'),
    path.join(process.env.HOME || '', 'Downloads', 'COMPRAS.xlsx'),
  ].filter(Boolean)

  const excelPath = defaultPaths.find(p => fs.existsSync(p))
  if (!excelPath) {
    throw new Error('No se encontró COMPRAS(1).xlsx / COMPRAS.xlsx')
  }

  const buf = fs.readFileSync(excelPath)
  const extracted = extractPendingInvoicesFromWorkbookBuffer(buf)
  assert.equal(
    extracted.sha256,
    EXPECTED_EXCEL_SHA256,
    'El SHA-256 del archivo Excel debe coincidir con el lote histórico verificado'
  )

  const envSupa = fs.readFileSync(path.join(process.cwd(), '.env.supabase.local'), 'utf8')
  const pass = envSupa.match(/SUPABASE_DB_PASSWORD=(.+)/)[1].trim()
  const client = new pg.Client({
    connectionString: `postgresql://postgres.oekmztbfasmildyuajji:${pass}@aws-1-us-east-2.pooler.supabase.com:6543/postgres`,
  })
  await client.connect()

  try {
    // 1. Verificar coincidencia exacta 70/70 con Bsale y 0 traslape con los 1.589 pagados
    const bsaleRes = await client.query(
      `SELECT bsale_document_id, issuer_rut_normalized, document_number::text AS folio,
              emission_date::text AS emission_date, total_amount::float8 AS total_amount
       FROM integraciones.bsale_third_party_documents
       WHERE company_id = $1 AND code_sii IN ('33', '34')`,
      [CAYLO_COMPANY_ID]
    )
    const paidRes = await client.query(
      `SELECT issuer_rut_normalized, document_folio
       FROM cuentas_por_pagar.historical_paid_excel_records
       WHERE company_id = $1`,
      [CAYLO_COMPANY_ID]
    )

    const paidKeys = new Set(
      paidRes.rows.map(r => `${r.issuer_rut_normalized}:${r.document_folio}`)
    )
    const bsaleByKey = new Map()
    for (const d of bsaleRes.rows) {
      const k = `${d.issuer_rut_normalized}:${d.folio}`
      if (!bsaleByKey.has(k)) bsaleByKey.set(k, [])
      bsaleByKey.get(k).push(d)
    }

    let exactBsaleMatches = 0
    for (const rec of extracted.pendingRecords) {
      const k = `${rec.issuerRutNormalized}:${rec.documentFolio}`
      assert.ok(!paidKeys.has(k), `Traslape prohibido con pagados históricos: ${k}`)
      const cands = bsaleByKey.get(k) || []
      assert.equal(cands.length, 1, `Debe existir exactamente 1 DTE Bsale para ${k}`)
      const d = cands[0]
      assert.equal(d.emission_date, rec.documentIssueDate, `Emisión distinta en ${k}`)
      assert.equal(Math.round(d.total_amount), rec.originalAmountClp, `Monto original distinto en ${k}`)
      exactBsaleMatches++
    }

    console.log(
      JSON.stringify(
        {
          mode: executeMode ? 'EXECUTE' : 'DRY_RUN',
          excelPath,
          sha256: extracted.sha256,
          totals: extracted.totals,
          exactBsaleMatches,
          overlapWithPaidRecords: 0,
        },
        null,
        2
      )
    )

    if (!executeMode) {
      console.log('Dry-run completado sin escribir en producción.')
      return
    }

    // Modo --execute (solo cuando se autorice tras aplicar la migración 20261123201000)
    await client.query('BEGIN')
    const existingBatch = await client.query(
      `SELECT id FROM cuentas_por_pagar.historical_pending_excel_batches
       WHERE company_id = $1 AND source_sha256 = $2`,
      [CAYLO_COMPANY_ID, extracted.sha256]
    )
    if (existingBatch.rows.length > 0) {
      console.log('Lote ya importado previamente (idempotente):', existingBatch.rows[0].id)
      await client.query('ROLLBACK')
      return
    }

    const batchInsert = await client.query(
      `INSERT INTO cuentas_por_pagar.historical_pending_excel_batches (
         company_id, source_filename, source_sheet, source_sha256,
         expected_pending_count, expected_original_total_clp,
         expected_credit_note_total_clp, expected_pending_total_clp,
         declared_authorization
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [
        CAYLO_COMPANY_ID,
        'COMPRAS(1).xlsx',
        'CAYLO',
        extracted.sha256,
        extracted.totals.count,
        extracted.totals.originalAmountClp,
        extracted.totals.creditNoteAmountClp,
        extracted.totals.pendingBalanceClp,
        '2026-11-23: incorporación de 70 facturas pendientes históricas de referencia desde hoja CAYLO',
      ]
    )
    const batchId = batchInsert.rows[0].id

    for (const rec of extracted.pendingRecords) {
      await client.query(
        `INSERT INTO cuentas_por_pagar.historical_pending_excel_records (
           company_id, batch_id, source_row, issuer_rut_normalized, supplier_name,
           document_folio, document_issue_date, excel_due_date,
           original_amount_clp, credit_note_amount_clp, pending_balance_clp,
           excel_observation
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          CAYLO_COMPANY_ID,
          batchId,
          rec.sourceRow,
          rec.issuerRutNormalized,
          rec.supplierName,
          rec.documentFolio,
          rec.documentIssueDate,
          rec.excelDueDate,
          rec.originalAmountClp,
          rec.creditNoteAmountClp,
          rec.pendingBalanceClp,
          rec.excelObservation,
        ]
      )
    }
    await client.query('COMMIT')
    console.log('Importación ejecutada con éxito. Batch ID:', batchId)
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    await client.end()
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch(err => {
    console.error(err)
    process.exit(1)
  })
}
