'use client'

import { usePathname } from 'next/navigation'
import { Building2 } from 'lucide-react'
import type { Company } from '@/app/actions/companies'
import { getFinancialCompanyDisplayName } from '../lib/company-display'

const basePath = '/dashboard/analisis-comercial/control-financiero'

const viewHeaders = [
  {
    path: basePath,
    title: 'Resumen financiero',
    description: 'Lectura ejecutiva de rentabilidad, caja y capital de trabajo.',
  },
  {
    path: `${basePath}/estado-resultados`,
    title: 'Estado de Resultados',
    description: 'Lectura de rentabilidad por período.',
  },
  {
    path: `${basePath}/flujo-caja`,
    title: 'Flujo de Caja',
    description: 'Entradas, salidas y disponibilidad real.',
  },
  {
    path: `${basePath}/capital-trabajo`,
    title: 'Capital de Trabajo',
    description: 'Seguimiento de recursos y obligaciones operativas.',
  },
]

export function ControlFinancieroShell({ children, activeCompany }: { children: React.ReactNode; activeCompany: Company | null }) {
  const pathname = usePathname()
  const view = viewHeaders.find(item => pathname === item.path || (item.path !== basePath && pathname.startsWith(item.path))) ?? viewHeaders[0]

  return (
    <div className="-mx-4 min-h-[calc(100vh-5rem)] bg-[#EFE9E1] text-[#322D29] md:-mx-6">
      <header className="border-b border-[#D1C7BD] px-5 py-3 sm:px-7">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-[-0.02em] text-[#322D29]">{view.title}</h1>
            <p className="mt-0.5 truncate text-[11px] text-[#322D29]/60">{view.description}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2 border-l border-[#AC9C8D] pl-3">
            <Building2 className="h-3.5 w-3.5 text-[#72383D]" />
            <div>
              <p className="text-[8px] font-bold uppercase tracking-[0.14em] text-[#322D29]/50">Empresa activa</p>
              <p className="mt-0.5 max-w-[190px] truncate text-[11px] font-semibold text-[#322D29]">
                {getFinancialCompanyDisplayName(activeCompany)}
              </p>
            </div>
          </div>
        </div>
      </header>

      {children}
    </div>
  )
}

export function FinancialPlaceholder() {
  return (
    <main className="min-h-[430px] bg-[#EFE9E1] px-5 py-5 sm:px-7 sm:py-6">
      <div className="flex min-h-[270px] items-center justify-center">
        <div className="w-full max-w-xl border border-dashed border-[#AC9C8D]/70 bg-white/35 px-6 py-10 text-center">
          <div className="mx-auto h-1 w-10 bg-[#72383D]" />
          <p className="mt-4 text-sm font-semibold text-[#322D29]">Datos financieros aún no disponibles</p>
          <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-[#322D29]/60">
            Esta vista ya está preparada para recibir datos financieros trazables cuando el backend correspondiente esté disponible.
          </p>
        </div>
      </div>
    </main>
  )
}
