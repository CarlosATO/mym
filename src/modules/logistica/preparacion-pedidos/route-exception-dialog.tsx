'use client'

import { useState, useMemo } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Search, AlertCircle, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { authorizeSalesOrderRouteException } from '@/app/actions/logistica/sales-order-preparation'

interface RouteExceptionDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  outOfCutoffCandidates: any[]
  routeDate: string | null
  onSuccess: () => void
}

const REASON_OPTIONS = [
  'Solicitud de vendedor',
  'Compromiso con cliente',
  'Autorización de jefatura',
  'Error operacional',
  'Otro'
]

export function RouteExceptionDialog({
  open,
  onOpenChange,
  outOfCutoffCandidates,
  routeDate,
  onSuccess
}: RouteExceptionDialogProps) {
  const [search, setSearch] = useState('')
  const [selectedNvId, setSelectedNvId] = useState<string>('')
  const [reason, setReason] = useState<string>('')
  const [observation, setObservation] = useState<string>('')
  const [isLoading, setIsLoading] = useState(false)

  const filteredCandidates = useMemo(() => {
    if (!search.trim()) return outOfCutoffCandidates
    const q = search.toLowerCase()
    return outOfCutoffCandidates.filter(c => 
      c.nv_folio?.toString().includes(q) ||
      c.client_name?.toLowerCase().includes(q) ||
      c.route_location_normalized?.toLowerCase().includes(q)
    )
  }, [outOfCutoffCandidates, search])

  const handleAuthorize = async () => {
    if (!selectedNvId) {
      toast.error('Debes seleccionar una Nota de Venta.')
      return
    }
    if (!reason) {
      toast.error('Debes seleccionar un motivo.')
      return
    }
    if (!observation.trim()) {
      toast.error('La observación es obligatoria.')
      return
    }
    if (!routeDate) {
      toast.error('No hay una ruta activa a la cual incluir la NV.')
      return
    }

    setIsLoading(true)
    try {
      const result = await authorizeSalesOrderRouteException({
        bsaleNvId: selectedNvId,
        routeDate: routeDate,
        reason,
        observation
      })

      if (!result.ok) {
        toast.error(result.error || 'Ocurrió un error al autorizar la excepción.')
        return
      }

      toast.success('Nota de Venta incluida en la ruta exitosamente.')
      
      // Limpiar formulario y cerrar
      setSearch('')
      setSelectedNvId('')
      setReason('')
      setObservation('')
      onSuccess()
      onOpenChange(false)
    } catch (err: any) {
      toast.error(err.message || 'Error de conexión.')
    } finally {
      setIsLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(val) => {
      if (!isLoading) onOpenChange(val)
    }}>
      <DialogContent className="max-w-2xl max-h-[90vh] flex flex-col gap-0 p-0 overflow-hidden bg-theme-base border-theme-border text-theme-text">
        <div className="p-6 pb-4 border-b border-theme-border/50">
          <DialogHeader>
            <DialogTitle className="text-xl">Incluir NV fuera de corte</DialogTitle>
            <DialogDescription className="text-theme-text/70">
              Autoriza manualmente una Nota de Venta que fue generada después del corte horario para que ingrese a la ruta activa.
            </DialogDescription>
          </DialogHeader>
        </div>

        <div className="p-6 overflow-y-auto flex-1 flex flex-col gap-6">
          {outOfCutoffCandidates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-theme-text/60">
              <CheckCircle2 className="w-12 h-12 mb-3 text-green-500/50" />
              <p>No hay Notas de Venta fuera de corte en este momento.</p>
            </div>
          ) : (
            <>
              {/* Search */}
              <div className="relative">
                <Search className="absolute left-3 top-2.5 h-4 w-4 text-theme-text/50" />
                <Input
                  placeholder="Buscar por folio, cliente o localidad..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  className="pl-9 bg-theme-panel border-theme-border/50"
                  disabled={isLoading}
                />
              </div>

              {/* List */}
              <div className="border border-theme-border/50 rounded-md overflow-hidden bg-theme-panel">
                <div className="max-h-60 overflow-y-auto p-2">
                  <div className="flex flex-col gap-1">
                    {filteredCandidates.length === 0 ? (
                      <div className="p-4 text-center text-sm text-theme-text/50">
                        No se encontraron resultados para la búsqueda.
                      </div>
                    ) : (
                      filteredCandidates.map(c => (
                        <div key={c.bsale_nv_id} className="flex items-start space-x-3 p-3 hover:bg-theme-base/50 rounded-md transition-colors cursor-pointer" onClick={() => setSelectedNvId(c.bsale_nv_id.toString())}>
                          <input 
                            type="radio"
                            name="nv-selection"
                            checked={selectedNvId === c.bsale_nv_id.toString()}
                            onChange={() => setSelectedNvId(c.bsale_nv_id.toString())}
                            id={`nv-${c.bsale_nv_id}`} 
                            className="mt-1.5 w-4 h-4 text-theme-accent border-theme-border focus:ring-theme-accent" 
                            disabled={isLoading}
                          />
                          <Label htmlFor={`nv-${c.bsale_nv_id}`} className="flex-1 cursor-pointer">
                            <div className="flex justify-between items-start mb-1">
                              <span className="font-semibold text-theme-text">NV {c.nv_folio}</span>
                              <span className="text-xs text-theme-text/60">{c.route_location_normalized}</span>
                            </div>
                            <div className="text-sm text-theme-text/80">{c.client_name}</div>
                            <div className="text-xs text-theme-text/50 mt-1">
                              Generada: {c.nv_generation_date_chile}
                            </div>
                          </Label>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2 flex flex-col">
                  <Label>Motivo de la excepción</Label>
                  <select 
                    value={reason} 
                    onChange={e => setReason(e.target.value)} 
                    disabled={isLoading}
                    className="flex h-9 w-full items-center justify-between rounded-md border border-theme-border/50 bg-theme-panel px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <option value="" disabled>Selecciona un motivo</option>
                    {REASON_OPTIONS.map(opt => (
                      <option key={opt} value={opt}>{opt}</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="space-y-2">
                <Label>Observación (Obligatoria)</Label>
                <Textarea 
                  placeholder="Detalla la razón por la cual se autoriza la inclusión..."
                  value={observation}
                  onChange={(e) => setObservation(e.target.value)}
                  className="resize-none h-24 bg-theme-panel border-theme-border/50"
                  disabled={isLoading}
                />
              </div>

              <div className="bg-orange-500/10 text-orange-600 dark:text-orange-400 p-3 rounded-md flex items-start gap-2 text-sm">
                <AlertCircle className="w-5 h-5 shrink-0 mt-0.5" />
                <p>
                  Esta acción registrará tu nombre ({`autorizador`}) y fecha de autorización en el log de auditoría de la ruta.
                </p>
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t border-theme-border/50 flex justify-end gap-3 bg-theme-panel">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancelar
          </Button>
          <Button 
            onClick={handleAuthorize} 
            disabled={!selectedNvId || !reason || !observation.trim() || outOfCutoffCandidates.length === 0 || isLoading}
          >
            {isLoading ? 'Autorizando...' : 'Autorizar e incluir en ruta'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
