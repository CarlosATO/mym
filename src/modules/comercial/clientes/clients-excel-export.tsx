'use client'

import { useRef, useState } from 'react'
import { AlertCircle, Download, Loader2 } from 'lucide-react'
import { getClientsExportData } from '@/app/actions/comercial/customers-export'
import { buildClientsWorkbook } from './clients-excel-workbook'

export async function downloadClientsWorkbook(): Promise<number> {
  const data = await getClientsExportData()
  const workbook = await buildClientsWorkbook(data)
  const buffer = await workbook.xlsx.writeBuffer()
  const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  const datePart = new Date().toISOString().slice(0, 10)
  anchor.download = `MYM_Informe_Gerencial_Clientes_${datePart}.xlsx`
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
  return data.clients.length
}

export function ClientsExcelExportButton() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)

  const handleExport = async () => {
    if (running.current) return
    running.current = true
    setLoading(true)
    setError(null)
    try {
      await downloadClientsWorkbook()
    } catch (err) {
      console.error('ClientsExcelExport error:', err)
      setError(err instanceof Error ? err.message : 'No se pudo generar el Excel')
    } finally {
      setLoading(false)
      running.current = false
    }
  }

  return (
    <div className="flex items-center gap-1.5">
      {error && (
        <span className="flex items-center gap-1 text-[10px] font-medium text-red-400 max-w-[220px] truncate" title={error}>
          <AlertCircle className="w-3.5 h-3.5 shrink-0" />{error}
        </span>
      )}
      <button
        type="button"
        onClick={handleExport}
        disabled={loading}
        title="Descargar informe gerencial de clientes por vendedor (.xlsx)"
        className="h-9 px-3 flex items-center gap-1.5 rounded-lg border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-theme-text text-xs font-bold shadow-sm transition-all shrink-0 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
        {loading ? 'Generando…' : 'Exportar Excel gerencial'}
      </button>
    </div>
  )
}
