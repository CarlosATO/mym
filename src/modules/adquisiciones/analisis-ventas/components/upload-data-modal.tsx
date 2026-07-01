'use client'

import React, { useState, useRef } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { FileSpreadsheet, Loader2, UploadCloud, CheckCircle2 } from 'lucide-react'
import * as XLSX from 'xlsx'
import {
  parseAndNormalizeSales,
  parseAndNormalizeStock,
  buildSkuSummary,
  classifySkus,
  buildFullReport,
} from '../utils/analytics'
import { saveSalesAnalysisReport } from '@/app/actions/adquisiciones/analisis-ventas'
import { toast } from 'sonner'

interface UploadDataModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSuccess: () => void
}

/** Lee un Excel y lo retorna como array de filas crudas, detectando dinámicamente el encabezado (fila con 'SKU') */
function readExcelAsRows(file: File): Promise<any[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const workbook = XLSX.read(data, { type: 'array' })
        const ws = workbook.Sheets[workbook.SheetNames[0]]
        const rawRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }) as any[][]

        // Encontrar fila de encabezados buscando 'SKU'
        let headerIdx = 0
        for (let i = 0; i < Math.min(rawRows.length, 15); i++) {
          const rowUpper = rawRows[i].map(v => String(v).trim().toUpperCase())
          if (rowUpper.includes('SKU')) { headerIdx = i; break }
        }
        const json = XLSX.utils.sheet_to_json(ws, { range: headerIdx, defval: '' })
        resolve(json)
      } catch {
        reject(new Error(`Error parseando ${file.name}`))
      }
    }
    reader.onerror = () => reject(new Error(`Error leyendo ${file.name}`))
    reader.readAsArrayBuffer(file)
  })
}

export function UploadDataModal({ open, onOpenChange, onSuccess }: UploadDataModalProps) {
  const [salesFile, setSalesFile] = useState<File | null>(null)
  const [stockFile, setStockFile] = useState<File | null>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [targetCoverage, setTargetCoverage] = useState(4)
  const [progress, setProgress] = useState('')

  const salesInputRef = useRef<HTMLInputElement>(null)
  const stockInputRef = useRef<HTMLInputElement>(null)

  const handleProcess = async () => {
    if (!salesFile || !stockFile) {
      toast.error('Debe cargar ambos archivos (Ventas y Stock)')
      return
    }
    setIsProcessing(true)
    try {
      setProgress('Leyendo archivos Excel...')
      const [salesRaw, stockRaw] = await Promise.all([
        readExcelAsRows(salesFile),
        readExcelAsRows(stockFile),
      ])

      setProgress('Normalizando datos de ventas...')
      const { sales, diagnostics: salesDiag, minDate, maxDate } = parseAndNormalizeSales(salesRaw)

      setProgress('Normalizando datos de stock...')
      const { stock, diagnostics: stockDiag } = parseAndNormalizeStock(stockRaw)

      setProgress('Calculando métricas por SKU...')
      const skuSummary = buildSkuSummary(sales, stock, maxDate, minDate, maxDate, targetCoverage)
      const classifiedSkus = classifySkus(skuSummary)

      const totalSales = sales.reduce((acc, s) => acc + s.venta_bruta, 0)
      const diagnostics = {
        ...salesDiag,
        ...stockDiag,
        skus_sold: new Set(sales.map(s => s.SKU)).size,
        skus_stock: new Set(stock.map(s => s.SKU)).size,
        date_from: minDate.toISOString().split('T')[0],
        date_to: maxDate.toISOString().split('T')[0],
      }

      setProgress('Guardando reporte en la nube...')
      const report = buildFullReport(classifiedSkus, minDate, maxDate, targetCoverage, totalSales, diagnostics)
      
      // Guardar datos crudos en localStorage para re-análisis dinámico sin re-subir archivos
      try {
        localStorage.setItem('mym_analytics_raw_sales', JSON.stringify(salesRaw))
        localStorage.setItem('mym_analytics_raw_stock', JSON.stringify(stockRaw))
      } catch { /* quota exceeded — silently ignore */ }

      const result = await saveSalesAnalysisReport(report)
      if (!result.success) throw new Error(result.error)

      toast.success(`Reporte generado: ${classifiedSkus.length} SKUs analizados`)
      onSuccess()
      onOpenChange(false)
    } catch (error: any) {
      console.error(error)
      toast.error(error.message || 'Ocurrió un error al procesar los archivos')
    } finally {
      setIsProcessing(false)
      setProgress('')
    }
  }

  const reset = () => { setSalesFile(null); setStockFile(null); setTargetCoverage(4); setProgress('') }

  const FileDropZone = ({
    file, onFileSet, inputRef, label,
  }: { file: File | null; onFileSet: (f: File) => void; inputRef: React.RefObject<HTMLInputElement>; label: string }) => (
    <div className="space-y-1.5">
      <label className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">{label}</label>
      <div
        className={`border-2 border-dashed rounded-lg p-5 flex flex-col items-center justify-center cursor-pointer transition-all ${
          file ? 'border-theme-primary/60 bg-theme-primary/5' : 'border-theme-border hover:border-theme-primary/40 hover:bg-theme-text/5'
        }`}
        onClick={() => inputRef.current?.click()}
      >
        {file ? (
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-5 w-5 text-theme-primary shrink-0" />
            <p className="text-sm font-semibold text-theme-text text-center break-all">{file.name}</p>
          </div>
        ) : (
          <>
            <FileSpreadsheet className="h-7 w-7 mb-2 text-theme-text-muted" />
            <p className="text-sm font-medium text-theme-text-muted">Click para seleccionar archivo Excel</p>
            <p className="text-xs text-theme-text-muted/60 mt-0.5">.xlsx / .xls</p>
          </>
        )}
        <input
          type="file" ref={inputRef} className="hidden" accept=".xlsx,.xls"
          onChange={(e) => e.target.files?.[0] && onFileSet(e.target.files[0])}
        />
      </div>
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(val) => { if (!val) reset(); onOpenChange(val) }}>
      <DialogContent className="sm:max-w-[500px]">
        <DialogHeader>
          <DialogTitle>Generar Reporte de Análisis</DialogTitle>
          <DialogDescription>
            Cargue los archivos exportados desde Bsale. Los datos quedan guardados en la nube para consulta posterior.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <FileDropZone file={salesFile} onFileSet={setSalesFile} inputRef={salesInputRef as any} label="Archivo de Ventas (.xlsx)" />
          <FileDropZone file={stockFile} onFileSet={setStockFile} inputRef={stockInputRef as any} label="Archivo de Stock (.xlsx)" />

          <div className="space-y-1.5">
            <label className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">Cobertura Objetivo</label>
            <select
              className="flex h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 py-2 text-sm text-theme-text ring-offset-0 focus:outline-none focus:ring-2 focus:ring-theme-primary"
              value={targetCoverage}
              onChange={(e) => setTargetCoverage(Number(e.target.value))}
            >
              <option value={1}>1 Semana</option>
              <option value={2}>2 Semanas</option>
              <option value={3}>3 Semanas</option>
              <option value={4}>4 Semanas (1 Mes)</option>
              <option value={6}>6 Semanas</option>
              <option value={8}>8 Semanas (2 Meses)</option>
            </select>
          </div>

          {isProcessing && progress && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-theme-primary/10 border border-theme-primary/20">
              <Loader2 className="h-4 w-4 animate-spin text-theme-primary shrink-0" />
              <span className="text-xs font-medium text-theme-primary">{progress}</span>
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isProcessing}>Cancelar</Button>
          <Button onClick={handleProcess} disabled={isProcessing || !salesFile || !stockFile} className="gap-2">
            {isProcessing ? <Loader2 className="h-4 w-4 animate-spin" /> : <UploadCloud className="h-4 w-4" />}
            {isProcessing ? 'Procesando...' : 'Procesar y Guardar'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
