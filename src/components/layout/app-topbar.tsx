'use client'

import Link from 'next/link'
import { CompanyLogo } from '@/components/company-logo'
import { CompanySwitcher } from '@/components/company-switcher'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { UserMenu } from '@/components/layout/user-menu'
import type { Profile } from '@/lib/types'
import type { Company } from '@/app/actions/companies'

interface AppTopbarProps {
  profile: Profile & { roles: { name: string } }
  activeCompany: Company
  permissions: string[]
  moduleName?: string
}

export function AppTopbar({ profile, activeCompany, permissions, moduleName }: AppTopbarProps) {
  return (
    <header className="fixed top-0 left-0 right-0 z-30 h-12 bg-theme-bg/60 backdrop-blur-md border-b border-theme-border/60">
      <div className="h-full max-w-7xl mx-auto px-4 lg:px-6 flex items-center justify-between gap-4">
        {/* Identidad / Módulo */}
        <div className="flex items-center gap-4 overflow-hidden">
          <Link href="/dashboard" className="flex items-center gap-2 shrink-0 group">
            <CompanyLogo logoUrl={activeCompany.logo_url} size={28} className="transition-transform duration-200 group-hover:scale-105" />
            <div className="leading-tight shrink-0">
              <p className="font-bold text-xs text-theme-text max-w-[140px] truncate">
                {activeCompany.trade_name || activeCompany.business_name}
              </p>
              <p className="text-[8.5px] font-semibold text-theme-accent uppercase tracking-wider truncate max-w-[140px]">
                PetGrup
              </p>
            </div>
          </Link>

          {moduleName && (
            <>
              <div className="w-px h-4 bg-theme-border shrink-0" />
              <div className="flex items-center gap-1.5 shrink-0">
                <span className="text-[10px] font-bold text-theme-text px-1.5 py-0.5 rounded bg-theme-accent/10 border border-theme-accent/15 text-theme-accent">
                  {moduleName}
                </span>
              </div>
            </>
          )}
        </div>

        {/* Controles de la derecha */}
        <div className="flex items-center gap-2 shrink-0">
          <CompanySwitcher />
          <div className="w-px h-4 bg-theme-border/60 shrink-0" />
          <ThemeSwitcher />
          <UserMenu profile={profile} activeCompany={activeCompany} permissions={permissions} />
        </div>
      </div>
    </header>
  )
}
