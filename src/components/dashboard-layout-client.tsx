'use client'

import { useState, useRef, useEffect } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { cn } from '@/lib/utils'
import { logout } from '@/app/actions/auth'
import { CompanyLogo } from '@/components/company-logo'
import * as LucideIcons from 'lucide-react'
import type { Profile } from '@/lib/types'
import { AppTopbar } from '@/components/layout/app-topbar'
import { CompanySwitcher } from '@/components/company-switcher'
import type { Company } from '@/app/actions/companies'

interface DashboardLayoutClientProps {
  children: React.ReactNode
  profile: Profile & { roles: { name: string } }
  permissions: string[]
  activeCompany: Company | null
}



export function DashboardLayoutClient({ children, profile, permissions, activeCompany }: DashboardLayoutClientProps) {
  const pathname = usePathname()
  // Module pages render their own layout (AppTopbar, ModuleTabs, Ribbon).
  // They must NOT be wrapped by the portal layout (which has max-w-6xl mx-auto).
  const MODULE_PREFIXES = [
    '/dashboard/adquisiciones',
    '/dashboard/logistica',
    '/dashboard/comercial',
  ]
  const isModulePage = MODULE_PREFIXES.some(prefix => pathname.startsWith(prefix))


  // Si no hay empresa activa, bloquear interacción y pedir selección
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

  if (isModulePage) {
    return (
      <div className="min-h-screen relative dark text-foreground">
        <div className="fixed inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end -z-10" />
        <div className="fixed inset-0 opacity-[0.025] -z-10" style={{
          backgroundImage: `radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)`,
          backgroundSize: '60px 60px',
        }} />
        <div className="fixed top-0 right-0 w-[700px] h-[700px] bg-theme-accent-hover/8 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4 -z-10" />
        <div className="fixed bottom-0 left-0 w-[600px] h-[600px] bg-theme-accent-hover/8 rounded-full blur-3xl translate-y-1/3 -translate-x-1/4 -z-10" />
        <main className="min-h-screen">{children}</main>
      </div>
    )
  }

  return (
    <div className="min-h-screen relative dark text-foreground">
      <div className="fixed inset-0 bg-gradient-to-br from-theme-bg-gradient-start via-theme-bg-gradient-mid to-theme-bg-gradient-end -z-10" />
      <div className="fixed inset-0 opacity-[0.025] -z-10" style={{
        backgroundImage: `radial-gradient(circle at 25% 25%, white 1px, transparent 1px), radial-gradient(circle at 75% 75%, white 1px, transparent 1px)`,
        backgroundSize: '60px 60px',
      }} />
      <div className="fixed top-0 right-0 w-[700px] h-[700px] bg-theme-accent-hover/8 rounded-full blur-3xl -translate-y-1/2 translate-x-1/4 -z-10" />
      <div className="fixed bottom-0 left-0 w-[600px] h-[600px] bg-theme-accent-hover/8 rounded-full blur-3xl translate-y-1/3 -translate-x-1/4 -z-10" />

      <AppTopbar
        profile={profile}
        activeCompany={activeCompany}
        permissions={permissions}
        moduleName="Portal de Gestión"
      />

      <main className="pt-12">
        <div className="max-w-6xl mx-auto p-5 lg:p-8">
          {children}
        </div>
      </main>
    </div>
  )
}
