'use client'

import { useState } from 'react'
import { AnalisisTopbar } from '@/modules/analisis-comercial/components/analisis-topbar'
import { AnalisisSidebar } from '@/modules/analisis-comercial/components/analisis-sidebar'

interface AnalisisComercialLayoutClientProps {
  children: React.ReactNode
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

export function AnalisisComercialLayoutClient({ children, profile }: AnalisisComercialLayoutClientProps) {
  const [sidebarExpanded, setSidebarExpanded] = useState(true)

  return (
    <div className="flex flex-col min-h-screen">
      <AnalisisTopbar
        profile={profile}
        onToggleSidebar={() => setSidebarExpanded(prev => !prev)}
        isSidebarExpanded={sidebarExpanded}
      />
      <div className="flex flex-1 pt-9">
        <AnalisisSidebar expanded={sidebarExpanded} />
        <main className="flex-1 min-h-0 overflow-auto bg-theme-bg">
          {children}
        </main>
      </div>
    </div>
  )
}
