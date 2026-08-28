'use client'

import Link from 'next/link'
import { CompanyLogo } from '@/components/company-logo'
import { CompanySwitcher } from '@/components/company-switcher'
import { ThemeSwitcher } from '@/components/theme-switcher'
import { UserMenu } from '@/components/layout/user-menu'
import { TopbarDate } from '@/components/layout/topbar-date'
import type { Profile } from '@/lib/types'
import type { Company } from '@/app/actions/companies'
import { cn } from '@/lib/utils'

interface AppTopbarProps {
  profile: Profile & { roles: { name: string } }
  activeCompany: Company
  permissions: string[]
  moduleName?: string
  showPortalLink?: boolean
  variant?: 'default' | 'module'
  sidebarMode?: 'expanded' | 'compact'
}

export function AppTopbar({ profile, activeCompany, permissions, moduleName, showPortalLink = false, variant = 'default', sidebarMode }: AppTopbarProps) {
  return (
    <header className={cn('fixed top-0 left-0 right-0 z-30 h-12 border-b border-theme-border/60 backdrop-blur-md', variant === 'module' ? 'bg-theme-surface/90 shadow-sm' : 'bg-theme-bg/60')}>
      <div className={cn(
        'h-full max-w-7xl mx-auto px-4 lg:px-6 flex items-center justify-between gap-4',
        sidebarMode === 'compact' && 'md:!pl-[92px]',
        sidebarMode === 'expanded' && 'md:!pl-[268px]'
      )}>
        {/* Identidad / Módulo */}
        <div className="flex items-center gap-4 overflow-hidden">
          <Link href="/dashboard" className="flex items-center gap-2 shrink-0 group">
            <CompanyLogo logoUrl={activeCompany.logo_url} size={28} className="transition-transform duration-200 group-hover:scale-105" />
            <div className="leading-tight shrink-0">
              <p className="font-bold text-xs text-theme-text max-w-[140px] truncate">
                {activeCompany.trade_name || activeCompany.business_name}
              </p>
              <p className="text-[8.5px] font-semibold text-theme-accent uppercase tracking-wider truncate max-w-[140px]">
                PetGroup
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
          {showPortalLink && (
            <Link href="/dashboard" className="hidden items-center gap-1 rounded-md px-2 py-1.5 text-xs font-semibold text-theme-text-muted hover:bg-theme-text/10 hover:text-theme-text sm:flex">
              <span>Portal</span>
            </Link>
          )}
          <TopbarDate />
          <CompanySwitcher />
          <div className="w-px h-4 bg-theme-border/60 shrink-0" />
          <ThemeSwitcher />
          <UserMenu profile={profile} activeCompany={activeCompany} permissions={permissions} />
        </div>
      </div>
    </header>
  )
}
