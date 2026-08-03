'use client'

import type { WizardCatalogs, GeneralData } from '@/modules/inventarios/lib/wizard'

const INVENTORY_TYPES = [
  { value: 'GENERAL', label: 'General' },
  { value: 'PARTIAL', label: 'Parcial' },
  { value: 'CYCLIC', label: 'Cíclico' },
  { value: 'CONTROL', label: 'Control' },
  { value: 'RECOUNT', label: 'Recuento' },
]

const SCOPE_MODES = [
  { value: 'GENERAL', label: 'General', description: 'Incluye todas las variantes activas del catálogo.' },
  { value: 'PARTIAL', label: 'Parcial', description: 'Selecciona los productos que formarán parte de la jornada.' },
]

interface GeneralStepProps {
  data: GeneralData
  catalogs: WizardCatalogs
  onChange: (data: GeneralData) => void
}

export function InventoryGeneralStep({ data, catalogs, onChange }: GeneralStepProps) {
  const set = <K extends keyof GeneralData>(key: K, value: GeneralData[K]) => {
    onChange({ ...data, [key]: value })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <label htmlFor="session-name" className="block text-sm font-medium text-theme-text">
          Nombre de la jornada <span className="text-red-500">*</span>
        </label>
        <input
          id="session-name"
          value={data.name}
          onChange={e => set('name', e.target.value)}
          placeholder="Ej: Inventario general julio 2026"
          className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none placeholder:text-theme-text-muted/50 focus:border-theme-border-accent"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label htmlFor="inventory-type" className="block text-sm font-medium text-theme-text">
            Tipo de inventario <span className="text-red-500">*</span>
          </label>
          <select
            id="inventory-type"
            value={data.inventory_type}
            onChange={e => set('inventory_type', e.target.value)}
            className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-border-accent"
          >
            <option value="">Selecciona un tipo</option>
            {INVENTORY_TYPES.map(type => (
              <option key={type.value} value={type.value}>{type.label}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="warehouse" className="block text-sm font-medium text-theme-text">
            Bodega <span className="text-red-500">*</span>
          </label>
          <select
            id="warehouse"
            value={data.warehouse_id}
            onChange={e => set('warehouse_id', e.target.value)}
            className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-border-accent"
          >
            <option value="">Selecciona una bodega</option>
            {catalogs.warehouses.map(warehouse => (
              <option key={warehouse.id} value={warehouse.id}>{warehouse.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="office" className="block text-sm font-medium text-theme-text">
            Oficina Bsale <span className="text-red-500">*</span>
          </label>
          <select
            id="office"
            value={data.bsale_office_id}
            onChange={e => set('bsale_office_id', e.target.value)}
            className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-border-accent"
          >
            <option value="">Selecciona una oficina</option>
            {catalogs.offices.map(office => (
              <option key={office.bsale_id} value={String(office.bsale_id)}>
                {office.name ?? office.code ?? String(office.bsale_id)}
              </option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <label htmlFor="responsible" className="block text-sm font-medium text-theme-text">
            Responsable <span className="text-red-500">*</span>
          </label>
          <select
            id="responsible"
            value={data.responsible_user_id}
            onChange={e => set('responsible_user_id', e.target.value)}
            className="h-9 w-full rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none focus:border-theme-border-accent"
          >
            <option value="">Selecciona un responsable</option>
            {catalogs.users.map(user => (
              <option key={user.id} value={user.id}>
                {`${user.nombre} ${user.apellido}`.trim()}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-1.5">
        <span className="block text-sm font-medium text-theme-text">Modalidad de alcance</span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {SCOPE_MODES.map(mode => (
            <button
              key={mode.value}
              type="button"
              onClick={() => set('scope_mode', mode.value as GeneralData['scope_mode'])}
              className={`rounded-lg border p-3 text-left transition-colors ${
                data.scope_mode === mode.value
                  ? 'border-theme-accent bg-theme-accent/10'
                  : 'border-theme-border bg-theme-surface hover:bg-theme-text/5'
              }`}
            >
              <p className="text-sm font-semibold text-theme-text">{mode.label}</p>
              <p className="mt-0.5 text-xs text-theme-text-muted">{mode.description}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
