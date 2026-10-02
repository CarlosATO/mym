'use server'
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createHash } from 'node:crypto'
import { revalidatePath } from 'next/cache'
import { getActiveCompanyId } from '@/app/actions/companies'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { buildPayrollPreview, type PayrollParsedRow, type PayrollPreview } from '@/lib/control-financiero/payroll-parser'
import { validatePayrollImportMetadata, type PayrollImportMetadata } from '@/lib/control-financiero/payroll-import-contract'

type Db = any
const db = () => createAdminClient().schema('comercial') as Db
const PAYROLL_PATH = '/dashboard/analisis-comercial/control-financiero/libro-remuneraciones'

export type PayrollImportHistoryItem = {
  id: string
  period_year: number
  period_month: number
  source_filename: string
  imported_at: string | null
  worker_count: number
  row_count: number
  total_labor_cost: number
  status: string
}

type PayrollPreviewRow = Omit<PayrollParsedRow, 'rawValues' | 'rawValuesByCode'>

export type PayrollPreviewResult = {
  ok: true
  preview: Omit<PayrollPreview, 'parsedFile'> & { rows: PayrollPreviewRow[] }
  idempotency: {
    fileAlreadyImported: boolean
    periodAlreadyImported: boolean
    existingActiveImport: { id: string; source_filename: string; imported_at: string | null } | null
    previousVersions: Array<{ id: string; status: string; source_filename: string; imported_at: string | null }>
  }
} | { ok: false; message: string }

async function authenticatedContext(requestedCompanyId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const companyId = await getActiveCompanyId(user)
  if (!user || !companyId) throw new Error('La sesión o la empresa activa no están disponibles.')
  if (requestedCompanyId && requestedCompanyId !== companyId) throw new Error('La empresa seleccionada no coincide con la empresa activa.')
  return { user, companyId }
}

function snapshotRow(row: PayrollParsedRow) {
  return {
    source_row_number: row.sourceRowNumber,
    worker_rut_original: row.workerRutOriginal,
    worker_rut_normalized: row.workerRutNormalized,
    contract_start_date: row.contractStartDate,
    contract_end_date: row.contractEndDate,
    days_worked: row.daysWorked,
    medical_leave_days: row.medicalLeaveDays,
    vacation_days: row.vacationDays,
    salary: row.salary,
    gratification: row.gratification,
    business_salary: row.businessSalary,
    meal_allowance: row.mealAllowance,
    transport_allowance: row.transportAllowance,
    travel_allowance: row.travelAllowance,
    family_allowance: row.familyAllowance,
    holiday_indemnity: row.holidayIndemnity,
    worker_pension: row.workerPension,
    worker_health: row.workerHealth,
    worker_afc: row.workerAfc,
    income_tax: row.incomeTax,
    advances: row.advances,
    employer_afc: row.employerAfc,
    employer_accident_sanna: row.employerAccidentSanna,
    employer_sis: row.employerSis,
    total_earnings: row.totalEarnings,
    taxable_earnings: row.taxableEarnings,
    non_taxable_earnings: row.nonTaxableEarnings,
    non_taxable_taxable_earnings: row.nonTaxableTaxableEarnings,
    total_deductions: row.totalDeductions,
    total_worker_contributions: row.totalWorkerContributions,
    total_income_tax: row.totalIncomeTax,
    total_other_deductions: row.totalOtherDeductions,
    total_employer_contributions: row.totalEmployerContributions,
    net_pay: row.netPay,
    total_indemnities: row.totalIndemnities,
    taxable_indemnities: row.taxableIndemnities,
    non_taxable_indemnities: row.nonTaxableIndemnities,
  }
}

function publicPreview(preview: PayrollPreview): Extract<PayrollPreviewResult, { ok: true }>['preview'] {
  const { parsedFile, ...safePreview } = preview
  return {
    ...safePreview,
    rows: parsedFile.rows.map(row => {
      const { rawValues, rawValuesByCode, ...safeRow } = row
      void rawValues
      void rawValuesByCode
      return safeRow
    }),
  }
}

async function parseUploadedFile(formData: FormData) {
  const file = formData.get('file')
  if (!(file instanceof File)) throw new Error('Selecciona un archivo CSV.')
  if (!file.name.toLowerCase().endsWith('.csv')) throw new Error('El formato permitido es CSV.')
  const bytes = new Uint8Array(await file.arrayBuffer())
  const selectedYearValue = String(formData.get('selectedYear') ?? '').trim()
  const selectedYear = selectedYearValue ? Number(selectedYearValue) : undefined
  if (selectedYear !== undefined && (!Number.isInteger(selectedYear) || selectedYear < 2000 || selectedYear > 2100)) throw new Error('El año seleccionado no es válido.')
  return { file, bytes, selectedYear }
}

function withDatabaseValidation(preview: PayrollPreview, input: { fileAlreadyImported: boolean; periodAlreadyImported: boolean }) {
  const errors = [...preview.validation.errors]
  if (!preview.file.detectedMonth) errors.push('No se pudo determinar un mes válido desde el nombre del archivo.')
  if (preview.workers.duplicateRutCount > 0) errors.push('El archivo contiene RUT duplicados.')
  if (input.fileAlreadyImported) errors.push('Este archivo ya fue importado.')
  if (input.periodAlreadyImported) errors.push('Este período ya tiene una importación activa.')
  return { ...preview, validation: { ...preview.validation, errors, canImport: preview.validation.canImport && errors.length === 0 } }
}

function importErrorMessage(message: string) {
  if (message.startsWith('PAYROLL_METADATA_FIELD_MISSING:')) {
    const field = message.split(':', 2)[1]
    return `El resumen de remuneraciones está incompleto: falta ${field}.`
  }
  if (message.includes('Este archivo ya fue importado.')) return 'Este archivo ya fue importado.'
  if (message.includes('Este período ya tiene una importación activa.')) return 'Este período ya tiene una importación activa.'
  if (message.includes('La verificación post-inserción no coincide.')) return 'La importación no superó la verificación de totales y fue revertida.'
  return 'No se pudo importar el Libro de Remuneraciones. No se realizaron cambios.'
}

export async function previewPayrollFileAction(formData: FormData): Promise<PayrollPreviewResult> {
  try {
    const { companyId } = await authenticatedContext(String(formData.get('companyId') ?? '') || undefined)
    const { file, bytes, selectedYear } = await parseUploadedFile(formData)
    const preview = buildPayrollPreview(bytes, { filename: file.name, selectedYear })
    const [hashResult, activeResult, versionsResult] = await Promise.all([
      db().from('financial_payroll_imports').select('id').eq('company_id', companyId).eq('file_hash', preview.file.hash).maybeSingle(),
      preview.file.detectedMonth && selectedYear
        ? db().from('financial_payroll_imports').select('id,source_filename,imported_at').eq('company_id', companyId).eq('period_year', selectedYear).eq('period_month', preview.file.detectedMonth).eq('status', 'IMPORTED').maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      preview.file.detectedMonth && selectedYear
        ? db().from('financial_payroll_imports').select('id,status,source_filename,imported_at').eq('company_id', companyId).eq('period_year', selectedYear).eq('period_month', preview.file.detectedMonth).in('status', ['SUPERSEDED', 'CANCELLED']).order('imported_at', { ascending: false })
        : Promise.resolve({ data: [], error: null }),
    ])
    if (hashResult.error || activeResult.error || versionsResult.error) throw new Error(hashResult.error?.message ?? activeResult.error?.message ?? versionsResult.error?.message)
    const existingActiveImport = activeResult.data ?? null
    const safePreview = withDatabaseValidation(preview, { fileAlreadyImported: Boolean(hashResult.data), periodAlreadyImported: Boolean(existingActiveImport) })
    return {
      ok: true,
      preview: publicPreview(safePreview),
      idempotency: {
        fileAlreadyImported: Boolean(hashResult.data),
        periodAlreadyImported: Boolean(existingActiveImport),
        existingActiveImport,
        previousVersions: versionsResult.data ?? [],
      },
    }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : 'No se pudo analizar el archivo.' }
  }
}

export async function confirmPayrollImportAction(formData: FormData) {
  try {
    const { user, companyId } = await authenticatedContext(String(formData.get('companyId') ?? '') || undefined)
    const { file, bytes, selectedYear } = await parseUploadedFile(formData)
    if (!selectedYear) return { ok: false as const, message: 'Selecciona el año antes de confirmar.' }
    const preview = buildPayrollPreview(bytes, { filename: file.name, selectedYear })
    const validationErrors = [...preview.validation.errors]
    if (!preview.file.detectedMonth) validationErrors.push('No se pudo determinar un mes válido desde el nombre del archivo.')
    if (preview.workers.duplicateRutCount > 0) validationErrors.push('El archivo contiene RUT duplicados.')
    if (!preview.validation.canImport || validationErrors.length > 0 || !preview.file.detectedMonth) return { ok: false as const, message: validationErrors.join(' ') || 'El archivo no supera las validaciones de importación.' }
    const metadata: PayrollImportMetadata = {
      period_year: selectedYear,
      period_month: preview.file.detectedMonth,
      source_filename: preview.file.filename,
      file_hash: createHash('sha256').update(bytes).digest('hex'),
      source_format: 'CSV',
      source_encoding: preview.file.encoding,
      row_count: preview.file.rowCount,
      worker_count: preview.workers.workerCount,
      total_salary: preview.totals.totalSalary,
      total_taxable_earnings: preview.totals.totalTaxableEarnings,
      total_non_taxable_earnings: preview.totals.totalNonTaxableEarnings,
      total_earnings: preview.totals.totalEarnings,
      total_deductions: preview.totals.totalDeductions,
      total_worker_contributions: preview.totals.totalWorkerContributions,
      total_employer_contributions: preview.totals.totalEmployerContributions,
      total_net_pay: preview.totals.totalNetPay,
      total_indemnities: preview.totals.totalIndemnities,
      total_labor_cost: preview.totals.totalLaborCost,
      recurring_labor_cost: preview.totals.recurringLaborCost,
      validation_summary: { warnings: preview.validation.warnings },
    }
    const missingField = validatePayrollImportMetadata(metadata)
    if (missingField) return { ok: false as const, message: `El resumen de remuneraciones está incompleto: falta ${missingField}.` }
    const { data, error } = await db().rpc('import_financial_payroll_atomic', { p_company_id: companyId, p_imported_by: user.id, p_metadata: metadata, p_entries: preview.parsedFile.rows.map(snapshotRow) })
    if (error) return { ok: false as const, message: importErrorMessage(error.message) }
    revalidatePath(PAYROLL_PATH)
    return { ok: true as const, importId: (data as { import_id: string }).import_id }
  } catch (error) {
    return { ok: false as const, message: error instanceof Error ? error.message : 'No se pudo importar el Libro de Remuneraciones. No se realizaron cambios.' }
  }
}

export async function getPayrollImportHistory(year?: number): Promise<PayrollImportHistoryItem[]> {
  const { companyId } = await authenticatedContext()
  let query = db().from('financial_payroll_imports').select('id,period_year,period_month,source_filename,imported_at,worker_count,row_count,total_labor_cost,status').eq('company_id', companyId).order('period_year', { ascending: false }).order('period_month', { ascending: false })
  if (year) query = query.eq('period_year', year)
  const { data, error } = await query
  if (error) throw new Error(error.message)
  return (data ?? []) as PayrollImportHistoryItem[]
}
