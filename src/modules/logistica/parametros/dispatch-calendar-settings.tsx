'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { 
  getDispatchCalendars,
  getDispatchCities,
  getDispatchCalendarCities,
  createDispatchCalendar,
  saveDispatchCalendarConfig,
  DispatchCalendar,
  DispatchCalendarCity,
  DispatchCity
} from '@/app/actions/logistica/dispatch-calendar'
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { LocalCombobox } from '@/components/ui/local-combobox'
import { toast } from 'sonner'
import { Loader2, Plus, Trash2, Calendar, Check, X, ArrowLeft, Edit2, Play, Square } from 'lucide-react'

const WEEKDAYS = [
  { id: 1, label: 'Lunes' },
  { id: 2, label: 'Martes' },
  { id: 3, label: 'Miércoles' },
  { id: 4, label: 'Jueves' },
  { id: 5, label: 'Viernes' },
  { id: 6, label: 'Sábado' },
  { id: 7, label: 'Domingo' }
]

type ViewState = 'LIST' | 'EDIT'

export function DispatchCalendarSettings({ isSuperUser }: { isSuperUser: boolean }) {
  const router = useRouter()
  
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewState>('LIST')
  
  const [calendars, setCalendars] = useState<DispatchCalendar[]>([])
  const [cities, setCities] = useState<DispatchCity[]>([])
  
  // Editor State
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftActive, setDraftActive] = useState(false)
  const [draftCities, setDraftCities] = useState<Array<{
    id?: string
    weekday: number
    city_id: string
    normalized_city: string
    route_label?: string | null
    priority?: number
  }>>([])
  
  const [newCityId, setNewCityId] = useState<Record<number, string>>({})
  
  // New Calendar Modal/Inline State
  const [showCreate, setShowCreate] = useState(false)
  const [newCalendarName, setNewCalendarName] = useState('')

  useEffect(() => {
    loadInitialData()
  }, [])
  
  async function loadInitialData() {
    setLoading(true)
    
    const [resCal, resCities] = await Promise.all([
      getDispatchCalendars(),
      getDispatchCities()
    ])
    
    if (resCal.error) {
      toast.error('Error cargando calendarios: ' + resCal.error)
    } else {
      setCalendars(resCal.data || [])
    }
    
    if (resCities.error) {
      toast.error('Error cargando comunas: ' + resCities.error)
    } else {
      setCities(resCities.data || [])
    }
    
    setLoading(false)
  }

  async function handleCreateSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!newCalendarName.trim()) return
    if (!isSuperUser) return
    
    setLoading(true)
    const res = await createDispatchCalendar(newCalendarName.trim())
    if (res.error) {
      toast.error('Error creando calendario: ' + res.error)
      setLoading(false)
      return
    }
    
    toast.success('Calendario creado. Modo edición activado.')
    setShowCreate(false)
    setNewCalendarName('')
    
    // Refresh calendars and open edit view
    const resCal = await getDispatchCalendars()
    if (!resCal.error) setCalendars(resCal.data || [])
      
    if (res.data) {
      startEdit(res.data)
    }
  }

  async function startEdit(calendar: DispatchCalendar) {
    setLoading(true)
    const res = await getDispatchCalendarCities(calendar.id)
    if (res.error) {
      toast.error('Error cargando detalle: ' + res.error)
      setLoading(false)
      return
    }
    
    setEditingCalendarId(calendar.id)
    setDraftName(calendar.name)
    setDraftActive(calendar.active)
    
    // Initialize draft cities
    const loaded = res.data || []
    setDraftCities(loaded.map(c => ({
      id: c.id,
      weekday: c.weekday,
      city_id: c.city_id,
      normalized_city: c.normalized_city,
      route_label: c.route_label,
      priority: c.priority
    })))
    
    setNewCityId({})
    setView('EDIT')
    setLoading(false)
  }

  function handleDraftAddCity(weekday: number) {
    const cityId = newCityId[weekday]
    if (!cityId) return
    
    const cityObj = cities.find(c => c.id === cityId)
    if (!cityObj) return

    // Prevent duplicates in frontend
    const exists = draftCities.find(c => c.weekday === weekday && c.city_id === cityId)
    if (exists) {
      toast.error('Esta comuna ya está asignada a este día.')
      return
    }

    setDraftCities(prev => [
      ...prev,
      {
        weekday,
        city_id: cityId,
        normalized_city: cityObj.name.trim(), // Keep original capitalization as requested
        route_label: null,
        priority: 0
      }
    ])
    
    // Clear selection
    setNewCityId(prev => ({ ...prev, [weekday]: '' }))
  }

  function handleDraftRemoveCity(weekday: number, city_id: string) {
    setDraftCities(prev => prev.filter(c => !(c.weekday === weekday && c.city_id === city_id)))
  }

  async function handleSaveChanges() {
    if (!isSuperUser || !editingCalendarId) return
    if (!draftName.trim()) {
      toast.error('El nombre del calendario es obligatorio.')
      return
    }
    
    setLoading(true)
    const res = await saveDispatchCalendarConfig(editingCalendarId, {
      name: draftName.trim(),
      active: draftActive,
      assignments: draftCities
    })
    
    if (res.error) {
      toast.error(res.error)
      setLoading(false)
    } else {
      toast.success('Cambios guardados correctamente.')
      // Refresh list and go back
      const resCal = await getDispatchCalendars()
      if (!resCal.error) setCalendars(resCal.data || [])
      setView('LIST')
      setEditingCalendarId(null)
      setLoading(false)
    }
  }

  if (loading && view === 'LIST' && calendars.length === 0) {
    return (
      <div className="flex h-48 items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <div className="flex flex-col h-full bg-transparent gap-6">
      <div className="shrink-0 flex justify-between items-center p-6 border border-theme-border bg-theme-surface rounded-2xl shadow-sm">
        <div>
          <h2 className="text-xl font-bold text-theme-text">Calendario de Despacho</h2>
          <p className="text-sm text-theme-text-muted/70 mt-1">
            Administra las comunas y rutas para cada día de la semana.
          </p>
        </div>
        {!isSuperUser && (
          <p className="text-xs font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 px-3 py-1.5 rounded">Modo solo lectura</p>
        )}
      </div>

      {view === 'LIST' && (
        <div className="flex-1 flex flex-col gap-6">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold text-theme-text">Calendarios Existentes</h3>
            {isSuperUser && !showCreate && (
              <Button onClick={() => setShowCreate(true)} className="gap-2">
                <Plus className="h-4 w-4" /> Nuevo Calendario
              </Button>
            )}
          </div>

          {showCreate && (
            <div className="bg-theme-surface border border-theme-border p-6 rounded-2xl shadow-sm animate-in fade-in slide-in-from-top-4">
              <h4 className="font-medium mb-4">Crear nuevo calendario</h4>
              <form onSubmit={handleCreateSubmit} className="flex gap-4">
                <input 
                  autoFocus
                  type="text" 
                  value={newCalendarName}
                  onChange={e => setNewCalendarName(e.target.value)}
                  placeholder="Nombre del calendario (Ej: Despacho Invierno)"
                  className="flex-1 rounded-xl border border-theme-border bg-transparent px-4 py-2 text-sm text-theme-text outline-none focus:ring-2 focus:ring-blue-500/50"
                />
                <Button type="submit" disabled={!newCalendarName.trim() || loading}>Crear calendario</Button>
                <Button type="button" variant="ghost" onClick={() => {setShowCreate(false); setNewCalendarName('')}}>Cancelar</Button>
              </form>
            </div>
          )}

          {calendars.length === 0 ? (
            <div className="bg-theme-surface border border-theme-border p-12 rounded-2xl text-center text-theme-text-muted/70 shadow-sm flex flex-col items-center justify-center min-h-[300px]">
              <Calendar className="h-12 w-12 text-theme-border mb-4" />
              <p className="mb-2">No hay calendarios creados.</p>
              {!isSuperUser && <p className="text-xs">Solicita a un SUPER_USUARIO que cree uno.</p>}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {calendars.map(cal => (
                <div key={cal.id} className="bg-theme-surface border border-theme-border rounded-2xl p-6 shadow-sm flex flex-col gap-4 hover:border-theme-border-hover transition-colors">
                  <div className="flex justify-between items-start">
                    <div>
                      <h4 className="font-semibold text-theme-text text-lg">{cal.name}</h4>
                      <div className="flex items-center gap-2 mt-2">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cal.active ? 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20' : 'bg-theme-border text-theme-text-muted border border-theme-border-hover'}`}>
                          {cal.active ? 'Activo' : 'Inactivo'}
                        </span>
                      </div>
                    </div>
                  </div>
                  
                  <div className="flex justify-end pt-4 border-t border-theme-border mt-auto gap-2">
                    <Button variant="outline" size="sm" onClick={() => startEdit(cal)} className="gap-2">
                      <Edit2 className="h-3.5 w-3.5" /> Editar
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {view === 'EDIT' && (
        <div className="flex-1 flex flex-col gap-6 animate-in fade-in">
          {/* Action Bar */}
          <div className="flex flex-wrap gap-4 justify-between items-center bg-theme-surface border border-theme-border p-4 rounded-2xl shadow-sm sticky top-0 z-10">
            <div className="flex items-center gap-4">
              <Button variant="ghost" size="icon" onClick={() => setView('LIST')} disabled={loading}>
                <ArrowLeft className="h-5 w-5" />
              </Button>
              {isSuperUser ? (
                <input 
                  type="text" 
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  className="font-bold text-lg bg-transparent border-b border-transparent focus:border-blue-500 outline-none px-1 py-0.5 min-w-[250px]"
                />
              ) : (
                <h3 className="font-bold text-lg">{draftName}</h3>
              )}
            </div>
            
            <div className="flex items-center gap-4">
              {isSuperUser && (
                <button 
                  onClick={() => setDraftActive(!draftActive)}
                  className={`flex items-center gap-2 text-sm font-medium px-3 py-1.5 rounded-lg border transition-colors ${draftActive ? 'bg-green-500/10 text-green-600 border-green-500/30' : 'bg-theme-border/50 text-theme-text-muted border-theme-border'}`}
                >
                  {draftActive ? <><Check className="h-4 w-4" /> Activo</> : <><Square className="h-4 w-4" /> Inactivo</>}
                </button>
              )}
              
              {isSuperUser && (
                <Button onClick={handleSaveChanges} disabled={loading} className="gap-2 bg-blue-600 hover:bg-blue-700 text-white">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Guardar cambios
                </Button>
              )}
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {WEEKDAYS.map(day => {
              const dayCities = draftCities.filter(c => c.weekday === day.id)
              
              return (
                <div key={day.id} className="rounded-2xl bg-theme-surface shadow-sm border border-theme-border overflow-hidden flex flex-col">
                  <div className="py-3 px-5 border-b border-theme-border bg-theme-text/5 shrink-0 flex justify-between items-center">
                    <h3 className="font-semibold text-theme-text">{day.label}</h3>
                    <span className="text-xs font-medium bg-theme-border px-2 py-0.5 rounded-full text-theme-text-muted">
                      {dayCities.length}
                    </span>
                  </div>
                  
                  <div className="p-5 flex-1 flex flex-col gap-4">
                    {dayCities.length === 0 ? (
                      <div className="flex-1 flex items-center justify-center border-2 border-dashed border-theme-border/50 rounded-xl bg-theme-surface/50 p-6">
                         <p className="text-sm text-theme-text-muted/60 text-center">No hay comunas asignadas a este día.</p>
                      </div>
                    ) : (
                      <ul className="space-y-2 flex-1">
                        {dayCities.map(c => (
                          <li key={`${c.weekday}-${c.city_id}`} className="flex justify-between items-center text-sm bg-theme-surface p-3 rounded-xl border border-theme-border/70 hover:border-theme-border transition-colors group shadow-sm">
                            <span className="font-medium text-theme-text">{c.normalized_city}</span>
                            {isSuperUser && (
                              <Button variant="ghost" size="icon" className="h-7 w-7 text-theme-text-muted opacity-0 group-hover:opacity-100 hover:text-red-500 hover:bg-red-500/10 transition-all -mr-1" onClick={() => handleDraftRemoveCity(c.weekday, c.city_id)}>
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    
                    {isSuperUser && (
                      <div className="flex space-x-2 pt-4 border-t border-theme-border/50 shrink-0 mt-auto">
                        <LocalCombobox 
                          options={cities.map(c => ({ value: c.id, label: c.name }))}
                          value={newCityId[day.id] || ''}
                          onChange={(val) => setNewCityId(prev => ({ ...prev, [day.id]: val }))}
                          placeholder="Agregar comuna..."
                          className="flex-1"
                        />
                        <Button size="icon" variant="outline" className="shrink-0 text-blue-600 hover:text-blue-700 hover:bg-blue-50 dark:hover:bg-blue-900/20" onClick={() => handleDraftAddCity(day.id)}>
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
