import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function parsePercent(raw: string | number | null | undefined): number {
  if (raw == null) return 0
  if (typeof raw === 'number') return raw
  const cleaned = raw.replace(',', '.').replace(/[^0-9.\-]/g, '')
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : 0
}

export function formatPercent(value: number | null | undefined, decimals?: number): string {
  if (value == null || !Number.isFinite(value)) return '0%'
  const dec = decimals ?? (value % 1 === 0 ? 0 : 2)
  return value.toLocaleString('es-CL', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  }) + '%'
}
