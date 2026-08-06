import Link from 'next/link'
import type { ReactNode } from 'react'
import { ArrowLeft, ExternalLink } from 'lucide-react'
import type { InventorySessionDetail } from '@/app/actions/inventarios/sessions'
import { InventoryStatusBadge } from '@/modules/inventarios/components/inventory-status-badge'
import { inventoryTypeLabel } from '@/modules/inventarios/lib/states'
import { formatDateChile } from '@/modules/inventarios/lib/format'

interface InventorySessionHeaderProps {
  detail: InventorySessionDetail
  campaign?: { id: string; name: string | null; siteName: string | null }
  action?: ReactNode
}

export function InventorySessionHeader({ detail, campaign, action }: InventorySessionHeaderProps) {
  const session = detail.session

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Link
          href="/dashboard/inventarios/jornadas"
          className="inline-flex items-center gap-1.5 text-xs font-medium text-theme-text-muted transition-colors hover:text-theme-text"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
          Volver a secciones de conteo
        </Link>
        {campaign && (
          <Link
            href={`/dashboard/inventarios/campanas/${campaign.id}`}
            className="inline-flex max-w-full items-center gap-1.5 truncate text-xs font-medium text-theme-accent hover:underline"
            title="Ir al inventario"
          >
            <ExternalLink className="h-3 w-3 shrink-0" />
            <span className="truncate">
              Inventario: {campaign.name ?? '—'}
              {campaign.siteName ? ` · Bodega: ${campaign.siteName}` : ''}
            </span>
          </Link>
        )}
      </div>

      <div className="rounded-xl border border-theme-border bg-theme-surface p-4 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="text-sm font-bold text-theme-text">#{session.session_number}</span>
              <h1 className="truncate text-base font-bold text-theme-text">{session.name}</h1>
              <InventoryStatusBadge status={session.status} />
            </div>
            <p className="flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-theme-text-muted">
              <span>{inventoryTypeLabel(session.inventory_type)}</span>
              <span aria-hidden className="text-theme-text-muted/40">·</span>
              <span>{session.scope_mode === 'PARTIAL' ? 'Alcance parcial' : 'Alcance general'}</span>
              <span aria-hidden className="text-theme-text-muted/40">·</span>
              <span>{session.warehouse_name ?? 'Bodega sin nombre'}</span>
              {session.responsible_name && (
                <>
                  <span aria-hidden className="text-theme-text-muted/40">·</span>
                  <span>Responsable: {session.responsible_name}</span>
                </>
              )}
            </p>
          </div>
          {action}
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2 border-t border-theme-border/60 pt-3 sm:grid-cols-4">
          <div>
            <p className="text-[10px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Creada</p>
            <p className="text-xs text-theme-text">{formatDateChile(session.created_at)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Preparada</p>
            <p className="text-xs text-theme-text">{formatDateChile(session.prepared_at)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Iniciada</p>
            <p className="text-xs text-theme-text">{formatDateChile(session.started_at)}</p>
          </div>
          <div>
            <p className="text-[10px] font-medium text-theme-text-muted/60 uppercase tracking-wider">Cerrada</p>
            <p className="text-xs text-theme-text">{formatDateChile(session.reviewed_at)}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
