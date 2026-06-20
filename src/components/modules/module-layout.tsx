'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { cn } from '@/lib/utils'
import { logout } from '@/app/actions/auth'
import { CompanyLogo } from '@/components/company-logo'
import * as LucideIcons from 'lucide-react'
import { getActiveCompany, type Company } from '@/app/actions/companies'
import { CompanySwitcher } from '@/components/company-switcher'
import { ThemeSwitcher } from '@/components/theme-switcher'

interface Tab {
  id: string
  label: string
}

interface ModuleLayoutProps {
  moduleName: string
  tabs: Tab[]
  activeTab: string
  onTabChange: (tabId: string) => void
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

function UserMenu({ profile, activeCompany }: { profile: { nombre: string; apellido: string; email: string; roles: { name: string } }; activeCompany: Company | null }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div ref={ref} className="relative shrink-0">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-2.5 p-1.5 pr-3 rounded-xl hover:bg-white/10 transition-colors">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-theme-accent-hover to-theme-accent flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-md">
          {activeCompany ? (activeCompany.trade_name || activeCompany.business_name)[0] : profile.nombre?.[0] ?? ''}
        </div>
        <div className="hidden md:block text-left leading-tight">
          <p className="text-xs font-bold text-theme-text uppercase tracking-wide max-w-[150px] truncate">
            {activeCompany ? (activeCompany.trade_name || activeCompany.business_name) : 'Sin Empresa'}
          </p>
          <p className="text-[10px] text-theme-text-muted/80">
            {profile.nombre} {profile.apellido} · <span className="capitalize">{profile.roles?.name?.toLowerCase()?.replace('_', ' ') ?? ''}</span>
          </p>
        </div>
        <LucideIcons.ChevronDown className={cn('h-4 w-4 text-theme-accent transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-64 bg-theme-surface/95 backdrop-blur-md rounded-2xl border border-white/10 shadow-2xl shadow-black/40 z-50 py-2 overflow-hidden">
            <div className="px-4 py-3 border-b border-theme-border">
              <p className="text-sm font-semibold text-theme-text">{profile.nombre} {profile.apellido}</p>
              <p className="text-xs text-theme-accent/70">{profile.email}</p>
            </div>
            
            {profile.roles?.name === 'SUPER_USUARIO' && (
              <div className="p-1 border-b border-theme-border/60">
                <Link
                  href="/dashboard/configurar-empresa"
                  onClick={() => setOpen(false)}
                  className="w-full flex items-center gap-2.5 px-3 py-2 text-xs rounded-xl hover:bg-white/5 hover:text-theme-text text-theme-text-muted transition-colors text-left font-medium"
                >
                  <LucideIcons.Settings className="h-3.5 w-3.5 text-theme-accent" />
                  Configurar datos empresa
                </Link>
              </div>
            )}

            <form action={logout}>
              <button type="submit" className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors">
                <LucideIcons.LogOut className="h-4 w-4" /> Cerrar sesión
              </button>
            </form>
          </div>
        </>
      )}
    </div>
  )
}

export function ModuleLayout({ moduleName, tabs, activeTab, onTabChange, children, profile }: ModuleLayoutProps) {
  const [activeCompany, setActiveCompany] = useState<Company | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    getActiveCompany().then(company => {
      setActiveCompany(company)
      setLoading(false)
    })
  }, [])

  if (loading) {
    return (
      <div className="min-h-screen relative dark text-foreground flex items-center justify-center">
        <div className="fixed inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end -z-10" />
        <div className="text-center space-y-4">
          <LucideIcons.Loader2 className="h-8 w-8 animate-spin text-theme-accent mx-auto" />
          <p className="text-sm text-theme-text-muted">Iniciando módulo...</p>
        </div>
      </div>
    )
  }

  if (!activeCompany) {
    return (
      <div className="min-h-screen relative dark text-foreground flex items-center justify-center p-4">
        <div className="fixed inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end -z-10" />
        <div className="w-full max-w-md bg-theme-surface/90 border border-white/10 backdrop-blur-md rounded-2xl p-6 shadow-2xl text-center space-y-6">
          <div className="w-16 h-16 mx-auto rounded-2xl bg-theme-accent/20 flex items-center justify-center text-theme-accent shadow-lg shadow-theme-accent/10">
            <LucideIcons.Building className="h-8 w-8" />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-theme-text">Selección de Empresa Requerida</h1>
            <p className="text-sm text-theme-text-muted">No tienes una empresa activa seleccionada en el sistema. Selecciona una para continuar.</p>
          </div>
          <div className="flex justify-center pt-2">
            <CompanySwitcher />
          </div>
          <div className="border-t border-theme-border pt-4">
            <form action={logout}>
              <button type="submit" className="text-xs text-red-400 hover:text-red-300 transition-colors flex items-center gap-1.5 mx-auto">
                <LucideIcons.LogOut className="h-3.5 w-3.5" />
                Cerrar sesión
              </button>
            </form>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="flex flex-col min-h-screen">
      <header className="fixed top-0 left-0 right-0 z-30 h-[68px] bg-theme-bg/60 backdrop-blur-md border-b border-theme-border">
        <div className="h-full max-w-7xl mx-auto px-4 lg:px-6 flex items-center justify-between gap-4">
          <div className="flex items-center gap-6 overflow-hidden">
            <div className="flex items-center gap-3 shrink-0 group">
              <CompanyLogo logoUrl={activeCompany.logo_url} size={38} className="transition-transform duration-200 group-hover:scale-105" />
              <div className="hidden sm:block truncate leading-tight">
                <p className="font-bold text-sm text-theme-text max-w-[120px] truncate">{moduleName}</p>
                <p className="text-[10px] font-semibold text-theme-accent uppercase tracking-[0.15em] max-w-[120px] truncate">
                  {activeCompany.trade_name || activeCompany.business_name}
                </p>
              </div>
            </div>

            {tabs.length > 0 && <div className="hidden md:block w-px h-8 bg-theme-border shrink-0" />}

            <nav className="flex items-center gap-1 overflow-x-auto hide-scrollbar scroll-smooth">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => onTabChange(tab.id)}
                  className={cn(
                    'flex items-center gap-2 px-3.5 py-2 rounded-lg text-sm font-medium transition-all whitespace-nowrap',
                    activeTab === tab.id
                      ? 'bg-theme-text/10 text-theme-text shadow-sm'
                      : 'text-theme-text-muted/80 hover:bg-theme-text/5 hover:text-theme-text'
                  )}
                >
                  {tab.label}
                </button>
              ))}
            </nav>
          </div>

          <div className="flex items-center gap-3 shrink-0">
            <Link 
              href="/dashboard" 
              className="hidden lg:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium text-theme-text-muted/80 hover:text-theme-text hover:bg-theme-text/5 transition-colors"
            >
              <LucideIcons.ArrowLeft className="h-4 w-4" />
              Regresar al Portal
            </Link>
            <Link 
              href="/dashboard" 
              className="lg:hidden flex items-center justify-center w-9 h-9 rounded-lg text-theme-text-muted/80 hover:text-theme-text hover:bg-theme-text/5 transition-colors shrink-0" 
              title="Regresar al Portal"
            >
              <LucideIcons.ArrowLeft className="h-4 w-4" />
            </Link>
            <div className="hidden sm:block w-px h-6 bg-theme-border mx-1 shrink-0" />
            <CompanySwitcher />
            <div className="hidden sm:block w-px h-6 bg-theme-border mx-1 shrink-0" />
            <ThemeSwitcher />
            <UserMenu profile={profile} activeCompany={activeCompany} />
          </div>
        </div>
      </header>

      <main className="pt-[68px] flex-1 w-full">
        <div className="max-w-7xl mx-auto p-5 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  )
}
