import Link from 'next/link'
import { ChevronLeft, ChevronRight } from 'lucide-react'

interface InventoryPaginationProps {
  page: number
  pageSize: number
  total: number
  buildHref: (page: number) => string
  label?: string
}

export function InventoryPagination({ page, pageSize, total, buildHref, label = 'jornadas' }: InventoryPaginationProps) {
  const totalPages = Math.max(1, Math.ceil(total / pageSize))

  return (
    <div className="flex items-center justify-between gap-3 border-t border-theme-border/60 px-1 pt-3">
      <p className="text-xs text-theme-text-muted/70">
        Mostrando {total === 0 ? 0 : (page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} de {total} {label}
      </p>
      <div className="flex items-center gap-1.5">
        {page > 1 ? (
          <Link
            href={buildHref(page - 1)}
            aria-label="Página anterior"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <span className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-lg border border-theme-border/50 text-theme-text-muted/30">
            <ChevronLeft className="h-3.5 w-3.5" />
          </span>
        )}

        <span className="px-1 text-xs font-medium text-theme-text-muted">
          {page} / {totalPages}
        </span>

        {page < totalPages ? (
          <Link
            href={buildHref(page + 1)}
            aria-label="Página siguiente"
            className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border bg-theme-surface text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <span className="flex h-7 w-7 cursor-not-allowed items-center justify-center rounded-lg border border-theme-border/50 text-theme-text-muted/30">
            <ChevronRight className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </div>
  )
}
