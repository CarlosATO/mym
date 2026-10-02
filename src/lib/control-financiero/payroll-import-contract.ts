export const REQUIRED_PAYROLL_IMPORT_NUMERIC_FIELDS = [
  'row_count',
  'worker_count',
  'total_salary',
  'total_taxable_earnings',
  'total_non_taxable_earnings',
  'total_earnings',
  'total_deductions',
  'total_worker_contributions',
  'total_employer_contributions',
  'total_net_pay',
  'total_indemnities',
  'total_labor_cost',
  'recurring_labor_cost',
] as const

export type PayrollImportMetadata = Record<string, unknown>

export function validatePayrollImportMetadata(metadata: PayrollImportMetadata): string | null {
  for (const field of REQUIRED_PAYROLL_IMPORT_NUMERIC_FIELDS) {
    const value = metadata[field]
    if (typeof value !== 'number' || !Number.isInteger(value) || !Number.isFinite(value)) {
      return field
    }
  }
  return null
}
