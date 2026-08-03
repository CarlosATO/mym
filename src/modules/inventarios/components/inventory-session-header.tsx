import Link from 'next/link'
import { ArrowLeft } from 'lucide-react'
import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { inventoryTypeLabel } from '@/modules/inventarios/lib/states'
import { formatDateChile } from '@/modules/inventarios/lib/format'

interface InventorySessionHeaderProps {
  detail: InventorySessionDetail
}

export function InventorySessionHeader({ detail }: InventorySessionHeaderProps) {
  const session = detail.session

  return (
    <div className="space-y-4">
      <Link
        href="/dashboard/inventarios/jornadas"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-theme-text-muted transition-colors hover:text-theme-text"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Volver a jornadas
      </Link>

      <div className="rounded-xl border border-theme-border bg-theme-surface p-5 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-2">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-base font-bold text-theme-text">#{session.session_number}</span>
              <h1 className="truncate text-lg font-bold text-theme-text">{session.name}</h1>
              <InventoryStatusBadge status={session.status} />
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-theme-text-muted">
              <span>{inventoryTypeLabel(session.inventory_type)}</span>
              <span>{session.scope_mode === 'PARTIAL' ? 'Alcance parcial' : 'Alcance general'}</span>
              <span>{session.warehouse_name ?? 'Bodega sin nombre'}</span>
              {session.responsible_name && <span>Responsable: {session.responsible_name}</span>}
            </div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 border-t border-theme-border/60 pt-4 sm:grid-cols-4">
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Creada</p>
            <p className="text-sm text-theme-text">{formatDateChile(session.created_at)}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Preparada</p>
            <p className="text-sm text-theme-text">{formatDateChile(session.prepared_at)}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Iniciada</p>
            <p className="text-sm text-theme-text">{formatDateChile(session.started_at)}</p>
          </div>
          <div>
            <p className="text-[11px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Cerrada</p>
            <p className="text-sm text-theme-text">{formatDateChile(session.reviewed_at)}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
