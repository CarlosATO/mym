'use client'

import { useState, useEffect } from 'react'
import { forceSyncBsaleProducts, forceSyncBsaleProductTypes, getSyncStatus } from '@/app/actions/integraciones/sync'
import { RefreshCw, CheckCircle2, AlertCircle, Clock } from 'lucide-react'

export function CatalogBsaleSyncStatus() {
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const loadStatus = async () => {
    const res = await getSyncStatus('BSALE', 'products')
    setStatus(res)
    setLoading(false)
  }

  useEffect(() => {
    loadStatus()
    const int = setInterval(loadStatus, 30000)
    return () => clearInterval(int)
  }, [])

  const handleForceSync = async () => {
    if (!confirm('¿Forzar sincronización de catálogo desde Bsale?')) return
    setSyncing(true)
    try {
      const result = await forceSyncBsaleProducts()
      if (result.status !== 'SUCCESS') throw new Error(result.message || 'Sync no finalizó correctamente')
      await loadStatus()
      window.dispatchEvent(new CustomEvent('bsale-products-sync-finished'))
    } catch (e) {
      console.error(e)
      alert('Error al sincronizar')
    } finally {
      await loadStatus()
      setSyncing(false)
    }
  }

  if (loading) return <div className="text-xs text-theme-text-muted animate-pulse">Cargando estado...</div>

  const isRunning = status?.isRunning || syncing

  return (
    <div className="flex items-center gap-4 bg-theme-surface border border-theme-border rounded-xl px-3 h-11 shadow-sm">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
        ) : status?.lastSuccess ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        ) : status?.lastRun && status.lastRun.status !== 'SUCCESS' ? (
          <AlertCircle className="w-4 h-4 text-red-500" />
        ) : (
          <Clock className="w-4 h-4 text-theme-text-muted" />
        )}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">Sync Bsale Productos</span>
          <span className="text-xs font-semibold text-theme-text">
            {isRunning ? 'En proceso' : status?.lastSuccess ? 'OK' : status?.lastRun && status.lastRun.status !== 'SUCCESS' ? 'Error' : 'Nunca'}
          </span>
        </div>
      </div>
      
      <div className="hidden md:flex flex-col border-l border-theme-border pl-4">
        <span className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">Última ejecución</span>
        <span className="text-xs text-theme-text">
          {status?.lastSuccess?.finished_at ? new Date(status.lastSuccess.finished_at).toLocaleString() : '—'}
        </span>
      </div>
      
      <div className="hidden md:flex flex-col border-l border-theme-border pl-4 pr-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">Frecuencia</span>
        <span className="text-xs text-theme-text">Cada {status?.config?.frequency_minutes || 60} min</span>
      </div>

      <button 
        onClick={handleForceSync}
        disabled={isRunning}
        className="ml-auto px-3 py-1.5 bg-theme-text/5 hover:bg-theme-text/10 border border-theme-border rounded-lg text-xs font-semibold text-theme-text transition-colors disabled:opacity-50 flex items-center gap-1.5"
      >
        <RefreshCw className={`w-3 h-3 ${isRunning ? 'animate-spin' : ''}`} />
        <span className="hidden sm:inline">Forzar sync</span>
      </button>
    </div>
  )
}

export function PseudoSupplierBsaleSyncStatus() {
  const [status, setStatus] = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)

  const loadStatus = async () => {
    const res = await getSyncStatus('BSALE', 'product_types')
    setStatus(res)
    setLoading(false)
  }

  useEffect(() => {
    loadStatus()
    const int = setInterval(loadStatus, 30000)
    return () => clearInterval(int)
  }, [])

  const handleForceSync = async () => {
    if (!confirm('¿Forzar sincronización de tipos/pseudoproveedores desde Bsale?')) return
    setSyncing(true)
    try {
      const result = await forceSyncBsaleProductTypes()
      if (result.status !== 'SUCCESS') throw new Error(result.message || 'Sync no finalizó correctamente')
      await loadStatus()
    } catch (e) {
      console.error(e)
      alert('Error al sincronizar')
    } finally {
      await loadStatus()
      setSyncing(false)
    }
  }

  if (loading) return <div className="text-xs text-theme-text-muted animate-pulse">Cargando estado...</div>

  const isRunning = status?.isRunning || syncing

  return (
    <div className="flex items-center gap-4 bg-theme-surface border border-theme-border rounded-xl px-3 h-11 shadow-sm">
      <div className="flex items-center gap-2">
        {isRunning ? (
          <RefreshCw className="w-4 h-4 text-blue-500 animate-spin" />
        ) : status?.lastSuccess ? (
          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
        ) : status?.lastRun && status.lastRun.status !== 'SUCCESS' ? (
          <AlertCircle className="w-4 h-4 text-red-500" />
        ) : (
          <Clock className="w-4 h-4 text-theme-text-muted" />
        )}
        <div className="flex flex-col">
          <span className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">Sync Tipos Bsale</span>
          <span className="text-xs font-semibold text-theme-text">
            {isRunning ? 'En proceso' : status?.lastSuccess ? 'OK' : status?.lastRun && status.lastRun.status !== 'SUCCESS' ? 'Error' : 'Nunca'}
          </span>
        </div>
      </div>
      
      <div className="hidden md:flex flex-col border-l border-theme-border pl-4">
        <span className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">Última ejecución</span>
        <span className="text-xs text-theme-text">
          {status?.lastSuccess?.finished_at ? new Date(status.lastSuccess.finished_at).toLocaleString() : '—'}
        </span>
      </div>
      
      <div className="hidden md:flex flex-col border-l border-theme-border pl-4 pr-2">
        <span className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted/70">Frecuencia</span>
        <span className="text-xs text-theme-text">Cada {status?.config?.frequency_minutes ? Math.round(status.config.frequency_minutes / 60) : 12} horas</span>
      </div>

      <button 
        onClick={handleForceSync}
        disabled={isRunning}
        className="ml-auto px-3 py-1.5 bg-theme-text/5 hover:bg-theme-text/10 border border-theme-border rounded-lg text-xs font-semibold text-theme-text transition-colors disabled:opacity-50 flex items-center gap-1.5"
      >
        <RefreshCw className={`w-3 h-3 ${isRunning ? 'animate-spin' : ''}`} />
        <span className="hidden sm:inline">Forzar sync</span>
      </button>
    </div>
  )
}
