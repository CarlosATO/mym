'use client'

import { useState, useEffect, useCallback } from 'react'
import { getPendingReceivablePOs, getPurchaseOrderForReceipt, createPurchaseReceipt } from '@/app/actions/logistica/recepciones'
import { getLocations, type Location } from '@/app/actions/logistica/locations'
import { getWarehouses, type Warehouse } from '@/app/actions/adquisiciones/warehouses'
import { ArrowLeft, Search, Check, AlertCircle } from 'lucide-react'

export function RecepcionesPanel() {
  const [pos, setPos] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [msg, setMsg] = useState('')
  
  // Modal states
  const [selectedPoId, setSelectedPoId] = useState<string | null>(null)
  const [poDetail, setPoDetail] = useState<any | null>(null)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [locations, setLocations] = useState<Location[]>([])
  const [receivingType, setReceivingType] = useState<'WAREHOUSE' | 'OFFICE'>('WAREHOUSE')
  const [mainWarehouseId, setMainWarehouseId] = useState('')
  const [generalNotes, setGeneralNotes] = useState('')
  const [itemInputs, setItemInputs] = useState<Record<string, {
    quantity_received: number
    location_id: string
    lot_number: string
    expiration_date: string
    notes: string
    conforms?: boolean
  }>>({})

  const loadPOs = useCallback(async () => {
    setLoading(true)
    const list = await getPendingReceivablePOs()
    setPos(list)
    setLoading(false)
  }, [])

  useEffect(() => {
    loadPOs()
  }, [loadPOs])

  function showMsg(text: string) {
    setMsg(text)
    setTimeout(() => setMsg(''), 3500)
  }

  async function handleOpenReceipt(poId: string) {
    setSelectedPoId(poId)
    setLoadingDetail(true)
    setPoDetail(null)
    
    const [detail, locsRes] = await Promise.all([
      getPurchaseOrderForReceipt(poId),
      getLocations({ pageSize: 10000 })
    ])

    if (!detail) {
      showMsg('No se pudo cargar la información de la Orden de Compra')
      setSelectedPoId(null)
      setLoadingDetail(false)
      return
    }

    setPoDetail(detail)
    setLocations(locsRes.data.filter(l => l.is_active))
    
    // Set default receiving warehouse
    const poWarehouse = detail.po.warehouse_id || ''
    setMainWarehouseId(poWarehouse)

    // Initialize inputs
    const initialInputs: typeof itemInputs = {}
    detail.items.forEach(item => {
      // Find a default location for this warehouse if available
      const whLocs = locsRes.data.filter(l => l.is_active && l.warehouse_id === (item.warehouse_id || poWarehouse))
      const defaultLocId = whLocs.length > 0 ? whLocs[0].id : ''

      initialInputs[item.id] = {
        quantity_received: item.item_type === 'PRODUCT' ? Number(item.quantity_pending) : 0,
        location_id: defaultLocId,
        lot_number: '',
        expiration_date: '',
        notes: '',
        conforms: item.item_type === 'SERVICE' ? true : undefined
      }
    })
    setItemInputs(initialInputs)
    setReceivingType(detail.po.po_type === 'SERVICIOS' ? 'OFFICE' : 'WAREHOUSE')
    setGeneralNotes('')
    setLoadingDetail(false)
  }

  function handleItemInputChange(itemId: string, field: string, value: any) {
    setItemInputs(prev => ({
      ...prev,
      [itemId]: {
        ...prev[itemId],
        [field]: value
      }
    }))
  }

  async function handleSaveReceipt() {
    if (!poDetail) return

    // Validations
    if (receivingType === 'WAREHOUSE' && !mainWarehouseId) {
      alert('Debe seleccionar una bodega de recepción')
      return
    }

    // Validate locations
    if (receivingType === 'WAREHOUSE') {
      for (const item of poDetail.items) {
        if (item.item_type === 'PRODUCT') {
          const inputs = itemInputs[item.id]
          if (inputs && Number(inputs.quantity_received) > 0) {
            const itemWh = item.warehouse_id || mainWarehouseId
            const whLocs = locations.filter(l => l.warehouse_id === itemWh)
            
            if (whLocs.length > 0 && !inputs.location_id) {
              alert(`Debe seleccionar una ubicación para el producto "${item.product_description}".`)
              return
            }

            if (inputs.location_id) {
              // Verify it belongs to the target warehouse
              const locObj = locations.find(l => l.id === inputs.location_id)
              if (!locObj || locObj.warehouse_id !== itemWh) {
                alert(`La ubicación seleccionada para el producto "${item.product_description}" no pertenece a la bodega correcta.`)
                return
              }
            }
          }
        }
      }
    }

    const payloadItems = poDetail.items.map((item: any) => {
      const inputs = itemInputs[item.id]
      if (item.item_type === 'PRODUCT') {
        return {
          purchase_order_item_id: item.id,
          quantity_received: Number(inputs.quantity_received || 0),
          location_id: receivingType === 'WAREHOUSE' ? inputs.location_id || null : null,
          lot_number: inputs.lot_number || null,
          expiration_date: inputs.expiration_date || null,
          notes: inputs.notes || null
        }
      } else {
        // Services receive the entire pending quantity if marked conforms
        const conforms = !!inputs.conforms
        return {
          purchase_order_item_id: item.id,
          quantity_received: conforms ? Number(item.quantity_pending) : 0,
          notes: inputs.notes || null
        }
      }
    })

    // Check if at least one item is being received
    const hasReceivingItems = payloadItems.some((it: any) => it.quantity_received > 0)
    if (!hasReceivingItems) {
      alert('Debe ingresar una cantidad a recibir mayor a cero para al menos un ítem o marcar conformidad de servicio.')
      return
    }

    // Verify service comments are filled if conforms is false/true depending on strictness
    const serviceItems = poDetail.items.filter((i: any) => i.item_type === 'SERVICE')
    for (const item of serviceItems) {
      const inputs = itemInputs[item.id]
      if (inputs.conforms && !inputs.notes.trim()) {
        alert(`Para el servicio "${item.product_description}" se recomienda ingresar una observación de conformidad.`)
      }
    }

    // Call server action
    const res = await createPurchaseReceipt({
      purchase_order_id: poDetail.po.id,
      receiving_type: receivingType,
      warehouse_id: receivingType === 'WAREHOUSE' ? mainWarehouseId : null,
      notes: generalNotes,
      items: payloadItems
    })

    if (res.error) {
      alert(`Error al registrar recepción: ${res.error}`)
      return
    }

    showMsg(`Recepción ${res.receipt_number} guardada exitosamente.`)
    setSelectedPoId(null)
    setPoDetail(null)
    loadPOs()
  }

  // Client side filtering for PO list
  const filteredPOs = pos.filter(po => 
    po.correlative.toLowerCase().includes(search.toLowerCase()) ||
    po.supplier_name.toLowerCase().includes(search.toLowerCase()) ||
    (po.warehouse_name && po.warehouse_name.toLowerCase().includes(search.toLowerCase()))
  )

  const statusLabel = (s: string) => {
    const map: Record<string, string> = {
      EMITIDA: 'Emitida',
      RECEPCION_PARCIAL: 'Recep. Parcial',
      RECEPCION_TOTAL: 'Recep. Total'
    }
    return map[s] || s
  }

  return (
    <div className="space-y-4 animate-in fade-in duration-200">
      {msg && (
        <div className="bg-theme-accent-hover/10 border border-theme-accent/20 rounded-xl px-4 py-2.5 text-sm text-theme-text-accent">
          {msg}
        </div>
      )}

      <div className="relative w-full">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-theme-text-muted/50" />
        <input 
          type="text" 
          value={search} 
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar por correlativo OC o proveedor..."
          className="w-full h-11 pl-10 pr-4 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 focus:bg-theme-surface focus:ring-2 focus:ring-theme-accent/20 focus:border-theme-accent transition-all text-sm text-theme-text placeholder:text-theme-text-muted/40" 
        />
      </div>

      {loading ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">Cargando...</p>
        </div>
      ) : pos.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No hay Órdenes de Compra pendientes de recepción.</p>
        </div>
      ) : filteredPOs.length === 0 ? (
        <div className="rounded-2xl border border-theme-border bg-theme-text/5 p-10 text-center">
          <p className="text-theme-text-muted/50 text-sm">No se encontraron resultados para la búsqueda.</p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-theme-border bg-theme-text/5">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider">
                <th className="text-left py-3 px-4 font-medium">N° OC</th>
                <th className="text-left py-3 px-4 font-medium">Fecha Emisión</th>
                <th className="text-left py-3 px-4 font-medium">Proveedor</th>
                <th className="text-left py-3 px-4 font-medium">Bodega Destino</th>
                <th className="text-left py-3 px-4 font-medium">Tipo OC</th>
                <th className="text-right py-3 px-4 font-medium">Total</th>
                <th className="text-left py-3 px-4 font-medium">Estado Recepción</th>
                <th className="text-right py-3 px-4 font-medium">Acción</th>
              </tr>
            </thead>
            <tbody>
              {filteredPOs.map(po => (
                <tr key={po.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                  <td className="py-3 px-4 text-xs font-mono font-semibold text-theme-text-accent">{po.correlative}</td>
                  <td className="py-3 px-4 text-xs text-theme-text">{new Date(po.issue_date).toLocaleDateString('es-CL')}</td>
                  <td className="py-3 px-4 text-xs text-theme-text">{po.supplier_name}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted">{po.warehouse_name || '—'}</td>
                  <td className="py-3 px-4 text-xs text-theme-text-muted">{po.po_type}</td>
                  <td className="py-3 px-4 text-xs text-right text-theme-text font-semibold">
                    {po.grand_total.toLocaleString('es-CL', { style: 'currency', currency: 'CLP', minimumFractionDigits: 0 })}
                  </td>
                  <td className="py-3 px-4">
                    {po.status === 'RECEPCION_PARCIAL' ? (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-amber-500/10 text-amber-500 border-amber-500/20">
                        {statusLabel(po.status)}
                      </span>
                    ) : (
                      <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-blue-500/10 text-blue-500 border-blue-500/20">
                        Pendiente
                      </span>
                    )}
                  </td>
                  <td className="py-3 px-4 text-right">
                    <button 
                      onClick={() => handleOpenReceipt(po.id)} 
                      className="px-3.5 py-1.5 rounded-lg bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-md"
                    >
                      Recibir
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* FULL SCREEN MODAL */}
      {selectedPoId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
          <div className="w-[95vw] h-[95vh] bg-theme-surface rounded-2xl border border-theme-border shadow-2xl flex flex-col overflow-hidden animate-in zoom-in-95 duration-200">
            {loadingDetail || !poDetail ? (
              <div className="flex-1 flex flex-col items-center justify-center space-y-4">
                <div className="w-8 h-8 animate-spin border-4 border-theme-accent border-t-transparent rounded-full" />
                <p className="text-xs text-theme-text-muted">Cargando detalles de la orden...</p>
              </div>
            ) : (
              <>
                {/* Header */}
                <div className="flex items-center justify-between px-6 py-4 border-b border-theme-border bg-theme-text/5 shrink-0">
                  <div className="flex items-center gap-3">
                    <h2 className="text-base font-bold text-theme-text">Registrar Recepción para OC {poDetail.po.correlative}</h2>
                    <span className="text-[11px] font-semibold px-2 py-0.5 rounded border bg-theme-accent-hover/10 text-theme-text-accent border-theme-accent/20">
                      {poDetail.po.po_type}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <button 
                      onClick={handleSaveReceipt} 
                      className="px-5 py-2 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-colors shadow-lg shadow-theme-accent/20"
                    >
                      Confirmar recepción
                    </button>
                    <button 
                      onClick={() => { setSelectedPoId(null); setPoDetail(null) }} 
                      className="px-4 py-2 rounded-xl border border-theme-border text-theme-text-muted hover:text-theme-text hover:bg-theme-text/10 text-xs font-semibold transition-colors"
                    >
                      Cerrar
                    </button>
                  </div>
                </div>

                {/* Content */}
                <div className="flex-1 overflow-y-auto p-6 space-y-6">
                  {/* Summary Box */}
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-4 p-4 rounded-xl border border-theme-border bg-theme-text/5 text-xs">
                    <div>
                      <p className="text-theme-text-muted/60 mb-0.5">Proveedor</p>
                      <p className="font-semibold text-theme-text">{poDetail.po.supplier_name}</p>
                      {poDetail.po.supplier_rut && <p className="text-[10px] text-theme-text-muted">{poDetail.po.supplier_rut}</p>}
                    </div>
                    <div>
                      <p className="text-theme-text-muted/60 mb-0.5">Bodega Destino Original</p>
                      <p className="font-semibold text-theme-text">{poDetail.po.warehouse_name || 'Sin bodega predeterminada'}</p>
                    </div>
                    <div>
                      <p className="text-theme-text-muted/60 mb-0.5">Tipo de Recepción</p>
                      <select 
                        value={receivingType} 
                        onChange={e => setReceivingType(e.target.value as any)}
                        disabled={poDetail.po.po_type === 'SERVICIOS'}
                        className="mt-1 h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none w-full"
                      >
                        <option value="WAREHOUSE" className="bg-white dark:bg-theme-surface">Física (Bodega)</option>
                        <option value="OFFICE" className="bg-white dark:bg-theme-surface">Administrativa (Oficina)</option>
                      </select>
                    </div>
                    <div>
                      <p className="text-theme-text-muted/60 mb-0.5">Almacén de Recepción</p>
                      <select 
                        value={mainWarehouseId} 
                        onChange={e => setMainWarehouseId(e.target.value)}
                        disabled={receivingType === 'OFFICE'}
                        className="mt-1 h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none w-full disabled:opacity-50"
                      >
                        <option value="" className="bg-white dark:bg-theme-surface">Seleccionar bodega...</option>
                        {poDetail.po.warehouse_id && (
                          <option value={poDetail.po.warehouse_id} className="bg-white dark:bg-theme-surface">
                            {poDetail.po.warehouse_name} (Origen)
                          </option>
                        )}
                        {/* Optionally populate other warehouses */}
                      </select>
                    </div>
                  </div>

                  {/* General Notes */}
                  <div className="space-y-1">
                    <label className="text-xs text-theme-text-muted/60">Observaciones Generales de Recepción</label>
                    <textarea 
                      value={generalNotes}
                      onChange={e => setGeneralNotes(e.target.value)}
                      rows={2}
                      placeholder="Ingrese comentarios sobre esta recepción..."
                      className="w-full rounded-xl border border-theme-border bg-theme-surface px-3 py-2 text-xs text-theme-text focus:outline-none resize-none"
                    />
                  </div>

                  {/* Items list */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider">Líneas a Recepcionar</h3>
                    
                    <div className="overflow-x-auto rounded-xl border border-theme-border">
                      <table className="w-full text-sm">
                        <thead>
                          <tr className="border-b border-theme-border text-xs text-theme-text-muted/70 uppercase tracking-wider bg-theme-text/5">
                            <th className="py-2.5 px-3 text-left w-10">#</th>
                            <th className="py-2.5 px-3 text-left">Producto / Servicio</th>
                            <th className="py-2.5 px-3 text-center w-20">Tipo</th>
                            <th className="py-2.5 px-3 text-right w-24">Solicitado</th>
                            <th className="py-2.5 px-3 text-right w-24">Ya Recibido</th>
                            <th className="py-2.5 px-3 text-right w-24">Pendiente</th>
                            <th className="py-2.5 px-3 text-center w-36">Cant. a Recibir</th>
                            {receivingType === 'WAREHOUSE' && (
                              <>
                                <th className="py-2.5 px-3 text-left w-44">Ubicación</th>
                                <th className="py-2.5 px-3 text-left w-36">Lote / Vencimiento</th>
                              </>
                            )}
                            <th className="py-2.5 px-3 text-left">Observación Línea</th>
                          </tr>
                        </thead>
                        <tbody>
                          {poDetail.items.map((item: any, idx: number) => {
                            const inputs = itemInputs[item.id] || {
                              quantity_received: 0,
                              location_id: '',
                              lot_number: '',
                              expiration_date: '',
                              notes: '',
                              conforms: false
                            }

                            // Filter locations belonging to the current item's warehouse (or fallback to main receiver warehouse)
                            const itemWh = item.warehouse_id || mainWarehouseId
                            const whLocs = locations.filter(l => l.warehouse_id === itemWh)

                            return (
                              <tr key={item.id} className="border-b border-theme-border hover:bg-theme-text/5 transition-colors">
                                <td className="py-2.5 px-3 text-xs text-theme-text-muted/60">{idx + 1}</td>
                                <td className="py-2.5 px-3">
                                  <p className="text-xs font-semibold text-theme-text">{item.product_description}</p>
                                  {item.product_id && <p className="text-[10px] text-theme-text-muted">ID: {item.product_id}</p>}
                                </td>
                                <td className="py-2.5 px-3 text-center">
                                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded border bg-theme-text/5 text-theme-text-muted border-theme-border">
                                    {item.item_type === 'PRODUCT' ? 'Producto' : 'Servicio'}
                                  </span>
                                </td>
                                <td className="py-2.5 px-3 text-xs text-right font-medium text-theme-text">{item.quantity}</td>
                                <td className="py-2.5 px-3 text-xs text-right text-emerald-500 font-semibold">{item.quantity_received}</td>
                                <td className="py-2.5 px-3 text-xs text-right text-theme-text-accent font-semibold">{item.quantity_pending}</td>
                                <td className="py-2.5 px-3 text-center">
                                  {item.item_type === 'PRODUCT' ? (
                                    <input 
                                      type="number"
                                      min="0"
                                      max={item.quantity_pending}
                                      step="0.001"
                                      value={inputs.quantity_received}
                                      onChange={e => {
                                        const val = Math.min(Number(item.quantity_pending), Math.max(0, parseFloat(e.target.value) || 0))
                                        handleItemInputChange(item.id, 'quantity_received', val)
                                      }}
                                      className="w-24 h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text text-right"
                                    />
                                  ) : (
                                    <label className="flex items-center justify-center gap-1.5 cursor-pointer">
                                      <input 
                                        type="checkbox"
                                        checked={!!inputs.conforms}
                                        onChange={e => handleItemInputChange(item.id, 'conforms', e.target.checked)}
                                        className="accent-theme-accent"
                                      />
                                      <span className="text-xs text-theme-text">Conforme</span>
                                    </label>
                                  )}
                                </td>
                                {receivingType === 'WAREHOUSE' && (
                                  <>
                                    <td className="py-2.5 px-3">
                                      {item.item_type === 'PRODUCT' ? (
                                        whLocs.length > 0 ? (
                                          <select 
                                            value={inputs.location_id}
                                            onChange={e => handleItemInputChange(item.id, 'location_id', e.target.value)}
                                            className="w-full h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text focus:outline-none focus:ring-1 focus:ring-theme-accent/30"
                                          >
                                            <option value="">Seleccionar ubicación...</option>
                                            {whLocs.map(l => (
                                              <option key={l.id} value={l.id}>{l.code}</option>
                                            ))}
                                          </select>
                                        ) : (
                                          <p className="text-[10px] text-red-500 font-semibold leading-tight bg-red-500/5 border border-red-500/10 rounded p-1.5 animate-pulse">
                                            No hay ubicaciones para esta bodega. Cree ubicaciones en Logística &gt; Ubicaciones.
                                          </p>
                                        )
                                      ) : (
                                        <span className="text-xs text-theme-text-muted/40">—</span>
                                      )}
                                    </td>
                                    <td className="py-2.5 px-3 space-y-1">
                                      {item.item_type === 'PRODUCT' ? (
                                        <>
                                          <input 
                                            type="text"
                                            value={inputs.lot_number}
                                            onChange={e => handleItemInputChange(item.id, 'lot_number', e.target.value)}
                                            placeholder="Lote"
                                            className="w-full h-7 rounded-lg border border-theme-border bg-theme-surface px-2 text-[11px] text-theme-text"
                                          />
                                          <input 
                                            type="date"
                                            value={inputs.expiration_date}
                                            onChange={e => handleItemInputChange(item.id, 'expiration_date', e.target.value)}
                                            className="w-full h-7 rounded-lg border border-theme-border bg-theme-surface px-2 text-[11px] text-theme-text"
                                          />
                                        </>
                                      ) : (
                                        <span className="text-xs text-theme-text-muted/40">—</span>
                                      )}
                                    </td>
                                  </>
                                )}
                                <td className="py-2.5 px-3">
                                  <input 
                                    type="text"
                                    value={inputs.notes}
                                    onChange={e => handleItemInputChange(item.id, 'notes', e.target.value)}
                                    placeholder={item.item_type === 'SERVICE' ? 'Motivo de conformidad/observación *' : 'Notas de la línea'}
                                    className="w-full h-8 rounded-lg border border-theme-border bg-theme-surface px-2 text-xs text-theme-text"
                                  />
                                </td>
                              </tr>
                            )
                          })}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
