"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"

export function ComercialSubmenu() {
  const pathname = usePathname()

  const tabs = [
    { name: 'Inicio', href: '/dashboard/comercial' },
    { name: 'Maestros', href: '/dashboard/comercial/clientes' },
    { name: 'Transacciones', href: '/dashboard/comercial/transacciones' },
    { name: 'Consultas', href: '/dashboard/comercial/consultas' },
    { name: 'Reportes', href: '/dashboard/comercial/reportes' },
  ]

  return (
    <div className="bg-theme-surface border-b border-theme-border/60">
      <div className="flex h-11 px-6 gap-6">
        {tabs.map((tab) => {
          const isActive = pathname.includes(tab.href) && (tab.href !== '/dashboard/comercial' || pathname === '/dashboard/comercial')
          return (
            <Link
              key={tab.name}
              href={tab.href}
              className={`flex items-center text-[13px] font-medium border-b-2 transition-colors ${
                isActive 
                  ? 'border-theme-accent text-theme-text-accent' 
                  : 'border-transparent text-theme-text-muted hover:text-theme-text hover:border-theme-border'
              }`}
            >
              {tab.name}
            </Link>
          )
        })}
      </div>
    </div>
  )
}