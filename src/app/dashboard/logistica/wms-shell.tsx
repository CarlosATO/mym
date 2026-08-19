'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import * as LucideIcons from 'lucide-react'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import { AppTopbar } from '@/components/layout/app-topbar'
import { cn } from '@/lib/utils'

interface WmsShellProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
  pageTitle: string
  breadcrumb: string[]
  compactSurface?: boolean
}

type NavItem = {
  id: string
  label: string
  icon: keyof typeof LucideIcons
  tab: string
  action?: string
}

const navItems: NavItem[] = [
  { id: 'inicio', label: 'Inicio', icon: 'House', tab: 'inicio', action: 'resumen' },
  { id: 'bodegas', label: 'Bodegas', icon: 'Warehouse', tab: 'catalogos', action: 'bodegas' },
  { id: 'ubicaciones', label: 'Ubicaciones', icon: 'MapPin', tab: 'catalogos', action: 'ubicaciones' },
  { id: 'productos', label: 'Productos', icon: 'Package', tab: 'catalogos', action: 'productos' },
  { id: 'calendario_despacho', label: 'Calendario de Despacho', icon: 'CalendarDays', tab: 'catalogos', action: 'calendario_despacho' },
  { id: 'preparacion_pedidos', label: 'Preparación de Pedidos', icon: 'ClipboardList', tab: 'preparacion_pedidos', action: 'preparacion_pedidos' },
  { id: 'recepciones', label: 'Recepciones', icon: 'PackageOpen', tab: 'movimientos', action: 'recepciones' },
  { id: 'traspasos', label: 'Traspasos', icon: 'ArrowLeftRight', tab: 'movimientos', action: 'traspasos' },
  { id: 'ajustes', label: 'Ajustes', icon: 'SlidersHorizontal', tab: 'movimientos', action: 'ajustes' },
  { id: 'guias_ruta', label: 'Guías de Ruta', icon: 'Map', tab: 'movimientos', action: 'guias_ruta' },
  { id: 'stock', label: 'Stock', icon: 'Layers3', tab: 'consultas', action: 'stock' },
  { id: 'kardex', label: 'Kardex', icon: 'History', tab: 'consultas', action: 'kardex' },
  { id: 'trazabilidad', label: 'Trazabilidad', icon: 'GitMerge', tab: 'consultas', action: 'trazabilidad' },
  { id: 'reportes_log', label: 'Reportes de Almacén', icon: 'ChartNoAxesCombined', tab: 'reportes', action: 'reportes_log' },
]

const groups = [
  { label: 'Parámetros', ids: ['bodegas', 'ubicaciones', 'productos', 'calendario_despacho'] },
  { label: 'Preparación de Pedidos', ids: ['preparacion_pedidos'] },
  { label: 'Movimientos', ids: ['recepciones', 'traspasos', 'ajustes', 'guias_ruta'] },
  { label: 'Consultas', ids: ['stock', 'kardex', 'trazabilidad'] },
  { label: 'Reportes', ids: ['reportes_log'] },
]

const WIDE_VIEWPORT_QUERY = '(min-width: 1180px)'

export function WmsShell({ children, profile, pageTitle, breadcrumb, compactSurface = false }: WmsShellProps) {
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [activeCompany, setActiveCompany] = useState<Company | null>(null)
  const [collapsed, setCollapsed] = useState(() => typeof window !== 'undefined' && window.localStorage.getItem('mym:wms-sidebar-collapsed') === 'true')
  const [mobileOpen, setMobileOpen] = useState(false)
  const [isWideViewport, setIsWideViewport] = useState(() => typeof window !== 'undefined' && window.matchMedia(WIDE_VIEWPORT_QUERY).matches)

  useEffect(() => {
    getActiveCompany().then(setActiveCompany)
  }, [])

  useEffect(() => {
    const mediaQuery = window.matchMedia(WIDE_VIEWPORT_QUERY)
    const handleViewportChange = () => setIsWideViewport(mediaQuery.matches)
    mediaQuery.addEventListener('change', handleViewportChange)
    return () => mediaQuery.removeEventListener('change', handleViewportChange)
  }, [])

  const isReceipt = pathname.startsWith('/dashboard/logistica/recepciones/')
  const isRouteGuides = pathname === '/dashboard/logistica/guias-ruta'
  const activeAction = searchParams.get('action') ?? (isReceipt ? 'recepciones' : isRouteGuides ? 'guias_ruta' : 'resumen')
  const activeItem = navItems.find(item => item.id === activeAction) ?? navItems[0]
  const responsiveCollapsed = !isWideViewport
  const effectiveCollapsed = collapsed || responsiveCollapsed

  function toggleCollapsed() {
    setCollapsed(value => {
      const next = !value
      window.localStorage.setItem('mym:wms-sidebar-collapsed', String(next))
      return next
    })
  }

  function navigate(item: NavItem) {
    router.push(`/dashboard/logistica?tab=${item.tab}&action=${item.action}`)
    setMobileOpen(false)
  }

  const permissions = profile.roles?.name === 'SUPER_USUARIO' ? ['usuarios.view', 'roles.view', 'audit.view', 'security.view'] : []
  const sidebarWidth = effectiveCollapsed ? 'md:w-[68px]' : 'md:w-[244px]'

  if (!activeCompany) {
    return <div className="min-h-screen bg-theme-bg" />
  }

  return (
    <div className="min-h-screen bg-theme-bg text-foreground">
      <AppTopbar profile={profile as never} activeCompany={activeCompany} permissions={permissions} showPortalLink variant="wms" sidebarMode={effectiveCollapsed ? 'compact' : 'expanded'} />

      {mobileOpen && <button aria-label="Cerrar navegación" className="fixed inset-0 z-30 bg-slate-950/50 md:hidden" onClick={() => setMobileOpen(false)} />}

      <aside className={cn(
        'fixed left-3 top-3 bottom-3 z-40 flex flex-col overflow-hidden rounded-[20px] border border-white/10 bg-[#102b4a] text-white shadow-[0_14px_35px_rgba(15,39,68,0.14)] transition-[width,transform] duration-200',
        sidebarWidth,
        mobileOpen ? 'translate-x-0 w-[244px]' : '-translate-x-[calc(100%+0.75rem)] md:translate-x-0'
      )}>
        <div className={cn('flex h-[76px] shrink-0 items-center border-b border-white/10 bg-white/[0.025] px-4', effectiveCollapsed && !mobileOpen && 'md:justify-center md:px-2')}>
          <div className="min-w-0">
            <p className="text-[11px] font-bold uppercase tracking-[0.22em] text-sky-300">WMS</p>
            {(!effectiveCollapsed || mobileOpen) && <p className="mt-1 truncate text-sm font-medium text-white/75">Gestión de Bodega</p>}
          </div>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <NavButton item={navItems[0]} active={activeItem.id === 'inicio'} collapsed={effectiveCollapsed && !mobileOpen} onClick={navigate} />
          {groups.map(group => {
            const groupActive = group.ids.includes(activeItem.id)
            return (
              <div key={group.label} className="mt-5">
                {(!effectiveCollapsed || mobileOpen) && <p className={cn('mb-1 px-3 text-[10px] font-bold uppercase tracking-[0.16em]', groupActive ? 'text-sky-300' : 'text-white/40')}>{group.label}</p>}
                {group.ids.map(id => {
                  const item = navItems.find(navItem => navItem.id === id)!
                  return <NavButton key={item.id} item={item} active={activeItem.id === item.id} collapsed={effectiveCollapsed && !mobileOpen} onClick={navigate} />
                })}
              </div>
            )
          })}
        </nav>

        <div className={cn('border-t border-white/10 bg-black/5 p-3', effectiveCollapsed && !mobileOpen && 'md:px-2')}>
          <button title={collapsed ? 'Expandir navegación' : responsiveCollapsed ? 'Navegación compacta en este ancho' : 'Contraer navegación'} onClick={toggleCollapsed} className="hidden w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-white/60 hover:bg-white/10 hover:text-white md:flex">
            {effectiveCollapsed ? <LucideIcons.PanelLeftOpen className="h-4 w-4" /> : <LucideIcons.PanelLeftClose className="h-4 w-4" />}
            {!effectiveCollapsed && 'Contraer menú'}
          </button>
        </div>
      </aside>

      <div className={cn('pt-12 transition-[padding] duration-200', effectiveCollapsed ? 'md:pl-[92px]' : 'md:pl-[268px]')}>
        <div className="flex h-12 items-center gap-3 border-b border-theme-border/70 bg-theme-surface/70 px-5 md:hidden">
          <button aria-label="Abrir navegación" onClick={() => setMobileOpen(true)} className="rounded-md p-1.5 text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text"><LucideIcons.Menu className="h-5 w-5" /></button>
          <span className="text-sm font-semibold text-theme-text">{pageTitle}</span>
        </div>
        <main className="min-w-0 px-4 py-4 md:px-6 md:py-5">
          <div className="mb-3 flex min-w-0 items-center gap-2 px-1 text-[11px] text-theme-text-muted">
            {breadcrumb.map((part, index) => <span key={`${part}-${index}`} className={cn(index === breadcrumb.length - 1 ? 'font-semibold text-theme-text' : 'text-theme-text-muted/70')}>{index > 0 && <span className="mr-2 text-theme-border">/</span>}{part}</span>)}
          </div>
          <section className={cn('overflow-hidden rounded-[18px] border border-theme-border bg-theme-surface shadow-[0_5px_18px_rgba(31,52,77,0.045)]', compactSurface ? 'min-h-0' : 'min-h-[calc(100vh-7.5rem)]')}>
            {children}
          </section>
        </main>
      </div>
    </div>
  )
}

function NavButton({ item, active, collapsed, onClick }: { item: NavItem; active: boolean; collapsed: boolean; onClick: (item: NavItem) => void }) {
  return (
    <button title={collapsed ? item.label : undefined} onClick={() => onClick(item)} className={cn('group flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-[13px] transition-colors', collapsed && 'md:justify-center md:px-2', active ? 'bg-sky-400/15 font-semibold text-white ring-1 ring-inset ring-sky-300/25' : 'text-white/65 hover:bg-white/10 hover:text-white')}>
      <NavIcon name={item.icon} className={cn('h-[17px] w-[17px] shrink-0', active ? 'text-sky-300' : 'text-white/45 group-hover:text-white/75')} />
      {!collapsed && <span className="truncate">{item.label}</span>}
      {active && !collapsed && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-sky-300" />}
    </button>
  )
}

function NavIcon({ name, className }: { name: NavItem['icon']; className?: string }) {
  switch (name) {
    case 'House': return <LucideIcons.House className={className} />
    case 'Warehouse': return <LucideIcons.Warehouse className={className} />
    case 'MapPin': return <LucideIcons.MapPin className={className} />
    case 'Package': return <LucideIcons.Package className={className} />
    case 'CalendarDays': return <LucideIcons.CalendarDays className={className} />
    case 'ClipboardList': return <LucideIcons.ClipboardList className={className} />
    case 'PackageOpen': return <LucideIcons.PackageOpen className={className} />
    case 'ArrowLeftRight': return <LucideIcons.ArrowLeftRight className={className} />
    case 'SlidersHorizontal': return <LucideIcons.SlidersHorizontal className={className} />
    case 'Map': return <LucideIcons.Map className={className} />
    case 'Layers3': return <LucideIcons.Layers3 className={className} />
    case 'History': return <LucideIcons.History className={className} />
    case 'GitMerge': return <LucideIcons.GitMerge className={className} />
    case 'ChartNoAxesCombined': return <LucideIcons.ChartNoAxesCombined className={className} />
    default: return <LucideIcons.Box className={className} />
  }
}
