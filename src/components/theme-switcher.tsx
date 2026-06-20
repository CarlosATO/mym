'use client'

import { useState, useRef, useEffect } from 'react'
import { useTheme } from 'next-themes'
import * as LucideIcons from 'lucide-react'
import { cn } from '@/lib/utils'

export function ThemeSwitcher() {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const { theme, setTheme } = useTheme()

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center justify-center w-9 h-9 rounded-xl hover:bg-theme-text/5 text-theme-text-muted hover:text-theme-text transition-colors"
        title="Cambiar tema visual"
      >
        <LucideIcons.Palette className="h-4 w-4" />
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-2 w-48 bg-theme-surface/95 backdrop-blur-md rounded-2xl border border-white/10 shadow-2xl shadow-black/40 z-50 p-2 overflow-hidden">
            <p className="px-2 text-[10px] font-semibold text-theme-text-muted/70 mb-1.5 uppercase tracking-wider">Tema Visual</p>
            <div className="flex flex-col gap-0.5">
              <button
                onClick={() => { setTheme('blue'); setOpen(false); }}
                className={cn(
                  "flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-md transition-colors",
                  theme === 'blue' ? "bg-theme-text/10 text-theme-text" : "text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
                )}
              >
                <span className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-slate-700 border border-slate-400" />
                  Azul Corporativo
                </span>
                {theme === 'blue' && <LucideIcons.Check className="w-3 h-3 text-theme-accent" />}
              </button>
              <button
                onClick={() => { setTheme('dark'); setOpen(false); }}
                className={cn(
                  "flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-md transition-colors",
                  theme === 'dark' ? "bg-theme-text/10 text-theme-text" : "text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
                )}
              >
                <span className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-neutral-900 border border-neutral-600" />
                  Modo Oscuro
                </span>
                {theme === 'dark' && <LucideIcons.Check className="w-3 h-3 text-theme-accent" />}
              </button>
                <button
                  onClick={() => { setTheme('purple'); setOpen(false); }}
                  className={cn(
                    "flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-md transition-colors",
                    theme === 'purple' ? "bg-theme-text/10 text-theme-text" : "text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-purple-900 border border-purple-400" />
                    Datix Purple
                  </span>
                  {theme === 'purple' && <LucideIcons.Check className="w-3 h-3 text-theme-accent" />}
                </button>
                <button
                  onClick={() => { setTheme('light'); setOpen(false); }}
                  className={cn(
                    "flex items-center justify-between w-full px-2 py-1.5 text-xs rounded-md transition-colors",
                    theme === 'light' ? "bg-theme-text/10 text-theme-text" : "text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text"
                  )}
                >
                  <span className="flex items-center gap-2">
                    <div className="w-2.5 h-2.5 rounded-full bg-white border border-slate-300" />
                    Modo Claro
                  </span>
                  {theme === 'light' && <LucideIcons.Check className="w-3 h-3 text-theme-accent" />}
                </button>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
