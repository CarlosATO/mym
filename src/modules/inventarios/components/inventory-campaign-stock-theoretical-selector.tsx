'use client'

import { useState } from 'react'
import { Check, ChevronRight, FileSpreadsheet, Grid2x2, MapPin, Warehouse } from 'lucide-react'

type TheoreticalStockFormat = 'TOTAL_CAMPAIGN' | 'BY_SITE' | 'BY_LOCATION'

interface TheoreticalStockOption {
  value: TheoreticalStockFormat
  label: string
  description: string
  columns: string[]
  icon: React.ReactNode
}

interface InventoryCampaignStockTheoreticalSelectorProps {
  canRead: boolean
  canManage: boolean
}

const OPTIONS: TheoreticalStockOption[] = [
  {
    value: 'TOTAL_CAMPAIGN',
    label: 'Total de la campaña',
    description: 'Una cantidad total por producto, considerando todas las unidades incluidas. No requiere bodega ni ubicación.',
    columns: ['SKU', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
    icon: <Grid2x2 className="h-4 w-4" />,
  },
  {
    value: 'BY_SITE',
    label: 'Desglosado por bodega',
    description: 'El mismo archivo indica cuánto corresponde a cada bodega o unidad.',
    columns: ['SKU', 'CODIGO_UNIDAD', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
    icon: <Warehouse className="h-4 w-4" />,
  },
  {
    value: 'BY_LOCATION',
    label: 'Desglosado por ubicación',
    description: 'El mismo archivo indica la bodega y ubicación correspondiente a cada cantidad.',
    columns: ['SKU', 'CODIGO_UNIDAD', 'CODIGO_UBICACION', 'CANTIDAD_TEORICA', 'COSTO_UNITARIO'],
    icon: <MapPin className="h-4 w-4" />,
  },
]

const FORMAT_LABELS: Record<TheoreticalStockFormat, string> = {
  TOTAL_CAMPAIGN: 'Total de la campaña',
  BY_SITE: 'Desglosado por bodega',
  BY_LOCATION: 'Desglosado por ubicación',
}

export function InventoryCampaignStockTheoreticalSelector({ canRead, canManage }: InventoryCampaignStockTheoreticalSelectorProps) {
  const [open, setOpen] = useState(false)
  const [selected, setSelected] = useState<TheoreticalStockFormat | null>(null)
  const [draft, setDraft] = useState<TheoreticalStockFormat | null>(null)

  if (!canRead && !canManage) return null

  const committed = selected ? OPTIONS.find(option => option.value === selected) ?? null : null

  const openDialog = () => {
    setDraft(selected)
    setOpen(true)
  }

  const closeDialog = () => {
    setOpen(false)
    setDraft(selected)
  }

  const confirmSelection = () => {
    if (!draft) return
    setSelected(draft)
    setOpen(false)
  }

  return (
    <section className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-1">
          <h2 className="text-base font-bold text-theme-text">Stock teórico de la campaña</h2>
          <p className="text-sm text-theme-text-muted">El stock teórico se carga mediante un único Excel para toda la campaña.</p>
        </div>
        {canManage && (
          <button
            type="button"
            onClick={openDialog}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover"
          >
            <FileSpreadsheet className="h-4 w-4" />
            Configurar stock teórico
          </button>
        )}
      </div>

      {committed ? (
        <div className="mt-4 rounded-xl border border-theme-border/80 bg-theme-bg p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-theme-text-muted">Formato seleccionado</p>
              <p className="mt-1 text-sm font-semibold text-theme-text">{FORMAT_LABELS[committed.value]}</p>
            </div>
            <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:text-emerald-300">
              Archivo pendiente
            </span>
          </div>
          <p className="mt-3 text-sm text-theme-text-muted">{committed.description}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {committed.columns.map(column => (
              <span key={column} className="inline-flex rounded-full border border-theme-border bg-theme-surface px-2.5 py-1 text-xs font-medium text-theme-text-muted">
                {column}
              </span>
            ))}
          </div>
          <p className="mt-4 text-xs text-theme-text-muted">La selección se guardará al cargar el archivo.</p>
        </div>
      ) : (
        <div className="mt-4 rounded-xl border border-dashed border-theme-border bg-theme-bg p-4 text-sm text-theme-text-muted">
          Aún no has elegido el formato del Excel maestro.
        </div>
      )}

      {open && (
        <div className="fixed inset-0 z-[1200] flex items-center justify-center bg-black/40 p-4">
          <div className="w-full max-w-4xl rounded-2xl border border-theme-border bg-theme-surface shadow-2xl">
            <div className="flex items-start justify-between gap-3 border-b border-theme-border/60 px-5 py-4">
              <div className="space-y-1">
                <h3 className="text-base font-bold text-theme-text">Configurar stock teórico</h3>
                <p className="text-sm text-theme-text-muted">Elige una sola forma de estructurar el Excel maestro.</p>
              </div>
              <button
                type="button"
                onClick={closeDialog}
                className="rounded-lg px-2 py-1 text-sm text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-4 px-5 py-4">
              <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
                {OPTIONS.map(option => {
                  const active = draft === option.value
                  return (
                    <button
                      key={option.value}
                      type="button"
                      onClick={() => setDraft(option.value)}
                      className={`flex h-full flex-col rounded-xl border p-4 text-left transition-colors ${
                        active
                          ? 'border-theme-accent bg-theme-accent/10 ring-1 ring-theme-accent'
                          : 'border-theme-border bg-theme-bg hover:border-theme-accent/40 hover:bg-theme-text/5'
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <span className={`flex h-8 w-8 items-center justify-center rounded-lg ${active ? 'bg-theme-accent text-white' : 'bg-theme-text/5 text-theme-text-muted'}`}>
                          {option.icon}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-semibold text-theme-text">{option.label}</p>
                        </div>
                        {active && <Check className="h-4 w-4 text-theme-accent" />}
                      </div>
                      <p className="mt-3 text-sm text-theme-text-muted">{option.description}</p>
                      <div className="mt-4 rounded-lg border border-theme-border/70 bg-theme-surface p-3">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-theme-text-muted">Columnas esperadas</p>
                        <p className="mt-1 text-sm font-medium text-theme-text">{option.columns.join(' | ')}</p>
                      </div>
                    </button>
                  )
                })}
              </div>

              <div className="flex flex-col gap-3 border-t border-theme-border/60 pt-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-xs text-theme-text-muted">La selección se guardará al cargar el archivo.</p>
                <div className="flex items-center justify-end gap-2">
                  <button
                    type="button"
                    onClick={closeDialog}
                    className="inline-flex h-9 items-center rounded-lg border border-theme-border bg-theme-surface px-3 text-sm font-medium text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    onClick={confirmSelection}
                    disabled={!draft}
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-theme-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-theme-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    Confirmar formato
                    <ChevronRight className="h-4 w-4" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
