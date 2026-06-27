'use client'

import React, { useState, useEffect, Fragment } from 'react'
import { useRouter } from 'next/navigation'
import { getPurchaseOrderForReceipt, createPurchaseReceipt } from '@/app/actions/logistica/recepciones'
import { getLocations, type Location } from '@/app/actions/logistica/locations'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import * as LucideIcons from 'lucide-react'
import { erpInputClass, erpSelectClass } from '@/lib/form-styles'
import { cn } from '@/lib/utils'

interface ReceiptWorksheetProps {
  poId: string
  profile: { nombre: string; apellido: string; email: string; roles: { name: string } }
}

interface ItemSplit {
  id: string
  quantity: number
  location_id: string
  lot_number: string
  expiration_date: string
  notes: string
}

export function ReceiptWorksheet({ poId, profile }: ReceiptWorksheetProps) {
  const router = useRouter()
  const [poDetail, setPoDetail] = useState<any | null>(null)
  const [loading, setLoading] = useState(true)
  const [locations, setLocations] = useState<Location[]>([])
  const [receivingType, setReceivingType] = useState<'WAREHOUSE' | 'OFFICE'>('WAREHOUSE')
  const [mainWarehouseId, setMainWarehouseId] = useState('')
  const [generalNotes, setGeneralNotes] = useState('')
  
  // Document metadata state
  const [documentType, setDocumentType] = useState<string>('GD')
  const [documentNumber, setDocumentNumber] = useState<string>('')
  const [documentDate, setDocumentDate] = useState<string>(new Date().toISOString().substring(0, 10))
  const [documentNotes, setDocumentNotes] = useState<string>('')

  // Attachment state
  const [uploadingFile, setUploadingFile] = useState(false)
  const [attachment, setAttachment] = useState<{
    file_url?: string | null
    storage_bucket: string
    storage_path: string
    file_name: string
    file_size: number
    mime_type: string
    notes?: string
  } | null>(null)

  const [saving, setSaving] = useState(false)

  // itemInputs state maps itemId -> Array of ItemSplit
  const [itemInputs, setItemInputs] = useState<Record<string, ItemSplit[]>>({})

  useEffect(() => {
    async function loadData() {
      try {
        setLoading(true)
        const [detail, locsRes] = await Promise.all([
          getPurchaseOrderForReceipt(poId),
          getLocations({ pageSize: 10000 })
        ])

        if (!detail) {
          toast.error('No se pudo cargar la información de la Orden de Compra.')
          router.push('/dashboard/logistica')
          return
        }

        setPoDetail(detail)
        const activeLocations = locsRes.data.filter(l => l.is_active)
        setLocations(activeLocations)
        
        // Set default receiving warehouse
        const poWarehouse = detail.po.warehouse_id || ''
        setMainWarehouseId(poWarehouse)

        // Initialize inputs with one split per line item
        const initialInputs: Record<string, ItemSplit[]> = {}
        detail.items.forEach((item: any) => {
          const itemWh = item.warehouse_id || poWarehouse
          const whLocs = activeLocations.filter(l => l.warehouse_id === itemWh)
          const defaultLocId = whLocs.length > 0 ? whLocs[0].id : ''

          initialInputs[item.id] = [
            {
              id: `split-${Date.now()}-${Math.random()}`,
              quantity: item.item_type === 'PRODUCT' ? Number(item.quantity_pending) : 1,
              location_id: defaultLocId,
              lot_number: '',
              expiration_date: '',
              notes: ''
            }
          ]
        })
        setItemInputs(initialInputs)
        setReceivingType(detail.po.po_type === 'SERVICIOS' ? 'OFFICE' : 'WAREHOUSE')
      } catch (err) {
        console.error('Error loading PO for receipt:', err)
        toast.error('Ocurrió un error al cargar los datos.')
      } finally {
        setLoading(false)
      }
    }
    loadData()
  }, [poId, router])

  // Split control handlers
  function addSplit(itemId: string) {
    const poWarehouse = poDetail?.po.warehouse_id || ''
    const item = poDetail?.items.find((it: any) => it.id === itemId)
    const itemWh = item?.warehouse_id || poWarehouse
    const whLocs = locations.filter(l => l.warehouse_id === itemWh)
    const defaultLocId = whLocs.length > 0 ? whLocs[0].id : ''

    const newSplit: ItemSplit = {
      id: `split-${Date.now()}-${Math.random()}`,
      quantity: 0,
      location_id: defaultLocId,
      lot_number: '',
      expiration_date: '',
      notes: ''
    }

    setItemInputs(prev => ({
      ...prev,
      [itemId]: [...(prev[itemId] || []), newSplit]
    }))
  }

  function removeSplit(itemId: string, splitId: string) {
    setItemInputs(prev => {
      const current = prev[itemId] || []
      if (current.length <= 1) return prev // Keep at least one
      return {
        ...prev,
        [itemId]: current.filter(s => s.id !== splitId)
      }
    })
  }

  function updateSplitField(itemId: string, splitId: string, field: keyof ItemSplit, value: any) {
    setItemInputs(prev => {
      const current = prev[itemId] || []
      const updated = current.map(s => {
        if (s.id === splitId) {
          return { ...s, [field]: value }
        }
        return s
      })
      return {
        ...prev,
        [itemId]: updated
      }
    })
  }

  // Handle document file upload to Supabase Storage
  async function handleFileUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return

    const companyId = poDetail?.po.company_id
    if (!companyId) {
      toast.error('No se ha encontrado el ID de la empresa activa.')
      return
    }

    // Enforce 20MB limit
    if (file.size > 20971520) {
      toast.error('El archivo supera el límite permitido de 20 MB.')
      return
    }

    // Validate MIME types
    const allowedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
    if (!allowedMimes.includes(file.type)) {
      toast.error('Tipo de archivo no permitido. Solo se aceptan PDFs, PNG, JPEG y WebP.')
      return
    }

    try {
      setUploadingFile(true)
      const supabase = createClient()
      
      const safeName = file.name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "")
        .replace(/[^a-zA-Z0-9.-]/g, "_")

      const filePath = `${companyId}/purchase-receipts/${poId}/${Date.now()}-${safeName}`

      const { error } = await supabase.storage
        .from('recepciones')
        .upload(filePath, file, {
          cacheControl: '3600',
          upsert: false
        })

      if (error) throw error

      // Get public URL just as fallback or metadata reference
      const { data: { publicUrl } } = supabase.storage
        .from('recepciones')
        .getPublicUrl(filePath)

      setAttachment({
        file_url: null, // Don't expose public URL as it's a private bucket
        storage_bucket: 'recepciones',
        storage_path: filePath,
        file_name: file.name,
        file_size: file.size,
        mime_type: file.type,
        notes: documentNotes
      })
      toast.success('Documento subido correctamente.')
    } catch (err: any) {
      console.error('Error uploading file:', err)
      toast.error(`Error al subir archivo: ${err.message || err}`)
    } finally {
      setUploadingFile(false)
    }
  }

  // Financial calculations
  let netTotal = 0
  if (poDetail) {
    Object.entries(itemInputs).forEach(([itemId, splits]) => {
      const poItem = poDetail.items.find((it: any) => it.id === itemId)
      if (!poItem) return
      const price = Number(poItem.unit_price || 0)
      splits.forEach(split => {
        netTotal += Number(split.quantity || 0) * price
      })
    })
  }
  const taxTotal = netTotal * 0.19
  const grossTotal = netTotal + taxTotal

  // Main saving logic
  async function handleSaveReceipt() {
    if (!poDetail || saving) return

    // Prevent double submission if PO is already received
    if (poDetail.po.receipt_status === 'RECEPCION_TOTAL' || poDetail.po.status === 'RECEPCION_TOTAL') {
      toast.error('Esta Orden de Compra ya fue recepcionada en su totalidad.')
      return
    }

    // Global location validation
    if (receivingType === 'WAREHOUSE' && !mainWarehouseId) {
      toast.error('Debe seleccionar una bodega de recepción global o en las líneas')
      return
    }

    // Prepare payload items
    const payloadItems: any[] = []
    let hasReceivingActivity = false

    for (const item of poDetail.items) {
      const splits = itemInputs[item.id] || []
      const itemWh = item.warehouse_id || mainWarehouseId

      // Validate quantities sum for this item
      let sumQty = 0
      splits.forEach(s => {
        sumQty += Number(s.quantity || 0)
      })

      const qtyPending = Number(item.quantity_pending || 0)
      if (sumQty > qtyPending) {
        toast.error(`La suma total de cantidades ingresadas para el producto "${item.product_description}" (${sumQty}) supera la cantidad pendiente (${qtyPending}).`)
        return
      }

      // Check each split configuration
      for (const split of splits) {
        const qty = Number(split.quantity || 0)
        if (qty <= 0) continue // Skip empty splits

        hasReceivingActivity = true

        // CONFORME enter stock, require location if WAREHOUSE
        if (receivingType === 'WAREHOUSE' && item.item_type === 'PRODUCT') {
          if (!split.location_id) {
            toast.error(`Debe seleccionar una ubicación para el producto "${item.product_description}".`)
            return
          }
          // Validate location matches warehouse
          const locObj = locations.find(l => l.id === split.location_id)
          if (!locObj || locObj.warehouse_id !== itemWh) {
            toast.error(`La ubicación seleccionada para el producto "${item.product_description}" no pertenece a la bodega correspondiente.`)
            return
          }
        }

        payloadItems.push({
          purchase_order_item_id: item.id,
          quantity_received: qty,
          quantity_rejected: 0,
          quantity_missing: 0,
          location_id: receivingType === 'WAREHOUSE' ? split.location_id : null,
          lot_number: item.item_type === 'PRODUCT' ? split.lot_number || null : null,
          expiration_date: item.item_type === 'PRODUCT' ? split.expiration_date || null : null,
          condition: 'CONFORME',
          notes: split.notes || null,
          rejection_reason: null,
          difference_reason: null
        })
      }
    }

    if (!hasReceivingActivity) {
      toast.error('Debe ingresar al menos una cantidad mayor a cero en algún ítem/partida para procesar la recepción.')
      return
    }

    try {
      setSaving(true)
      const payload = {
        purchase_order_id: poDetail.po.id,
        receiving_type: receivingType,
        warehouse_id: receivingType === 'WAREHOUSE' ? mainWarehouseId : null,
        notes: generalNotes,
        document_type: documentType,
        document_number: documentNumber || null,
        document_date: documentDate || null,
        items: payloadItems,
        attachment: attachment ? {
          ...attachment,
          notes: documentNotes || attachment.notes || ''
        } : null
      }
      const res = await createPurchaseReceipt(payload)
      
      if (res.error) {
        toast.error(`Error al registrar recepción: ${res.error}`)
        return
      }

      toast.success(`Recepción ${res.receipt_number} guardada exitosamente.`)
      
      sessionStorage.setItem('mym_receipt_success', JSON.stringify({
        poId: poDetail.po.id,
        receiptNumber: res.receipt_number,
        timestamp: Date.now()
      }))

      window.location.assign('/dashboard/logistica?tab=movimientos&action=recepciones')
    } catch (err) {
      console.error('Error confirming receipt:', err)
      toast.error('Error de red o comunicación al guardar la recepción.')
    } finally {
      setSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="min-h-[400px] flex flex-col items-center justify-center space-y-4">
        <LucideIcons.Loader2 className="w-8 h-8 animate-spin text-theme-accent" />
        <p className="text-xs text-theme-text-muted">Cargando detalles de la orden...</p>
      </div>
    )
  }

  if (!poDetail) return null

  return (
    <div className="w-full max-w-7xl mx-auto space-y-6 px-4 py-4 animate-in fade-in duration-200">
      {/* Top action header bar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-theme-border/60">
        <div className="flex items-center gap-3">
          <button 
            onClick={() => router.push('/dashboard/logistica')}
            className="p-2.5 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-theme-text transition-colors"
            title="Volver a recepciones"
          >
            <LucideIcons.ArrowLeft className="w-4 h-4 text-theme-accent" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-theme-text flex items-center gap-2">
              Registrar Recepción <span className="text-theme-accent">{poDetail.po.correlative}</span>
            </h1>
            <p className="text-xs text-theme-text-muted mt-0.5">Bodeguero responsable: {profile.nombre} {profile.apellido}</p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button 
            onClick={() => router.push('/dashboard/logistica')}
            className="px-4 py-2.5 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-xs font-semibold text-theme-text transition-all"
          >
            Cancelar
          </button>
          <button 
            onClick={handleSaveReceipt} 
            disabled={saving}
            className="flex items-center gap-1.5 px-6 py-2.5 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20 disabled:opacity-50"
          >
            {saving ? (
              <LucideIcons.Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <LucideIcons.CheckCircle2 className="w-3.5 h-3.5" />
            )}
            <span>{saving ? 'Registrando recepción...' : 'Registrar Recepción'}</span>
          </button>
        </div>
      </div>

      {/* Rules and banner instruction alert */}
      <div className="p-4 rounded-xl border border-emerald-500/20 bg-emerald-500/5 text-xs text-theme-text flex items-start gap-3">
        <LucideIcons.Info className="w-4 h-4 text-emerald-500 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <p className="font-bold text-emerald-600 dark:text-emerald-400">Reglas Operacionales de Recepción:</p>
          <ul className="list-disc list-inside space-y-0.5 text-theme-text-muted">
            <li>El bodeguero debe revisar e inspeccionar físicamente la mercadería antes de registrar el ingreso.</li>
            <li>Todo lo que ingrese como cantidad recibida entra automáticamente al stock y Kardex de la bodega/ubicación.</li>
            <li>Si un producto viene dañado o no aceptado, <strong className="text-theme-text">NO se debe recibir</strong>. Ingresar sólo la cantidad aceptada.</li>
            <li>Puede dejar observaciones por producto indicando daños u otras novedades si es necesario.</li>
          </ul>
        </div>
      </div>

      {/* Metadata layout grid: Supplier and documents */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        
        {/* Left side: Supplier / PO info */}
        <div className="lg:col-span-1 p-5 rounded-2xl border border-theme-border bg-theme-surface/50 space-y-4 text-xs">
          <h3 className="font-bold text-theme-text uppercase tracking-wider text-[11px] border-b border-theme-border/60 pb-2 flex items-center gap-1.5">
            <LucideIcons.FileText className="w-3.5 h-3.5 text-theme-accent" />
            Información del Proveedor
          </h3>
          
          <div className="space-y-2.5">
            <div>
              <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Proveedor</span>
              <p className="font-bold text-sm text-theme-text mt-0.5">{poDetail.po.supplier_name}</p>
              {poDetail.po.supplier_rut && <p className="text-[10px] text-theme-text-muted mt-0.5">{poDetail.po.supplier_rut}</p>}
            </div>
            
            {poDetail.po.supplier_address && (
              <div>
                <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Dirección</span>
                <p className="font-medium text-theme-text mt-0.5">{poDetail.po.supplier_address}</p>
              </div>
            )}

            <div className="grid grid-cols-2 gap-2 pt-1">
              <div>
                <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Contacto</span>
                <p className="font-medium text-theme-text mt-0.5">{poDetail.po.supplier_contact || 'No registra'}</p>
              </div>
              <div>
                <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Teléfono</span>
                <p className="font-medium text-theme-text mt-0.5">{poDetail.po.supplier_phone || 'No registra'}</p>
              </div>
            </div>

            <div className="pt-2 border-t border-theme-border/40">
              <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold">Bodega Destino Original</span>
              <p className="font-semibold text-theme-text mt-0.5">{poDetail.po.warehouse_name || 'Sin bodega predeterminada'}</p>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-theme-border/40">
              <div className="flex flex-col justify-end">
                <div className="flex items-end justify-between mb-1 gap-1">
                  <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold leading-tight">Tipo Recepción</span>
                  <span className="text-[8px] text-theme-text-muted/60 uppercase whitespace-nowrap hidden sm:inline-block">Definido en OC</span>
                </div>
                <div className="flex items-center h-8 rounded-lg border border-theme-border/50 bg-theme-text/[0.02] px-2.5 text-xs font-semibold text-theme-text shadow-sm cursor-default">
                  {receivingType === 'WAREHOUSE' ? 'Física (Bodega)' : 'Administrativa (Oficina)'}
                </div>
              </div>
              
              <div className="flex flex-col justify-end">
                <div className="flex items-end justify-between mb-1 gap-1">
                  <span className="text-theme-text-muted uppercase tracking-wider text-[9px] font-semibold leading-tight">Bodega Ingreso</span>
                  <span className="text-[8px] text-theme-text-muted/60 uppercase whitespace-nowrap hidden sm:inline-block">Dato de origen</span>
                </div>
                <div className="flex items-center h-8 rounded-lg border border-theme-border/50 bg-theme-text/[0.02] px-2.5 text-[11px] font-semibold text-theme-text shadow-sm cursor-default truncate">
                  {receivingType === 'OFFICE' ? '—' : (poDetail.po.warehouse_name || 'No asignada')}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Center/Right side: Documents and evidence */}
        <div className="lg:col-span-2 p-5 rounded-2xl border border-theme-border bg-theme-surface/50 space-y-4 text-xs">
          <h3 className="font-bold text-theme-text uppercase tracking-wider text-[11px] border-b border-theme-border/60 pb-2 flex items-center gap-1.5">
            <LucideIcons.UploadCloud className="w-3.5 h-3.5 text-theme-accent" />
            Documento de Respaldo y Evidencia
          </h3>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Tipo Documento</label>
              <select
                value={documentType}
                onChange={e => setDocumentType(e.target.value)}
                className={cn(erpSelectClass, 'w-full h-8 px-3 text-xs')}
              >
                <option value="GD">GD - Guía de Despacho</option>
                <option value="FA">FA - Factura</option>
                <option value="FOTO">FOTO - Captura fotográfica</option>
                <option value="EVIDENCIA">EVIDENCIA - Archivo de Prueba</option>
                <option value="OTRO">OTRO - Documento diverso</option>
              </select>
            </div>

            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Número Documento</label>
              <input
                type="text"
                value={documentNumber}
                onChange={e => setDocumentNumber(e.target.value)}
                placeholder="Ej: 12948"
                className={cn(erpInputClass, 'w-full h-8 px-3 text-xs')}
              />
            </div>

            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Fecha Emisión Doc.</label>
              <input
                type="date"
                value={documentDate}
                onChange={e => setDocumentDate(e.target.value)}
                className={cn(erpInputClass, 'w-full h-8 px-3 text-xs')}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Archivo Adjunto (PDF / Imagen)</label>
              
              {attachment ? (
                <div className="flex items-center justify-between p-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 text-theme-text">
                  <div className="flex items-center gap-2 truncate">
                    <LucideIcons.FileCheck className="w-4 h-4 text-emerald-500 shrink-0" />
                    <span className="truncate text-xs font-semibold" title={attachment.file_name}>{attachment.file_name}</span>
                    <span className="text-[10px] text-theme-text-muted/70 shrink-0">({(attachment.file_size / 1024).toFixed(1)} KB)</span>
                  </div>
                  <button 
                    onClick={() => setAttachment(null)}
                    className="p-1 rounded-md text-red-500 hover:bg-red-500/10 transition-colors"
                  >
                    <LucideIcons.X className="w-3.5 h-3.5" />
                  </button>
                </div>
              ) : (
                <label className={cn(
                  "flex flex-col items-center justify-center p-4 rounded-lg border border-dashed border-theme-border bg-theme-surface hover:bg-theme-text/5 cursor-pointer transition-all",
                  uploadingFile && "opacity-60 pointer-events-none"
                )}>
                  {uploadingFile ? (
                    <>
                      <LucideIcons.Loader2 className="w-4 h-4 animate-spin text-theme-accent mb-1" />
                      <span className="text-[10px] text-theme-text-muted">Subiendo al bucket recepciones...</span>
                    </>
                  ) : (
                    <>
                      <LucideIcons.Upload className="w-4 h-4 text-theme-accent mb-1" />
                      <span className="text-[10px] text-theme-text-muted">Subir comprobante o foto</span>
                      <input
                        type="file"
                        accept=".pdf,.png,.jpg,.jpeg,.webp"
                        onChange={handleFileUpload}
                        className="hidden"
                      />
                    </>
                  )}
                </label>
              )}
            </div>

            <div>
              <label className="block text-[10px] font-bold text-theme-text-muted uppercase mb-1">Comentario del Adjunto</label>
              <textarea
                value={documentNotes}
                onChange={e => {
                  setDocumentNotes(e.target.value)
                  if (attachment) {
                    setAttachment(prev => prev ? { ...prev, notes: e.target.value } : null)
                  }
                }}
                placeholder="Observación del archivo cargado..."
                rows={2}
                className={cn(erpInputClass, 'w-full px-3 py-2 text-xs resize-none')}
              />
            </div>
          </div>

        </div>
      </div>

      {/* General observation comments */}
      <div className="space-y-2">
        <label className="text-xs font-bold text-theme-text uppercase tracking-wider flex items-center gap-1.5">
          <LucideIcons.AlignLeft className="w-3.5 h-3.5 text-theme-accent" />
          Observaciones Generales de la Recepción
        </label>
        <textarea 
          value={generalNotes}
          onChange={e => setGeneralNotes(e.target.value)}
          rows={2}
          placeholder="Ingrese comentarios adicionales sobre la carga, estado del transporte, etc..."
          className={cn(erpInputClass, 'w-full rounded-xl px-4 py-2.5 text-xs resize-none')}
        />
      </div>

      {/* Continuous ERP Tabular Grid for receipt lines */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-theme-border/60 pb-2">
          <h3 className="text-xs font-bold text-theme-text uppercase tracking-wider flex items-center gap-1.5">
            <LucideIcons.ListChecks className="w-4 h-4 text-theme-accent" />
            Líneas a Recepcionar
          </h3>
          <span className="text-[10px] bg-theme-text/10 text-theme-text font-bold px-2 py-0.5 rounded-full">
            {poDetail.items.length} ítems en total
          </span>
        </div>

        {/* Unified Table Container */}
        <div className="rounded-2xl border border-theme-border bg-theme-surface shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-left border-collapse">
              <thead>
                <tr className="border-b border-theme-border bg-theme-text/[0.03] text-theme-text-muted font-bold text-[10px] uppercase tracking-wider">
                  <th className="py-3 px-4 w-12 text-center">#</th>
                  <th className="py-3 px-4 w-28">SKU</th>
                  <th className="py-3 px-4 min-w-[200px]">Descripción</th>
                  <th className="py-3 px-4 text-right w-20">Solicitado</th>
                  <th className="py-3 px-4 text-right w-24">Ya Recibido</th>
                  <th className="py-3 px-4 text-right w-20">Pendiente</th>
                  <th className="py-3 px-4 text-right w-28 text-theme-accent">Rec. Actual</th>
                  <th className="py-3 px-4 text-right w-28">P. Unitario</th>
                  <th className="py-3 px-4 text-right w-32 font-bold text-theme-text">Monto Rec.</th>
                </tr>
              </thead>
              <tbody>
                {poDetail.items.map((item: any, idx: number) => {
                  const splits = itemInputs[item.id] || []
                  
                  // Calculate quantity accumulations
                  let sumQty = 0
                  let sumActualRec = 0
                  splits.forEach(s => {
                    sumQty += Number(s.quantity || 0)
                    sumActualRec += Number(s.quantity || 0)
                  })

                  const price = Number(item.unit_price || 0)
                  const actualMonto = sumActualRec * price
                  const exceedsPending = sumQty > Number(item.quantity_pending)

                  const itemWh = item.warehouse_id || mainWarehouseId
                  const whLocs = locations.filter(l => l.warehouse_id === itemWh)

                  return (
                    <Fragment key={item.id}>
                      {/* Product Main Row */}
                      <tr className={cn(
                        "border-b border-theme-border bg-theme-text/[0.02] hover:bg-theme-text/[0.04] transition-colors font-medium",
                        exceedsPending && "bg-red-500/[0.02]"
                      )}>
                        <td className="py-2.5 px-4 text-center font-bold text-theme-text">{idx + 1}</td>
                        <td className="py-2.5 px-4 text-theme-text font-mono">{item.sku || item.product_id?.substring(0,8) || '—'}</td>
                        <td className="py-2.5 px-4">
                          <p className="font-semibold text-theme-text text-xs leading-normal">{item.product_description}</p>
                          {exceedsPending && (
                            <p className="text-[10px] text-red-500 font-bold mt-0.5 flex items-center gap-1">
                              <LucideIcons.AlertTriangle className="w-3 h-3 shrink-0" />
                              Suma ({sumQty}) supera pendiente ({item.quantity_pending})
                            </p>
                          )}
                        </td>
                        <td className="py-2.5 px-4 text-right text-theme-text font-semibold">{item.quantity}</td>
                        <td className="py-2.5 px-4 text-right text-emerald-600 dark:text-emerald-400 font-semibold">{item.quantity_received}</td>
                        <td className="py-2.5 px-4 text-right text-theme-text-accent font-semibold">{item.quantity_pending}</td>
                        <td className="py-2.5 px-4 text-right font-bold text-theme-accent bg-theme-accent/[0.02]">{sumActualRec}</td>
                        <td className="py-2.5 px-4 text-right font-semibold text-theme-text">${price.toLocaleString('es-CL')}</td>
                        <td className="py-2.5 px-4 text-right font-bold text-theme-text bg-theme-text/[0.02]">${actualMonto.toLocaleString('es-CL')}</td>
                      </tr>

                      {/* Sub-rows for Splits (Lotes / Partidas) */}
                      {splits.map((split, sIdx) => {
                        const requiresLocation = receivingType === 'WAREHOUSE' && item.item_type === 'PRODUCT'

                        return (
                          <tr key={split.id} className="border-b border-theme-border/40 hover:bg-theme-text/[0.01] transition-colors bg-theme-text/[0.005]">
                            {/* Indentation Symbol Column */}
                            <td className="py-1.5 px-4 text-center font-bold text-theme-accent text-sm">
                              ↳
                            </td>

                            {/* Info */}
                            <td colSpan={2} className="py-1.5 px-4">
                              <span className="text-[10px] text-theme-text-muted font-bold tracking-wider uppercase">Lote {sIdx + 1}</span>
                            </td>

                            {/* Quantity Input column */}
                            <td className="py-1.5 px-4 text-right">
                              <input
                                type="number"
                                min="0"
                                max={item.quantity_pending}
                                step="0.001"
                                value={split.quantity}
                                onChange={e => {
                                  const val = Math.max(0, parseFloat(e.target.value) || 0)
                                  updateSplitField(item.id, split.id, 'quantity', val)
                                }}
                                className={cn(erpInputClass, 'w-20 h-7 rounded px-2 text-right font-bold text-[11px]')}
                              />
                            </td>

                            {/* Splits details inputs aligned on rest of columns */}
                            <td colSpan={5} className="py-1.5 px-4">
                              <div className="flex items-center gap-3">
                                {requiresLocation && whLocs.length > 0 && (
                                  <div className="flex items-center gap-1 shrink-0">
                                    <span className="text-[10px] text-theme-text-muted font-bold">Ubic:</span>
                                    <select
                                      value={split.location_id}
                                      onChange={e => updateSplitField(item.id, split.id, 'location_id', e.target.value)}
                                      className={cn(erpSelectClass, 'h-7 rounded px-1.5 text-[11px] font-bold')}
                                    >
                                      <option value="">Seleccionar...</option>
                                      {whLocs.map(l => (
                                        <option key={l.id} value={l.id}>{l.code}</option>
                                      ))}
                                    </select>
                                  </div>
                                )}

                                {item.item_type === 'PRODUCT' && (
                                  <>
                                    <div className="flex items-center gap-1 shrink-0">
                                      <span className="text-[10px] text-theme-text-muted font-bold">Lote:</span>
                                      <input
                                        type="text"
                                        value={split.lot_number}
                                        onChange={e => updateSplitField(item.id, split.id, 'lot_number', e.target.value)}
                                        placeholder="Código"
                                        className={cn(erpInputClass, 'w-20 h-7 rounded px-1.5 text-[11px] font-bold')}
                                      />
                                    </div>

                                    <div className="flex items-center gap-1 shrink-0">
                                      <span className="text-[10px] text-theme-text-muted font-bold">Venc:</span>
                                      <input
                                        type="date"
                                        value={split.expiration_date}
                                        onChange={e => updateSplitField(item.id, split.id, 'expiration_date', e.target.value)}
                                        className={cn(erpInputClass, 'h-7 rounded px-1.5 text-[11px] font-bold')}
                                      />
                                    </div>
                                  </>
                                )}

                                {/* Observations Notes */}
                                <div className="flex-1">
                                  <input
                                    type="text"
                                    value={split.notes}
                                    onChange={e => updateSplitField(item.id, split.id, 'notes', e.target.value)}
                                    placeholder="Notas u observaciones (opcional)..."
                                    className={cn(erpInputClass, 'w-full h-7 rounded px-2 text-[11px]')}
                                  />
                                </div>

                                {/* Trash action */}
                                {splits.length > 1 && (
                                  <button
                                    onClick={() => removeSplit(item.id, split.id)}
                                    className="p-1 rounded text-red-500 hover:bg-red-500/10 transition-colors shrink-0"
                                    title="Eliminar lote"
                                  >
                                    <LucideIcons.Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        )
                      })}

                      {/* Plus Split Action Row */}
                      <tr className="border-b border-theme-border last:border-none bg-theme-text/[0.005]">
                        <td className="py-1 px-4 text-center"></td>
                        <td colSpan={8} className="py-1 px-4">
                          <button
                            onClick={() => addSplit(item.id)}
                            className="inline-flex items-center gap-1 text-[10px] font-bold text-theme-accent hover:text-theme-accent-hover transition-colors pl-8 py-0.5"
                          >
                            <LucideIcons.Plus className="w-3 h-3" />
                            <span>+ Agregar lote / partida</span>
                          </button>
                        </td>
                      </tr>
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Dynamic financial totals block */}
      <div className="flex flex-col md:flex-row items-stretch justify-between gap-6 p-6 rounded-2xl border border-theme-border bg-theme-surface/50 shadow-sm text-xs">
        <div className="max-w-md space-y-1.5 flex flex-col justify-center">
          <h4 className="font-bold text-theme-text text-sm">Resumen de Recepción Local</h4>
          <p className="text-theme-text-muted leading-relaxed">
            Los totales mostrados se calculan automáticamente considerando las cantidades aceptadas para ingreso al stock.
          </p>
        </div>

        <div className="w-full md:w-64 space-y-2 border-t md:border-t-0 md:border-l border-theme-border/60 pt-4 md:pt-0 md:pl-6 flex flex-col justify-center">
          <div className="flex justify-between items-center text-theme-text-muted">
            <span>Subtotal Neto:</span>
            <span className="font-semibold text-theme-text">${netTotal.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
          </div>
          <div className="flex justify-between items-center text-theme-text-muted">
            <span>IVA (19%):</span>
            <span className="font-semibold text-theme-text">${taxTotal.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
          </div>
          <div className="flex justify-between items-center border-t border-theme-border/40 pt-2 text-sm font-bold text-theme-text">
            <span>Total Recibido:</span>
            <span className="text-theme-accent">${grossTotal.toLocaleString('es-CL', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}</span>
          </div>
        </div>
      </div>

      {/* Confirmation buttons at bottom */}
      <div className="flex justify-end gap-3 pt-4 border-t border-theme-border/60">
        <button 
          onClick={() => router.push('/dashboard/logistica')}
          className="px-5 py-2.5 rounded-xl border border-theme-border bg-theme-surface hover:bg-theme-text/5 text-xs font-semibold text-theme-text transition-all"
        >
          Volver a Recepciones
        </button>
        <button 
          onClick={handleSaveReceipt} 
          disabled={saving}
          className="flex items-center gap-1.5 px-6 py-3 rounded-xl bg-theme-accent hover:bg-theme-accent-hover text-white text-xs font-bold transition-all shadow-lg shadow-theme-accent/20 disabled:opacity-50"
        >
          {saving ? (
            <LucideIcons.Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <LucideIcons.CheckCircle2 className="w-4 h-4" />
          )}
          <span>{saving ? 'Registrando recepción...' : 'Confirmar y Registrar Recepción'}</span>
        </button>
      </div>

    </div>
  )
}
