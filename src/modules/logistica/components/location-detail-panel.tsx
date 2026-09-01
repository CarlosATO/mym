'use client'

import { useEffect, useState } from 'react'
import { X, Layers, Package, Calendar, Edit2, Power, Trash2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { getLocationDetail, type LocationDetailItem } from '@/app/actions/logistica/location-layouts'
import { deactivateLocation, deleteLocation, getLocationLifecycle, type LocationLifecycle } from '@/app/actions/logistica/locations'
import { LocationLifecycleBadges, lifecycleReasons } from './location-lifecycle'

interface LocationDetailPanelProps {
  locationId: string
  locationCode: string
  isActive?: boolean
  onClose: () => void
  onEdit?: () => void
  onStatusChange?: () => void
  onDelete?: () => void
}

function formatCurrency(amount: number | null) {
  if (amount === null || isNaN(amount)) return 'Sin costo'
  return amount.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })
}

export function LocationDetailPanel({ locationId, locationCode, isActive = true, onClose, onEdit, onStatusChange, onDelete }: LocationDetailPanelProps) {
  const [data, setData] = useState<LocationDetailItem[]>([])
  const [loading, setLoading] = useState(true)
  const [isChangingStatus, setIsChangingStatus] = useState(false)
  const [lifecycle, setLifecycle] = useState<LocationLifecycle | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    getLocationDetail(locationId).then(res => {
      if (active) {
        setData(res)
        setLoading(false)
      }
    })
    getLocationLifecycle(locationId).then(res => {
      if (active && !('error' in res)) setLifecycle(res)
    })
    return () => { active = false }
  }, [locationId])

  const handleToggleStatus = async () => {
    if (isActive && lifecycle && !lifecycle.can_deactivate) {
      setError(lifecycleReasons(lifecycle).join(' ') || 'Esta ubicación no puede desactivarse.')
      return
    }
    if (!confirm(`¿Estás seguro de ${isActive ? 'desactivar' : 'activar'} esta ubicación?`)) return
    setIsChangingStatus(true)
    try {
      const res = await deactivateLocation(locationId)
      if (res.error) setError(res.error)
      if (res.success && onStatusChange) {
        onStatusChange()
      }
    } catch (e) {
      console.error(e)
    } finally {
      setIsChangingStatus(false)
    }
  }

  const handleDelete = async () => {
    if (!lifecycle?.can_delete) {
      setError(lifecycleReasons(lifecycle).join(' ') || 'Esta ubicación no puede eliminarse.')
      return
    }
    if (!confirm('Solo pueden eliminarse ubicaciones que nunca han sido utilizadas y no poseen historial operacional. ¿Desea eliminar esta ubicación?')) return
    setIsChangingStatus(true)
    const res = await deleteLocation(locationId)
    if (res.error) {
      setError(res.error)
      setIsChangingStatus(false)
      const fresh = await getLocationLifecycle(locationId)
      if (!('error' in fresh)) setLifecycle(fresh)
      return
    }
    onDelete?.()
  }

  return (
    <>
      {/* Backdrop for mobile */}
      <div 
        className="fixed inset-0 bg-black/20 dark:bg-black/40 z-40 lg:hidden transition-opacity" 
        onClick={onClose}
      />
      <div className="fixed lg:static right-0 top-[60px] h-[calc(100vh-60px)] lg:h-full w-full lg:w-[420px] shrink-0 bg-theme-surface flex flex-col animate-in slide-in-from-right-8 duration-300 shadow-2xl lg:shadow-none z-50 lg:z-auto">
        <div className="p-4 border-b border-theme-border flex items-center justify-between bg-theme-surface shrink-0">
          <div>
            <h3 className="font-bold text-theme-text flex items-center gap-2 text-sm">
              <Layers className="w-4 h-4 text-theme-accent" />
              Ubicación {locationCode}
              {!isActive && <span className="text-[10px] bg-red-100 text-red-600 px-1.5 py-0.5 rounded ml-2">Inactiva</span>}
            </h3>
          </div>
            <div className="flex items-center gap-1">
            {onEdit && (
              <button onClick={onEdit} className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors" title="Editar">
                <Edit2 className="w-4 h-4" />
              </button>
            )}
             <button disabled={isChangingStatus || Boolean(isActive && lifecycle && !lifecycle.can_deactivate)} onClick={handleToggleStatus} className={`p-1.5 rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${isActive ? 'hover:bg-red-100 text-theme-text-muted hover:text-red-600' : 'hover:bg-emerald-100 text-theme-text-muted hover:text-emerald-600'}`} title={isActive && lifecycle && !lifecycle.can_deactivate ? lifecycleReasons(lifecycle).join(' ') : isActive ? 'Desactivar' : 'Activar'}>
               <Power className="w-4 h-4" />
             </button>
             <button disabled={isChangingStatus || !lifecycle?.can_delete} onClick={handleDelete} className="p-1.5 rounded-lg text-red-500 hover:bg-red-100 disabled:cursor-not-allowed disabled:opacity-30" title={lifecycle?.can_delete ? 'Eliminar' : lifecycleReasons(lifecycle).join(' ') || 'Verificando permisos'}>
               <Trash2 className="w-4 h-4" />
             </button>
            <div className="w-px h-4 bg-theme-border mx-1" />
            <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-theme-text/10 text-theme-text-muted transition-colors">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

      <div className="flex-1 overflow-y-auto p-5">
        {error && <div className="mb-4 rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs text-red-600">{error}</div>}
        {lifecycle && <div className="mb-4 space-y-2"><LocationLifecycleBadges lifecycle={lifecycle} /><div className="text-xs text-theme-text-muted">{lifecycle.found ? (isActive ? 'Activa' : 'Inactiva') : 'La ubicación ya no está disponible.'}</div></div>}
        {loading ? (
          <div className="py-8 flex flex-col items-center justify-center">
            <div className="w-6 h-6 border-2 border-theme-accent border-t-transparent rounded-full animate-spin mb-3" />
            <p className="text-xs text-theme-text-muted font-medium">Cargando contenido...</p>
          </div>
        ) : data.length === 0 ? (
          <div className="py-8 text-center bg-theme-text/5 rounded-xl border border-theme-border border-dashed mt-4">
            <p className="text-sm font-semibold text-theme-text">Ubicación Vacía</p>
            <p className="text-xs text-theme-text-muted mt-1">No hay productos almacenados aquí.</p>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-bold text-theme-text-muted uppercase">Contenido</span>
              <span className="text-xs font-black text-theme-accent">{data.reduce((acc, it) => acc + it.quantity, 0)} unds en total</span>
            </div>
            
            {data.map((item, idx) => (
              <div key={idx} className="bg-theme-surface border border-theme-border p-4 rounded-xl shadow-sm">
                <p className="font-mono text-[10px] font-bold text-theme-accent mb-1">{item.product_sku}</p>
                <p className="font-bold text-theme-text text-sm mb-3 leading-tight">{item.product_description}</p>
                
                <div className="grid grid-cols-2 gap-2">
                  <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border/50">
                    <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5 flex items-center gap-1">
                      <Package className="w-2.5 h-2.5" /> Lote
                    </p>
                    <p className="font-semibold text-theme-text text-xs truncate">{item.lot_number || '—'}</p>
                  </div>
                  <div className="bg-theme-text/5 p-2 rounded-lg border border-theme-border/50">
                    <p className="text-[9px] font-bold text-theme-text-muted uppercase mb-0.5 flex items-center gap-1">
                      <Calendar className="w-2.5 h-2.5" /> Vence
                    </p>
                    <p className="font-semibold text-theme-text text-xs truncate">
                      {item.expiration_date ? new Date(item.expiration_date).toLocaleDateString('es-CL') : '—'}
                    </p>
                  </div>
                </div>
                
                <div className="mt-3 flex items-center justify-between border-t border-theme-border/50 pt-3">
                  <span className="text-[10px] font-bold text-theme-text-muted uppercase">Cantidad</span>
                  <span className="font-black text-theme-text text-base">{item.quantity}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
    </>
  )
}
