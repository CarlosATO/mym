'use client'

import { useState, useEffect, useRef } from 'react'
import { getUserCompanies, setActiveCompanyId, getActiveCompany, type UserCompany, type Company } from '@/app/actions/companies'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

export function CompanySwitcher() {
  const [companies, setCompanies] = useState<UserCompany[]>([])
  const [activeCompany, setActiveCompany] = useState<Company | null>(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(true)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    async function loadData() {
      try {
        const list = await getUserCompanies()
        const active = await getActiveCompany()
        setCompanies(list)
        setActiveCompany(active)
      } catch (err) {
        console.error('Error loading companies in switcher:', err)
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [])

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [])

  const handleSelect = async (companyId: string) => {
    if (activeCompany && activeCompany.id === companyId) {
      setOpen(false)
      return
    }

    // Pedir confirmación solo si hay cambios sin guardar detectados en la página actual
    const isDirty = document.querySelector('[data-unsaved-changes="true"]') || document.querySelector('form.dirty')
    const canSwitch = !isDirty || window.confirm('¿Cambiar de empresa activa? Se perderán los cambios que no hayas guardado en la página actual.')

    if (!canSwitch) {
      setOpen(false)
      return
    }

    setOpen(false)
    setLoading(true)
    const res = await setActiveCompanyId(companyId)
    if (res.success) {
      // Limpiar formularios (el reload lo hará automáticamente)
      window.location.reload()
    } else {
      alert(res.error || 'Error al cambiar de empresa')
      setLoading(false)
    }
  }

  if (loading) {
    return (
      <div className="h-9 px-3 flex items-center justify-center rounded-xl bg-theme-surface/50 border border-white/5 text-xs text-theme-text-muted">
        <LucideIcons.Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
        <span>Cargando empresa...</span>
      </div>
    )
  }

  if (!activeCompany) {
    return (
      <div className="w-full space-y-3">
        <p className="text-[10px] font-bold text-theme-accent uppercase tracking-wider text-center">Empresas disponibles:</p>
        <div className="flex flex-col gap-2">
          {companies.map(({ company }) => (
            <button
              key={company.id}
              onClick={() => handleSelect(company.id)}
              className="w-full flex items-center gap-3.5 px-4 py-3 rounded-2xl bg-white/5 border border-white/5 hover:border-theme-accent/30 hover:bg-white/10 text-theme-text transition-all duration-200 text-left group"
            >
              <div className="w-8 h-8 rounded-xl bg-white/5 flex items-center justify-center text-sm font-bold text-theme-text group-hover:scale-105 transition-transform shrink-0">
                {company.logo_url ? (
                  <img src={company.logo_url} alt="Logo" className="w-6 h-6 object-contain" />
                ) : (
                  company.business_name[0]
                )}
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-sm truncate leading-none mb-1">{company.trade_name || company.business_name}</p>
                <p className="text-[10px] text-theme-text-muted/70 truncate leading-none">{company.rut || 'Sin RUT'}</p>
              </div>
              <LucideIcons.ArrowRight className="h-4 w-4 text-theme-text-muted group-hover:text-theme-accent group-hover:translate-x-0.5 transition-all shrink-0" />
            </button>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2.5 px-3 py-1.5 rounded-xl border border-white/10 bg-theme-surface/60 hover:bg-white/10 text-theme-text transition-all duration-200 shadow-sm text-left max-w-[240px]"
      >
        <div className="w-6 h-6 rounded bg-gradient-to-br from-theme-accent to-theme-accent-hover flex items-center justify-center text-xs font-bold text-white shrink-0 shadow-sm">
          {activeCompany.logo_url ? (
            <img src={activeCompany.logo_url} alt="Logo" className="w-5 h-5 object-contain" />
          ) : (
            activeCompany.business_name[0]
          )}
        </div>
        <div className="truncate leading-tight">
          <p className="text-xs font-bold text-theme-text max-w-[150px] truncate">{activeCompany.trade_name || activeCompany.business_name}</p>
          <p className="text-[10px] text-theme-text-muted/60 truncate max-w-[150px]">{activeCompany.rut || 'Sin RUT'}</p>
        </div>
        <LucideIcons.ChevronsUpDown className="h-3.5 w-3.5 text-theme-accent shrink-0" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full mt-2 w-64 bg-theme-surface/95 backdrop-blur-md rounded-2xl border border-white/10 shadow-2xl shadow-black/40 z-50 py-2 overflow-hidden animate-in fade-in slide-in-from-top-2 duration-150">
            <div className="px-4 py-2 border-b border-theme-border/60">
              <p className="text-[10px] font-bold text-theme-accent uppercase tracking-wider">Cambiar Empresa Activa</p>
            </div>
            <div className="max-h-60 overflow-y-auto p-1 space-y-0.5">
              {companies.map(({ company }) => {
                const isSelected = company.id === activeCompany.id
                return (
                  <button
                    key={company.id}
                    onClick={() => handleSelect(company.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 text-xs rounded-xl transition-all text-left",
                      isSelected
                        ? "bg-theme-accent/20 text-theme-text font-semibold border border-theme-accent/20"
                        : "text-theme-text-muted hover:bg-white/5 hover:text-theme-text"
                    )}
                  >
                    <div className="w-5 h-5 rounded bg-white/5 flex items-center justify-center text-[10px] font-bold text-theme-text shrink-0">
                      {company.logo_url ? (
                        <img src={company.logo_url} alt="Logo" className="w-4 h-4 object-contain" />
                      ) : (
                        company.business_name[0]
                      )}
                    </div>
                    <div className="flex-1 truncate">
                      <p className="truncate font-semibold">{company.trade_name || company.business_name}</p>
                      <p className="text-[9px] opacity-60 truncate">{company.rut || 'Sin RUT'}</p>
                    </div>
                    {isSelected && (
                      <LucideIcons.Check className="h-3.5 w-3.5 text-theme-accent shrink-0" />
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
