'use client'

import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import {
  ArrowDown,
  ArrowRight,
  ArrowUp,
  BarChart3,
  Boxes,
  BriefcaseBusiness,
  Check,
  CircleDollarSign,
  EyeOff,
  FileText,
  LayoutGrid,
  MapPinned,
  PackageCheck,
  RotateCcw,
  Route,
  ShoppingCart,
  TrendingUp,
  Users,
  WalletCards,
  Warehouse,
  X,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import type { Modulo } from '@/lib/types'
import type { PortalRouteGuide } from '@/app/actions/logistica/guias-ruta'
import type { PortalSales } from '@/app/actions/portal/sales'
import type { PortalCollectionsByMode } from '@/app/actions/portal/collections'
import type { PortalAmimascotaKpis } from '@/app/actions/portal/amimascota'
import type { PortalTopProduct } from '@/app/actions/portal/top-products'
import type { PortalPeriodMode } from '@/app/actions/portal/periods'
import { LatestRouteGuides } from '@/components/portal/latest-route-guides'
import { TopProductsCard } from '@/components/portal/top-products-card'
import { AmimascotaCard } from '@/components/portal/amimascota-card'
import { PortalFinancialSection } from '@/components/portal/portal-financial-section'

export interface PortalShortcutItem {
  id: string
  title: string
  description: string
  href: string
  category: 'modulo' | 'atajo'
  moduleCode: string
  iconName: string
  accent: 'amber' | 'sky' | 'indigo' | 'teal' | 'violet' | 'emerald'
  disabled?: boolean
}

interface PortalHomeClientProps {
  userId: string
  fullName: string
  email: string
  roleName: string
  operationalModules: Modulo[]
  isSystemAdmin: boolean
  executiveData: {
    latestRouteGuides: PortalRouteGuide[]
    sales: Record<PortalPeriodMode, PortalSales | null>
    collections: PortalCollectionsByMode
    salesError: boolean
    collectionsError: boolean
    amimascota: PortalAmimascotaKpis | null
    amimascotaError: boolean
    topProducts: PortalTopProduct[]
    topProductsError: boolean
  } | null
}

const ACCENT_STYLES: Record<
  PortalShortcutItem['accent'],
  { iconBox: string; badge: string; borderHover: string }
> = {
  amber: {
    iconBox: 'bg-amber-500/12 text-amber-600 dark:bg-amber-400/15 dark:text-amber-300',
    badge: 'bg-amber-500/10 text-amber-700 dark:text-amber-300',
    borderHover: 'hover:border-amber-500/35',
  },
  sky: {
    iconBox: 'bg-sky-500/12 text-sky-600 dark:bg-sky-400/15 dark:text-sky-300',
    badge: 'bg-sky-500/10 text-sky-700 dark:text-sky-300',
    borderHover: 'hover:border-sky-500/35',
  },
  indigo: {
    iconBox: 'bg-indigo-500/12 text-indigo-600 dark:bg-indigo-400/15 dark:text-indigo-300',
    badge: 'bg-indigo-500/10 text-indigo-700 dark:text-indigo-300',
    borderHover: 'hover:border-indigo-500/35',
  },
  teal: {
    iconBox: 'bg-teal-500/12 text-teal-600 dark:bg-teal-400/15 dark:text-teal-300',
    badge: 'bg-teal-500/10 text-teal-700 dark:text-teal-300',
    borderHover: 'hover:border-teal-500/35',
  },
  violet: {
    iconBox: 'bg-violet-500/12 text-violet-600 dark:bg-violet-400/15 dark:text-violet-300',
    badge: 'bg-violet-500/10 text-violet-700 dark:text-violet-300',
    borderHover: 'hover:border-violet-500/35',
  },
  emerald: {
    iconBox: 'bg-emerald-500/12 text-emerald-600 dark:bg-emerald-400/15 dark:text-emerald-300',
    badge: 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
    borderHover: 'hover:border-emerald-500/35',
  },
}

const ICONS: Record<string, LucideIcon> = {
  ShoppingCart,
  Warehouse,
  BriefcaseBusiness,
  Boxes,
  BarChart3,
  Users,
  PackageCheck,
  MapPinned,
  CircleDollarSign,
  FileText,
  Route,
  WalletCards,
}

const MODULE_META: Record<
  string,
  {
    title: string
    description: string
    iconName: string
    accent: PortalShortcutItem['accent']
  }
> = {
  adquisiciones: {
    title: 'Adquisiciones',
    description: 'Órdenes de compra, análisis de reposición, proveedores y rendición de rutas',
    iconName: 'ShoppingCart',
    accent: 'amber',
  },
  logistica: {
    title: 'Logística',
    description: 'Preparación de pedidos, recepciones, guías de ruta y control de bodegas WMS',
    iconName: 'Warehouse',
    accent: 'sky',
  },
  comercial: {
    title: 'Clientes / Ventas',
    description: 'Cartera de clientes, gestión de cobranza y cálculo de comisiones comerciales',
    iconName: 'BriefcaseBusiness',
    accent: 'indigo',
  },
  inventarios: {
    title: 'Inventario',
    description: 'Campañas de conteo, jornadas operativas, revisión y conciliación de existencias',
    iconName: 'Boxes',
    accent: 'teal',
  },
  'analisis-comercial': {
    title: 'Comercial',
    description: 'Control financiero, estado de resultados, flujo de caja y análisis 360',
    iconName: 'BarChart3',
    accent: 'violet',
  },
  rrhh: {
    title: 'RRHH',
    description: 'Gestión de colaboradores, asistencia, permisos y recursos humanos Caylo',
    iconName: 'Users',
    accent: 'emerald',
  },
}

const DIRECT_SHORTCUTS: PortalShortcutItem[] = [
  {
    id: 'shortcut:preparacion-pedidos',
    title: 'Preparación de pedidos',
    description: 'Tablero operativo de armado y verificación de pedidos para despacho',
    href: '/dashboard/logistica?tab=preparacion_pedidos&action=preparacion_pedidos',
    category: 'atajo',
    moduleCode: 'logistica',
    iconName: 'PackageCheck',
    accent: 'sky',
  },
  {
    id: 'shortcut:guias-ruta',
    title: 'Guías de ruta',
    description: 'Planificación, control de despachos en ruta y seguimiento de entregas',
    href: '/dashboard/logistica?tab=movimientos&action=guias_ruta',
    category: 'atajo',
    moduleCode: 'logistica',
    iconName: 'MapPinned',
    accent: 'sky',
  },
  {
    id: 'shortcut:stock-actual',
    title: 'Stock actual',
    description: 'Existencias agrupadas por producto, bodega, ubicación y lote',
    href: '/dashboard/logistica?tab=consultas&action=stock',
    category: 'atajo',
    moduleCode: 'logistica',
    iconName: 'Boxes',
    accent: 'teal',
  },
  {
    id: 'shortcut:recepciones',
    title: 'Recepción de mercadería',
    description: 'Registro y consulta de recepciones de bodega contra órdenes de compra',
    href: '/dashboard/logistica?tab=movimientos&action=recepciones',
    category: 'atajo',
    moduleCode: 'logistica',
    iconName: 'Warehouse',
    accent: 'amber',
  },
  {
    id: 'shortcut:cobranza',
    title: 'Gestión de cobranza',
    description: 'Seguimiento de cartera de clientes, vencimientos y tareas de cobro',
    href: '/dashboard/comercial/cobranza',
    category: 'atajo',
    moduleCode: 'comercial',
    iconName: 'CircleDollarSign',
    accent: 'indigo',
  },
  {
    id: 'shortcut:clientes',
    title: 'Cartera de clientes',
    description: 'Ficha comercial, condiciones de pago y estado de cuenta de clientes',
    href: '/dashboard/comercial/clientes',
    category: 'atajo',
    moduleCode: 'comercial',
    iconName: 'Users',
    accent: 'indigo',
  },
  {
    id: 'shortcut:ordenes-compra',
    title: 'Órdenes de compra',
    description: 'Emisión, seguimiento y recepción de órdenes a proveedores',
    href: '/dashboard/adquisiciones/ordenes-compra',
    category: 'atajo',
    moduleCode: 'adquisiciones',
    iconName: 'FileText',
    accent: 'amber',
  },
  {
    id: 'shortcut:reposicion',
    title: 'Análisis de reposición',
    description: 'Sugerencias de compra basadas en rotación y cobertura de stock',
    href: '/dashboard/adquisiciones/reposicion',
    category: 'atajo',
    moduleCode: 'adquisiciones',
    iconName: 'ShoppingCart',
    accent: 'amber',
  },
  {
    id: 'shortcut:rendicion-rutas',
    title: 'Rendición de rutas',
    description: 'Bandeja de rendiciones, cobros posteriores, depósitos y cierre de fondos',
    href: '/dashboard/adquisiciones/rendicion-rutas',
    category: 'atajo',
    moduleCode: 'adquisiciones',
    iconName: 'Route',
    accent: 'emerald',
  },
  {
    id: 'shortcut:control-financiero',
    title: 'Control financiero',
    description: 'Resumen financiero, flujo de caja, estado de resultados y cartolas',
    href: '/dashboard/analisis-comercial/control-financiero',
    category: 'atajo',
    moduleCode: 'analisis-comercial',
    iconName: 'WalletCards',
    accent: 'violet',
  },
]

export function PortalHomeClient({
  userId,
  fullName,
  email,
  roleName,
  operationalModules,
  isSystemAdmin,
  executiveData,
}: PortalHomeClientProps) {
  const storageKey = `caylo:portal-home-shortcuts:v1:${userId}`

  // Construir catálogo completo disponible para este usuario
  const catalogItems = useMemo<PortalShortcutItem[]>(() => {
    const allowedModuleCodes = new Set(operationalModules.map((m) => m.code))

    const moduleShortcuts: PortalShortcutItem[] = operationalModules
      .map((mod) => {
        const meta = MODULE_META[mod.code]
        const route =
          typeof mod.route === 'string' && mod.route.trim().length > 0
            ? mod.route.trim()
            : ''
        return {
          id: `module:${mod.code}`,
          title: meta?.title ?? mod.name,
          description:
            meta?.description ??
            mod.description ??
            'Acceso directo al módulo operativo del sistema',
          href: route,
          category: 'modulo' as const,
          moduleCode: mod.code,
          iconName: meta?.iconName ?? mod.icon ?? 'Boxes',
          accent: meta?.accent ?? 'sky',
          disabled: route.length === 0,
        }
      })
      .sort((a, b) => a.title.localeCompare(b.title, 'es'))

    const availableDirectShortcuts = DIRECT_SHORTCUTS.filter(
      (item) => isSystemAdmin || allowedModuleCodes.has(item.moduleCode)
    )

    return [...moduleShortcuts, ...availableDirectShortcuts]
  }, [operationalModules, isSystemAdmin])

  const defaultIds = useMemo(
    () =>
      catalogItems
        .filter((item) => item.category === 'modulo' && !item.disabled)
        .map((item) => item.id),
    [catalogItems]
  )

  const [selectedIds, setSelectedIds] = useState<string[] | null>(null)
  const [customizeOpen, setCustomizeOpen] = useState(false)
  const [executiveOpen, setExecutiveOpen] = useState(false)

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(storageKey)
      if (raw !== null) {
        const parsed = JSON.parse(raw)
        if (Array.isArray(parsed)) {
          setSelectedIds(parsed.filter((id): id is string => typeof id === 'string'))
          return
        }
      }
    } catch {
      // Fallback a los módulos por defecto
    }
    setSelectedIds(defaultIds)
  }, [storageKey, defaultIds])

  const activeIds = selectedIds ?? defaultIds

  const visibleCards = useMemo(() => {
    const map = new Map(catalogItems.map((item) => [item.id, item]))
    return activeIds
      .map((id) => map.get(id))
      .filter((item): item is PortalShortcutItem => Boolean(item))
  }, [catalogItems, activeIds])

  function persistSelection(nextIds: string[]) {
    setSelectedIds(nextIds)
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(nextIds))
    } catch {
      // Ignorar errores de almacenamiento
    }
  }

  function toggleShortcut(id: string) {
    if (activeIds.includes(id)) {
      persistSelection(activeIds.filter((item) => item !== id))
    } else {
      persistSelection([...activeIds, id])
    }
  }

  function moveShortcut(index: number, direction: -1 | 1) {
    const targetIndex = index + direction
    if (targetIndex < 0 || targetIndex >= activeIds.length) return
    const next = [...activeIds]
    const [moved] = next.splice(index, 1)
    next.splice(targetIndex, 0, moved)
    persistSelection(next)
  }

  function clearAllShortcuts() {
    persistSelection([])
  }

  function restoreDefaults() {
    persistSelection(defaultIds)
  }

  const formattedRole = roleName
    ? roleName
        .toLowerCase()
        .replace(/_/g, ' ')
        .replace(/\b\w/g, (l) => l.toUpperCase())
    : 'Usuario'

  return (
    <div className="flex min-h-[calc(100vh-5.5rem)] flex-col justify-between py-6 sm:py-10">
      {/* ── SECCIÓN SUPERIOR Y CENTRAL: Saludo + Tarjetas estilo Bsale / Caylo ── */}
      <div className="mx-auto w-full max-w-5xl space-y-10">
        {/* Saludo centrado */}
        <header className="text-center space-y-1.5">
          <h1 className="text-2xl font-bold tracking-tight text-theme-text sm:text-3xl">
            Hola, {fullName}
          </h1>
          <p className="text-xs text-theme-text-muted/80 sm:text-[13px]">
            {email && <span>{email} · </span>}
            <span className="font-semibold text-sky-600 dark:text-sky-400">
              {formattedRole}
            </span>
          </p>
        </header>

        {/* Grilla de tarjetas o estado limpio si el usuario ocultó todas */}
        {visibleCards.length > 0 ? (
          <section aria-label="Accesos directos de inicio">
            <div
              className={cn(
                'grid gap-4',
                visibleCards.length === 1 && 'mx-auto max-w-xs grid-cols-1',
                visibleCards.length === 2 && 'mx-auto max-w-xl grid-cols-1 sm:grid-cols-2',
                visibleCards.length === 3 && 'mx-auto max-w-3xl grid-cols-1 sm:grid-cols-3',
                visibleCards.length >= 4 &&
                  'grid-cols-1 sm:grid-cols-2 lg:grid-cols-4'
              )}
            >
              {visibleCards.map((card) => {
                const Icon = ICONS[card.iconName] ?? Boxes
                const style = ACCENT_STYLES[card.accent]
                const cardBody = (
                  <div
                    className={cn(
                      'group relative flex h-full min-h-[146px] flex-col justify-between rounded-2xl border border-theme-border/80 bg-theme-surface p-5 transition-all duration-200',
                      card.disabled
                        ? 'cursor-default opacity-55'
                        : `cursor-pointer shadow-[0_2px_10px_-4px_rgba(15,23,42,0.06)] hover:-translate-y-0.5 hover:shadow-md ${style.borderHover}`
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div
                        className={cn(
                          'flex h-10 w-10 shrink-0 items-center justify-center rounded-xl transition-transform duration-200 group-hover:scale-105',
                          style.iconBox
                        )}
                      >
                        <Icon className="h-5 w-5" />
                      </div>
                      {card.disabled ? (
                        <span className="rounded-md border border-theme-border px-1.5 py-0.5 text-[9px] font-bold uppercase tracking-wider text-theme-text-muted/60">
                          Pronto
                        </span>
                      ) : (
                        <ArrowRight className="h-4 w-4 text-theme-text-muted/35 transition-all duration-200 group-hover:translate-x-0.5 group-hover:text-sky-600 dark:group-hover:text-sky-400" />
                      )}
                    </div>

                    <div className="mt-4 space-y-1">
                      <h2 className="text-[14px] font-bold tracking-tight text-theme-text group-hover:text-sky-700 dark:group-hover:text-sky-300 transition-colors">
                        {card.title}
                      </h2>
                      <p className="line-clamp-2 text-[11.5px] leading-relaxed text-theme-text-muted/80">
                        {card.description}
                      </p>
                    </div>
                  </div>
                )

                if (card.disabled || !card.href) {
                  return <div key={card.id}>{cardBody}</div>
                }

                return (
                  <Link key={card.id} href={card.href} className="block h-full">
                    {cardBody}
                  </Link>
                )
              })}
            </div>
          </section>
        ) : (
          <div className="mx-auto max-w-md rounded-2xl border border-dashed border-theme-border/70 bg-theme-surface/40 px-6 py-8 text-center">
            <p className="text-xs font-medium text-theme-text-muted">
              Escritorio limpio activado. Puedes navegar directamente desde la barra superior o agregar accesos cuando quieras.
            </p>
          </div>
        )}
      </div>

      {/* ── SECCIÓN INFERIOR: Pie estilo Bsale / Caylo ── */}
      <footer className="mt-16 pt-6 text-center space-y-2">
        <p className="text-[13px] font-bold text-theme-text">
          Sácale el máximo potencial a tu página de inicio
        </p>
        <p className="text-xs text-theme-text-muted/80">
          Ordena tus accesos frecuentes, agrega atajos directos o consulta el resumen ejecutivo del día.
        </p>
        <div className="pt-1 flex flex-wrap items-center justify-center gap-4">
          <button
            type="button"
            onClick={() => setCustomizeOpen(true)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-600 transition-colors hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300"
          >
            <span>Personalizar inicio</span>
            <LayoutGrid className="h-3.5 w-3.5" />
          </button>

          {isSystemAdmin && executiveData && (
            <>
              <span className="text-theme-border">•</span>
              <button
                type="button"
                onClick={() => setExecutiveOpen(true)}
                className="inline-flex items-center gap-1.5 text-xs font-semibold text-sky-600 transition-colors hover:text-sky-700 dark:text-sky-400 dark:hover:text-sky-300"
              >
                <span>Resumen ejecutivo</span>
                <TrendingUp className="h-3.5 w-3.5" />
              </button>
            </>
          )}
        </div>
      </footer>

      {/* ── MODAL: Personalizar Inicio (Ordenar, Agregar o Vaciar tarjetas) ── */}
      {customizeOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="fixed inset-0 bg-slate-950/50 backdrop-blur-xs"
            onClick={() => setCustomizeOpen(false)}
          />
          <div className="relative z-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-theme-border/70 px-6 py-4">
              <div>
                <h2 className="text-base font-bold text-theme-text">
                  Personalizar página de inicio
                </h2>
                <p className="text-xs text-theme-text-muted">
                  Elige qué módulos o atajos directos mostrar, cámbialos de orden o déjalo vacío para usar solo el Topbar.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setCustomizeOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-theme-text-muted hover:bg-theme-text/8 hover:text-theme-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Body scrollable */}
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {/* Acciones rápidas */}
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-theme-border/60 bg-theme-text/[0.02] px-4 py-2.5">
                <span className="text-xs font-medium text-theme-text-muted">
                  {visibleCards.length === 0
                    ? 'Sin tarjetas visibles (modo solo Topbar)'
                    : `${visibleCards.length} ${visibleCards.length === 1 ? 'acceso visible' : 'accesos visibles'} en tu inicio`}
                </span>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={restoreDefaults}
                    className="inline-flex items-center gap-1 rounded-lg border border-theme-border/80 bg-theme-surface px-2.5 py-1 text-[11px] font-medium text-theme-text-muted transition-colors hover:text-theme-text"
                  >
                    <RotateCcw className="h-3 w-3" />
                    Predeterminados
                  </button>
                  <button
                    type="button"
                    onClick={clearAllShortcuts}
                    className="inline-flex items-center gap-1 rounded-lg border border-theme-border/80 bg-theme-surface px-2.5 py-1 text-[11px] font-medium text-theme-text-muted transition-colors hover:border-red-500/30 hover:text-red-500"
                  >
                    <EyeOff className="h-3 w-3" />
                    Ocultar todos
                  </button>
                </div>
              </div>

              {/* 1. Orden actual de las tarjetas seleccionadas */}
              {visibleCards.length > 0 && (
                <div className="space-y-2.5">
                  <h3 className="text-xs font-bold uppercase tracking-wider text-theme-text-muted/75">
                    Orden actual en tu escritorio
                  </h3>
                  <div className="space-y-1.5">
                    {visibleCards.map((item, idx) => {
                      const Icon = ICONS[item.iconName] ?? Boxes
                      const style = ACCENT_STYLES[item.accent]
                      return (
                        <div
                          key={item.id}
                          className="flex items-center justify-between gap-3 rounded-xl border border-theme-border/70 bg-theme-surface px-3.5 py-2.5"
                        >
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="w-4 text-center text-[11px] font-bold text-theme-text-muted/60 tabular-nums">
                              {idx + 1}
                            </span>
                            <div
                              className={cn(
                                'flex h-7 w-7 shrink-0 items-center justify-center rounded-lg',
                                style.iconBox
                              )}
                            >
                              <Icon className="h-3.5 w-3.5" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold text-theme-text">
                                {item.title}
                              </p>
                              <p className="truncate text-[10.5px] text-theme-text-muted">
                                {item.category === 'modulo' ? 'Módulo principal' : 'Acceso directo'}
                              </p>
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <button
                              type="button"
                              onClick={() => moveShortcut(idx, -1)}
                              disabled={idx === 0}
                              title="Subir posición"
                              className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border/60 text-theme-text-muted transition-colors hover:bg-theme-text/6 hover:text-theme-text disabled:opacity-30"
                            >
                              <ArrowUp className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveShortcut(idx, 1)}
                              disabled={idx === visibleCards.length - 1}
                              title="Bajar posición"
                              className="flex h-7 w-7 items-center justify-center rounded-lg border border-theme-border/60 text-theme-text-muted transition-colors hover:bg-theme-text/6 hover:text-theme-text disabled:opacity-30"
                            >
                              <ArrowDown className="h-3.5 w-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => toggleShortcut(item.id)}
                              title="Quitar del inicio"
                              className="ml-1 flex h-7 w-7 items-center justify-center rounded-lg text-theme-text-muted transition-colors hover:bg-red-500/10 hover:text-red-500"
                            >
                              <X className="h-3.5 w-3.5" />
                            </button>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* 2. Selección de Módulos principales */}
              <div className="space-y-2.5">
                <h3 className="text-xs font-bold uppercase tracking-wider text-theme-text-muted/75">
                  Módulos principales
                </h3>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {catalogItems
                    .filter((i) => i.category === 'modulo')
                    .map((item) => {
                      const isSelected = activeIds.includes(item.id)
                      const Icon = ICONS[item.iconName] ?? Boxes
                      const style = ACCENT_STYLES[item.accent]
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleShortcut(item.id)}
                          className={cn(
                            'flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all',
                            isSelected
                              ? 'border-sky-500/50 bg-sky-500/6'
                              : 'border-theme-border/70 bg-theme-surface hover:bg-theme-text/4'
                          )}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div
                              className={cn(
                                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                                style.iconBox
                              )}
                            >
                              <Icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold text-theme-text">
                                {item.title}
                              </p>
                              <p className="truncate text-[10.5px] text-theme-text-muted">
                                {item.description}
                              </p>
                            </div>
                          </div>
                          <div
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                              isSelected
                                ? 'border-sky-600 bg-sky-600 text-white'
                                : 'border-theme-border'
                            )}
                          >
                            {isSelected && <Check className="h-3 w-3" />}
                          </div>
                        </button>
                      )
                    })}
                </div>
              </div>

              {/* 3. Selección de Atajos Directos (Estilo Bsale: Stock actual, Despacho, Recepción, etc.) */}
              <div className="space-y-2.5">
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-theme-text-muted/75">
                    Accesos directos a funciones (Estilo Bsale)
                  </h3>
                  <p className="text-[11px] text-theme-text-muted">
                    Agrega tarjetas directas a las pantallas que más utilizas día a día.
                  </p>
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {catalogItems
                    .filter((i) => i.category === 'atajo')
                    .map((item) => {
                      const isSelected = activeIds.includes(item.id)
                      const Icon = ICONS[item.iconName] ?? Boxes
                      const style = ACCENT_STYLES[item.accent]
                      return (
                        <button
                          key={item.id}
                          type="button"
                          onClick={() => toggleShortcut(item.id)}
                          className={cn(
                            'flex items-center justify-between gap-3 rounded-xl border p-3 text-left transition-all',
                            isSelected
                              ? 'border-sky-500/50 bg-sky-500/6'
                              : 'border-theme-border/70 bg-theme-surface hover:bg-theme-text/4'
                          )}
                        >
                          <div className="flex items-center gap-2.5 min-w-0">
                            <div
                              className={cn(
                                'flex h-8 w-8 shrink-0 items-center justify-center rounded-lg',
                                style.iconBox
                              )}
                            >
                              <Icon className="h-4 w-4" />
                            </div>
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold text-theme-text">
                                {item.title}
                              </p>
                              <p className="truncate text-[10.5px] text-theme-text-muted">
                                {item.description}
                              </p>
                            </div>
                          </div>
                          <div
                            className={cn(
                              'flex h-5 w-5 shrink-0 items-center justify-center rounded-md border',
                              isSelected
                                ? 'border-sky-600 bg-sky-600 text-white'
                                : 'border-theme-border'
                            )}
                          >
                            {isSelected && <Check className="h-3 w-3" />}
                          </div>
                        </button>
                      )
                    })}
                </div>
              </div>
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end border-t border-theme-border/70 px-6 py-3.5">
              <button
                type="button"
                onClick={() => setCustomizeOpen(false)}
                className="rounded-xl bg-sky-600 px-4 py-2 text-xs font-semibold text-white shadow-xs transition-colors hover:bg-sky-700"
              >
                Listo
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── MODAL / DRAWER: Resumen Ejecutivo (KPIs bajo demanda) ── */}
      {executiveOpen && executiveData && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
          <div
            className="fixed inset-0 bg-slate-950/55 backdrop-blur-xs"
            onClick={() => setExecutiveOpen(false)}
          />
          <div className="relative z-10 flex max-h-[90vh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-2xl animate-in fade-in zoom-in-95 duration-150">
            <div className="flex items-center justify-between border-b border-theme-border/70 px-6 py-4">
              <div>
                <p className="text-[10px] font-bold uppercase tracking-widest text-sky-600 dark:text-sky-400">
                  Caylo · PetGroup
                </p>
                <h2 className="text-lg font-bold tracking-tight text-theme-text">
                  Resumen Ejecutivo
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setExecutiveOpen(false)}
                className="flex h-8 w-8 items-center justify-center rounded-full text-theme-text-muted hover:bg-theme-text/8 hover:text-theme-text"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-5">
              {/* Ventas y Cobranzas */}
              <div className="grid gap-4 sm:grid-cols-2">
                <PortalFinancialSection
                  sales={executiveData.sales}
                  collections={executiveData.collections}
                  salesError={executiveData.salesError}
                  collectionsError={executiveData.collectionsError}
                />
              </div>

              {/* Amimascota + Top Productos + Últimas Guías de Ruta */}
              <div className="grid gap-4 lg:grid-cols-2">
                <div className="space-y-4">
                  <AmimascotaCard
                    data={executiveData.amimascota}
                    error={executiveData.amimascotaError}
                  />
                  <TopProductsCard
                    products={executiveData.topProducts}
                    error={executiveData.topProductsError}
                  />
                </div>
                <div>
                  <LatestRouteGuides guides={executiveData.latestRouteGuides} />
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
