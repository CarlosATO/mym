'use client'

import { useState, useEffect } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Loader2, Plus, Edit2, AlertCircle, AlertTriangle, ShieldAlert } from 'lucide-react'
import { getAisleSummary, addRacksToAisle, addLevelsToAisle, addPositionsToAisle, renameAisleIfSafe, deactivateAisle } from '@/app/actions/logistica/aisles'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'

interface AisleManagementModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  warehouseId: string
  aisle: string
  onSuccess: () => void
}

type ActionType = 'menu' | 'add_racks' | 'add_levels' | 'add_positions' | 'rename' | 'deactivate'

export function AisleManagementModal({ open, onOpenChange, warehouseId, aisle, onSuccess }: AisleManagementModalProps) {
  const [summary, setSummary] = useState<any>(null)
  const [loadingSummary, setLoadingSummary] = useState(false)
  const [action, setAction] = useState<ActionType>('menu')
  const [loading, setLoading] = useState(false)

  const [quantity, setQuantity] = useState(1)
  const [newName, setNewName] = useState(aisle)

  useEffect(() => {
    if (open && aisle) {
      setAction('menu')
      setQuantity(1)
      setNewName(aisle)
      loadSummary()
    } else {
      setSummary(null)
    }
  }, [open, aisle])

  async function loadSummary() {
    setLoadingSummary(true)
    try {
      const res = await getAisleSummary(warehouseId, aisle)
      if (res.error) {
        toast.error(res.error)
        onOpenChange(false)
      } else {
        setSummary(res.data)
      }
    } catch (e: any) {
      toast.error('Error al cargar información del pasillo')
    } finally {
      setLoadingSummary(false)
    }
  }

  async function handleExecuteAction() {
    if (!summary) return
    setLoading(true)
    try {
      let res: any

      switch (action) {
        case 'add_racks':
          res = await addRacksToAisle(warehouseId, aisle, quantity)
          break
        case 'add_levels':
          res = await addLevelsToAisle(warehouseId, aisle, quantity)
          break
        case 'add_positions':
          res = await addPositionsToAisle(warehouseId, aisle, quantity)
          break
        case 'rename':
          res = await renameAisleIfSafe(warehouseId, aisle, newName)
          break
        case 'deactivate':
          res = await deactivateAisle(warehouseId, aisle)
          break
      }

      if (res?.error) {
        toast.error(res.error)
      } else {
        const skippedMsg = res.skipped ? ` (${res.skipped} omitidas por duplicado)` : ''
        toast.success(`Operación exitosa${skippedMsg}`)
        onSuccess()
        onOpenChange(false)
      }
    } catch (e: any) {
      toast.error('Error al ejecutar la operación')
    } finally {
      setLoading(false)
    }
  }

  const isRenameBlocked = summary?.hasStock || summary?.hasHistory
  const isDeactivateBlocked = summary?.hasStock

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[425px]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Gestión de Pasillo {aisle}
          </DialogTitle>
          <DialogDescription>
            {action === 'menu' && 'Seleccione una operación a realizar en este pasillo.'}
            {action === 'add_racks' && 'Agregar nuevas columnas (racks) respetando los niveles y ubicaciones existentes.'}
            {action === 'add_levels' && 'Agregar nuevos niveles hacia arriba en todas las columnas existentes.'}
            {action === 'add_positions' && 'Agregar posiciones adicionales (U) por cada nivel existente.'}
            {action === 'rename' && 'Renombrar el identificador físico del pasillo.'}
            {action === 'deactivate' && 'Desactivar lógicamente todas las ubicaciones del pasillo.'}
          </DialogDescription>
        </DialogHeader>

        {loadingSummary ? (
          <div className="flex flex-col items-center justify-center py-8">
            <Loader2 className="w-8 h-8 animate-spin text-theme-accent" />
            <p className="text-sm text-theme-text-muted mt-2">Calculando validaciones...</p>
          </div>
        ) : summary ? (
          <div className="space-y-4">
            {action === 'menu' ? (
              <>
                <div className="bg-theme-surface/50 p-3 rounded-lg border border-theme-border/50 grid grid-cols-2 gap-2 text-sm mb-4">
                  <div><span className="text-theme-text-muted">Total:</span> <span className="font-bold">{summary.totalLocations}</span></div>
                  <div><span className="text-theme-text-muted">Inactivas:</span> <span className="font-bold">{summary.inactiveLocations}</span></div>
                  <div><span className="text-theme-text-muted">Con Stock:</span> <span className="font-bold text-emerald-500">{summary.locationsWithStock}</span></div>
                  <div><span className="text-theme-text-muted">Vacías:</span> <span className="font-bold">{summary.emptyLocations}</span></div>
                  <div className="col-span-2 pt-2 border-t border-theme-border/40 mt-1">
                    <span className="text-theme-text-muted">Historial en Kardex:</span> <span className={cn("font-bold", summary.hasHistory ? "text-amber-500" : "text-theme-text")}>{summary.hasHistory ? 'Sí' : 'No'}</span>
                  </div>
                </div>

                <div className="grid grid-cols-1 gap-2">
                  <Button variant="outline" className="justify-start font-normal" onClick={() => setAction('add_racks')}>
                    <Plus className="w-4 h-4 mr-2 text-theme-accent" /> Agregar Racks (Columnas)
                  </Button>
                  <Button variant="outline" className="justify-start font-normal" onClick={() => setAction('add_levels')}>
                    <Plus className="w-4 h-4 mr-2 text-theme-accent" /> Agregar Niveles
                  </Button>
                  <Button variant="outline" className="justify-start font-normal" onClick={() => setAction('add_positions')}>
                    <Plus className="w-4 h-4 mr-2 text-theme-accent" /> Agregar Posiciones (U)
                  </Button>
                  
                  <div className="h-px bg-theme-border/50 my-1" />
                  
                  <Button variant="outline" className="justify-start font-normal" onClick={() => setAction('rename')}>
                    <Edit2 className="w-4 h-4 mr-2 text-blue-500" /> Renombrar pasillo
                  </Button>
                  
                  <Button variant="outline" className="justify-start font-normal text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/30" onClick={() => setAction('deactivate')}>
                    <AlertCircle className="w-4 h-4 mr-2" /> Desactivar pasillo
                  </Button>
                </div>
              </>
            ) : action === 'add_racks' || action === 'add_levels' || action === 'add_positions' ? (
              <div className="space-y-4 py-2">
                <div>
                  <label className="text-sm font-semibold">Cantidad a agregar</label>
                  <Input 
                    type="number" 
                    min={1} 
                    max={50} 
                    value={quantity} 
                    onChange={e => setQuantity(Number(e.target.value))} 
                    className="mt-1"
                  />
                  <p className="text-xs text-theme-text-muted mt-1">
                    Se respetará la estructura actual y se generarán los nuevos códigos siguiendo el orden natural.
                  </p>
                </div>
              </div>
            ) : action === 'rename' ? (
              <div className="space-y-4 py-2">
                {isRenameBlocked ? (
                  <div className="bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 p-3 rounded-lg flex gap-3 text-sm border border-amber-200 dark:border-amber-800">
                    <ShieldAlert className="w-5 h-5 shrink-0" />
                    <div>
                      <strong>Operación bloqueada.</strong><br/>
                      Este pasillo tiene historial o stock asociado. Para mantener la trazabilidad en Kardex, el código físico no puede ser modificado. Recomendamos crear un nuevo pasillo y desactivar este cuando quede sin stock.
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="text-sm font-semibold">Nuevo código de pasillo</label>
                    <Input 
                      value={newName} 
                      onChange={e => setNewName(e.target.value)} 
                      className="mt-1"
                      placeholder="Ej: B"
                    />
                  </div>
                )}
              </div>
            ) : action === 'deactivate' ? (
              <div className="space-y-4 py-2">
                {isDeactivateBlocked ? (
                  <div className="bg-red-50 dark:bg-red-950/30 text-red-800 dark:text-red-200 p-3 rounded-lg flex gap-3 text-sm border border-red-200 dark:border-red-800">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    <div>
                      <strong>Operación bloqueada.</strong><br/>
                      No se puede desactivar este pasillo porque tiene {summary.locationsWithStock} ubicaciones con stock activo. Debe vaciarlo primero mediante movimientos o traspasos.
                    </div>
                  </div>
                ) : (
                  <div className="bg-amber-50 dark:bg-amber-950/30 text-amber-800 dark:text-amber-200 p-3 rounded-lg flex gap-3 text-sm border border-amber-200 dark:border-amber-800">
                    <AlertTriangle className="w-5 h-5 shrink-0" />
                    <div>
                      ¿Está seguro que desea desactivar todas las ubicaciones de este pasillo? El historial de movimientos seguirá disponible, pero las ubicaciones ya no podrán recibir stock.
                    </div>
                  </div>
                )}
              </div>
            ) : null}
          </div>
        ) : null}

        <DialogFooter className="mt-4">
          {action !== 'menu' && (
            <Button variant="ghost" onClick={() => setAction('menu')} disabled={loading}>
              Volver
            </Button>
          )}
          {action === 'menu' ? (
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cerrar
            </Button>
          ) : (
            <Button 
              disabled={loading || (action === 'rename' && isRenameBlocked) || (action === 'deactivate' && isDeactivateBlocked)}
              onClick={handleExecuteAction}
              variant={action === 'deactivate' ? 'destructive' : 'default'}
              className="min-w-[120px]"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Confirmar'}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
