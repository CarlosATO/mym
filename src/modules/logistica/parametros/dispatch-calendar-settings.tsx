'use client'

import { useState, useEffect } from 'react'
import { 
  getDispatchCalendars,
  getDispatchCities,
  getDispatchCalendarCities,
  createDispatchCalendar,
  saveDispatchCalendarConfig,
  updateDispatchCalendarCutoffTime,
  DispatchCalendar,
  DispatchCity
} from '@/app/actions/logistica/dispatch-calendar'
import { Button } from '@/components/ui/button'
import { LocalCombobox } from '@/components/ui/local-combobox'
import { toast } from 'sonner'
import { Loader2, Plus, CalendarDays, Check, X, ArrowLeft, Edit2, Square, Clock3, MapPin, Save } from 'lucide-react'

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
type DraftCity = {
  id?: string
  weekday: number
  city_id: string
  normalized_city: string
  route_label?: string | null
  priority?: number
}

export function DispatchCalendarSettings({ isSuperUser }: { isSuperUser: boolean }) {
  const [loading, setLoading] = useState(true)
  const [view, setView] = useState<ViewState>('LIST')
  
  const [calendars, setCalendars] = useState<DispatchCalendar[]>([])
  const [cities, setCities] = useState<DispatchCity[]>([])
  
  // Editor State
  const [editingCalendarId, setEditingCalendarId] = useState<string | null>(null)
  const [draftName, setDraftName] = useState('')
  const [draftActive, setDraftActive] = useState(false)
  const [draftCutoffTime, setDraftCutoffTime] = useState('12:00')
  const [draftCities, setDraftCities] = useState<DraftCity[]>([])
  
  const [newCityId, setNewCityId] = useState<Record<number, string>>({})
  
  // New Calendar Modal/Inline State
  const [showCreate, setShowCreate] = useState(false)
  const [newCalendarName, setNewCalendarName] = useState('')
  const [originalDraftState, setOriginalDraftState] = useState<{name: string, active: boolean, cutoffTime: string, cities: DraftCity[]} | null>(null)

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
    setDraftCutoffTime(calendar.default_cutoff_time?.substring(0, 5) || '12:00')
    
    // Initialize draft cities
    const loaded = res.data || []
    const draftC = loaded.map(c => ({
      id: c.id,
      weekday: c.weekday,
      city_id: c.city_id,
      normalized_city: c.normalized_city,
      route_label: c.route_label,
      priority: c.priority
    }))
    setDraftCities(draftC)
    
    setOriginalDraftState({
      name: calendar.name,
      active: calendar.active,
      cutoffTime: calendar.default_cutoff_time?.substring(0, 5) || '12:00',
      cities: draftC
    })
    
    setNewCityId({})
    setView('EDIT')
    setLoading(false)
  }

  function handleBackClick() {
    if (view === 'EDIT' && originalDraftState) {
      const isChanged = draftName !== originalDraftState.name || 
                        draftActive !== originalDraftState.active ||
                        draftCutoffTime !== originalDraftState.cutoffTime ||
                        JSON.stringify(draftCities) !== JSON.stringify(originalDraftState.cities)
      if (isChanged) {
        if (!window.confirm('Hay cambios sin guardar. ¿Deseas salir sin guardar?')) {
          return
        }
      }
    }
    setView('LIST')
    setEditingCalendarId(null)
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

  async function handleSaveCutoffTime() {
    if (!isSuperUser || !editingCalendarId) return
    setLoading(true)
    const res = await updateDispatchCalendarCutoffTime({
      calendarId: editingCalendarId,
      defaultCutoffTime: draftCutoffTime
    })
    
    if (res.error) {
      toast.error(res.error)
      setLoading(false)
    } else {
      toast.success('Hora de corte actualizada correctamente.')
      const resCal = await getDispatchCalendars()
      if (!resCal.error) setCalendars(resCal.data || [])
      if (originalDraftState) setOriginalDraftState({...originalDraftState, cutoffTime: draftCutoffTime})
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
    <div className="flex min-h-0 flex-col overflow-y-auto bg-theme-surface">
      <header className="shrink-0 border-b border-theme-border/60 bg-theme-text/[0.012]">
        <div className="flex items-end justify-between gap-4 px-5 pb-3 pt-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CalendarDays className="h-4 w-4 shrink-0 text-theme-accent" />
              <h1 className="text-base font-semibold tracking-tight text-theme-text">Calendario de Despacho</h1>
            </div>
            <p className="mt-0.5 text-[11px] text-theme-text-muted/70">Comunas y rutas organizadas por día de la semana</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="hidden text-[11px] font-medium tabular-nums text-theme-text-muted/70 sm:inline">{calendars.length} {calendars.length === 1 ? 'calendario' : 'calendarios'}</span>
            {!isSuperUser && <span className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">Solo lectura</span>}
          </div>
        </div>
      </header>

      {view === 'LIST' && (
        <div className="flex flex-col gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-theme-text">Calendarios configurados</h2>
              <p className="mt-0.5 text-[11px] text-theme-text-muted/65">Selecciona un calendario para revisar su programación semanal.</p>
            </div>
            {isSuperUser && !showCreate && (
              <Button onClick={() => setShowCreate(true)} className="h-9 gap-2 rounded-xl bg-theme-accent px-3.5 text-xs font-semibold text-white shadow-sm shadow-theme-accent/20 hover:bg-theme-accent-hover">
                <Plus className="h-4 w-4" /> Nuevo calendario
              </Button>
            )}
          </div>

          {showCreate && (
            <div className="relative rounded-2xl border border-theme-border bg-theme-text/[0.018] p-4 shadow-sm animate-in fade-in slide-in-from-top-2">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h3 className="text-sm font-semibold text-theme-text">Crear nuevo calendario</h3>
                  <p className="mt-0.5 text-[11px] text-theme-text-muted/65">El primer calendario creado queda activo por defecto.</p>
                </div>
                <Button variant="ghost" size="sm" className="h-8 gap-1 rounded-lg text-xs text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text" onClick={() => {setShowCreate(false); setNewCalendarName('')}}>
                  <X className="h-4 w-4" /> Cerrar
                </Button>
              </div>
              <form onSubmit={handleCreateSubmit} className="flex flex-col gap-2 sm:flex-row">
                <input 
                  autoFocus
                  type="text" 
                  value={newCalendarName}
                  onChange={e => setNewCalendarName(e.target.value)}
                  placeholder="Nombre del calendario (Ej: Despacho Invierno)"
                  className="h-10 min-w-0 flex-1 rounded-xl border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none transition-colors placeholder:text-theme-text-muted/45 focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/20"
                />
                <Button type="submit" disabled={!newCalendarName.trim() || loading} className="h-10 rounded-xl bg-theme-accent px-4 text-xs font-semibold text-white hover:bg-theme-accent-hover">Crear calendario</Button>
              </form>
            </div>
          )}

          {calendars.length === 0 ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center rounded-2xl border border-dashed border-theme-border bg-theme-text/[0.012] p-8 text-center text-theme-text-muted/70">
              <div className="mb-3 rounded-xl border border-theme-border bg-theme-surface p-3 text-theme-text-muted/60"><CalendarDays className="h-7 w-7" /></div>
              <p className="text-sm font-semibold text-theme-text">No hay calendarios creados</p>
              {!isSuperUser && <p className="mt-1 text-xs">Solicita a un SUPER_USUARIO que cree uno.</p>}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {calendars.map(cal => (
                <div key={cal.id} className="group flex min-h-[154px] flex-col gap-4 rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm transition-all hover:border-theme-accent/40 hover:shadow-md">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="truncate text-sm font-semibold text-theme-text">{cal.name}</h3>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[10px] font-semibold ${cal.active ? 'border-theme-accent/25 bg-theme-accent/10 text-theme-text-accent' : 'border-theme-border bg-theme-text/5 text-theme-text-muted'}`}>
                          <span className={`h-1.5 w-1.5 rounded-full ${cal.active ? 'bg-theme-accent' : 'bg-theme-text-muted/45'}`} />
                          {cal.active ? 'Activo' : 'Inactivo'}
                        </span>
                        <span className="inline-flex items-center gap-1 text-[10px] font-medium text-theme-text-muted/70"><Clock3 className="h-3 w-3" /> Corte {cal.default_cutoff_time?.substring(0, 5) || '--:--'}</span>
                      </div>
                    </div>
                    <CalendarDays className="h-4 w-4 shrink-0 text-theme-text-muted/35 transition-colors group-hover:text-theme-accent/70" />
                  </div>

                  <div className="mt-auto flex items-center justify-between border-t border-theme-border/70 pt-3">
                    <span className="text-[10px] text-theme-text-muted/55">Programación semanal</span>
                    <Button variant="outline" size="sm" onClick={() => startEdit(cal)} className="h-8 gap-1.5 rounded-lg border-theme-border px-2.5 text-xs font-semibold text-theme-text-muted hover:border-theme-accent/40 hover:bg-theme-accent/5 hover:text-theme-text">
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
        <div className="flex min-h-0 flex-col gap-4 p-5 animate-in fade-in">
          {/* Action Bar */}
          <div className="flex flex-col gap-3 rounded-2xl border border-theme-border bg-theme-text/[0.018] p-3 shadow-sm sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
              <Button variant="ghost" size="sm" onClick={handleBackClick} disabled={loading} className="h-8 shrink-0 gap-1.5 rounded-lg px-2 text-xs text-theme-text-muted hover:bg-theme-text/5 hover:text-theme-text">
                <ArrowLeft className="h-4 w-4" /> <span className="hidden sm:inline">Volver a lista</span>
              </Button>
              {isSuperUser ? (
                <input 
                  type="text" 
                  value={draftName}
                  onChange={e => setDraftName(e.target.value)}
                  className="min-w-0 flex-1 border-b border-transparent bg-transparent px-1 py-0.5 text-sm font-semibold text-theme-text outline-none transition-colors focus:border-theme-accent sm:min-w-[220px]"
                />
              ) : (
                <h2 className="truncate text-sm font-semibold text-theme-text">{draftName}</h2>
              )}
            </div>
            
            <div className="flex flex-wrap items-center gap-2 sm:justify-end">
              {isSuperUser && (
                <button 
                  onClick={() => setDraftActive(!draftActive)}
                  className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-semibold transition-colors ${draftActive ? 'border-theme-accent/25 bg-theme-accent/10 text-theme-text-accent' : 'border-theme-border bg-theme-text/5 text-theme-text-muted'}`}
                >
                  {draftActive ? <><Check className="h-4 w-4" /> Activo</> : <><Square className="h-4 w-4" /> Inactivo</>}
                </button>
              )}
              
              {isSuperUser && (
                <Button onClick={handleSaveChanges} disabled={loading} className="h-8 gap-1.5 rounded-lg bg-theme-accent px-3 text-xs font-semibold text-white shadow-sm shadow-theme-accent/20 hover:bg-theme-accent-hover">
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  Guardar cambios
                </Button>
              )}
            </div>
          </div>

          {/* General Config Block */}
          <div className="flex flex-col items-start justify-between gap-4 rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-sm md:flex-row md:items-center">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <Clock3 className="h-4 w-4 text-theme-accent" />
                <h3 className="text-sm font-semibold text-theme-text">Hora de corte por defecto</h3>
              </div>
              <p className="mt-1 max-w-3xl text-xs leading-relaxed text-theme-text-muted">
                Las notas de venta generadas después de esta hora, el día anterior a la ruta, quedarán fuera de corte y requerirán autorización.
              </p>
              <p className="mt-2 text-[11px] font-semibold text-theme-text-accent">
                Corte guardado: {originalDraftState?.cutoffTime}
              </p>
            </div>
            
            <div className="flex w-full shrink-0 flex-wrap items-center gap-2 md:w-auto">
              <input 
                type="time" 
                value={draftCutoffTime}
                onChange={e => setDraftCutoffTime(e.target.value)}
                disabled={!isSuperUser || loading}
                className="h-9 rounded-lg border border-theme-border bg-theme-surface px-3 text-sm text-theme-text outline-none transition-colors focus:border-theme-accent focus:ring-2 focus:ring-theme-accent/20 disabled:opacity-50"
              />
              {isSuperUser ? (
                <Button onClick={handleSaveCutoffTime} disabled={loading || draftCutoffTime === originalDraftState?.cutoffTime} size="sm" variant="outline" className="h-9 rounded-lg border-theme-border px-3 text-xs font-semibold hover:border-theme-accent/40 hover:bg-theme-accent/5">
                  <Save className="mr-1.5 h-3.5 w-3.5" /> Actualizar hora
                </Button>
              ) : (
                <p className="rounded-md border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] font-semibold text-amber-600 dark:text-amber-400">Solo Super Usuario</p>
              )}
            </div>
          </div>

          <div className="flex items-center justify-between gap-3 border-b border-theme-border/70 pb-2">
            <div>
              <h3 className="text-sm font-semibold text-theme-text">Programación semanal</h3>
              <p className="mt-0.5 text-[11px] text-theme-text-muted/65">Cada comuna puede asignarse una vez por día.</p>
            </div>
            <span className="hidden items-center gap-1.5 text-[10px] font-medium text-theme-text-muted/65 sm:flex"><MapPin className="h-3.5 w-3.5" /> {draftCities.length} asignaciones</span>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
            {WEEKDAYS.map(day => {
              const dayCities = draftCities.filter(c => c.weekday === day.id)
              
              return (
                <div key={day.id} className="flex min-h-[205px] flex-col overflow-hidden rounded-2xl border border-theme-border bg-theme-surface shadow-sm">
                  <div className={`flex shrink-0 items-center justify-between border-b px-3.5 py-2.5 ${dayCities.length > 0 ? 'border-theme-accent/20 bg-theme-accent/[0.055]' : 'border-theme-border bg-theme-text/[0.025]'}`}>
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full ${dayCities.length > 0 ? 'bg-theme-accent' : 'bg-theme-text-muted/30'}`} />
                      <h3 className="text-xs font-semibold text-theme-text">{day.label}</h3>
                    </div>
                    <span className={`rounded-md border px-1.5 py-0.5 text-[10px] font-semibold ${dayCities.length > 0 ? 'border-theme-accent/20 bg-theme-accent/10 text-theme-text-accent' : 'border-theme-border bg-theme-surface text-theme-text-muted/65'}`}>
                      {dayCities.length}
                    </span>
                  </div>
                  
                  <div className="p-3 flex-1 flex flex-col gap-3">
                    {dayCities.length === 0 ? (
                      <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed border-theme-border/70 bg-theme-text/[0.012] p-5">
                         <p className="text-[11px] leading-relaxed text-theme-text-muted/60 text-center">Sin programación para este día</p>
                      </div>
                    ) : (
                      <ul className="flex-1 space-y-1.5">
                        {dayCities.map(c => (
                          <li key={`${c.weekday}-${c.city_id}`} className="group flex items-center justify-between gap-2 rounded-lg border border-theme-border/70 bg-theme-text/[0.018] px-2.5 py-2 text-sm transition-colors hover:border-theme-accent/35 hover:bg-theme-accent/[0.035]">
                            <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-theme-text"><MapPin className="h-3.5 w-3.5 shrink-0 text-theme-text-muted/50" /><span className="truncate">{c.normalized_city}</span></span>
                            {isSuperUser && (
                              <Button variant="ghost" size="icon" className="-mr-1 h-7 w-7 shrink-0 text-theme-text-muted opacity-60 transition-all hover:bg-red-500/10 hover:text-red-500 group-hover:opacity-100" onClick={() => handleDraftRemoveCity(c.weekday, c.city_id)} aria-label={`Quitar ${c.normalized_city}`}>
                                <X className="h-4 w-4" />
                              </Button>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                    
                    {isSuperUser && (
                      <div className="mt-auto flex shrink-0 gap-2 border-t border-theme-border/50 pt-3">
                        <LocalCombobox 
                          options={cities.map(c => ({ value: c.id, label: c.name }))}
                          value={newCityId[day.id] || ''}
                          onChange={(val) => setNewCityId(prev => ({ ...prev, [day.id]: val }))}
                          placeholder="Agregar comuna..."
                          className="flex-1"
                        />
                        <Button size="icon" variant="outline" className="h-9 w-9 shrink-0 rounded-lg border-theme-border text-theme-text-accent hover:border-theme-accent/40 hover:bg-theme-accent/5" onClick={() => handleDraftAddCity(day.id)} aria-label={`Agregar comuna a ${day.label}`}>
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
