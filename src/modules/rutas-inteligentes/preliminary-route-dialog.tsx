'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, MapPin, TriangleAlert } from 'lucide-react'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import type { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'
import { formatPreparationClp } from '@/modules/logistica/preparacion-pedidos/preparation-board-utils'
import { formatPreparationProfitabilityPercent, type PreparationProfitabilitySummaryV1 } from '@/modules/logistica/preparacion-pedidos/preparation-profitability'
import { adaptFilteredPreparationCards } from './preparation-adapter'
import { buildDeliveryStops, type DeliveryIssue, type DeliveryStopsResult, type PotentialStop } from './delivery-stops'
import { formatRouteDocument, presentPotentialStop } from './stop-presentation'
import { RouteMap } from './route-map'
import { createRouteScenario, getScenarioMapStops, getVerifiedStopLocation, updateRouteScenario, type ScenarioAction, type VerifiedStopLocation } from './route-scenario'
import type { EvaluationDelivery } from './types'
import { resolveLocationAction } from './location-lookup-action'
import type { LocationCandidateDetail, LocationLookupItem } from './location-lookup-types'
import { optimizePreparationRouteAction } from './optimize-route-action'
import type { OptimizeRouteResult, OptimizedStop } from './optimize-route-types'
import { decodeRouteGeometry } from './decode-route-geometry'

const issueLabels: Record<DeliveryIssue, string> = {
  MISSING_ADDRESS: 'Falta la dirección',
  AMBIGUOUS_ADDRESS: 'Dirección insuficiente o ambigua',
  MISSING_COMMUNE: 'Falta la comuna',
  AMBIGUOUS_COMMUNE: 'Comuna por confirmar',
  MISSING_CUSTOMER_ID: 'Falta la identidad del cliente',
  MISSING_DOCUMENT_IDENTITY: 'Falta la identidad del documento',
  DUPLICATE_DOCUMENT: 'Documento repetido; revisar montos',
  INVALID_SOURCE_FIELD: 'Datos de origen con tipo incompatible',
}

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  companyId: string | null
  filteredCards: SalesOrderPreparationCardInfo[]
  profitabilityByNv: Record<string, PreparationProfitabilitySummaryV1>
  profitabilityLoading: boolean
  profitabilityError: string | null
  boardLoading: boolean
  boardError: string | null
  routeWarningsByCardId: Record<string, string[]>
  locationsByStopId?: Readonly<Record<string, VerifiedStopLocation | undefined>>
}

const NO_LOCATIONS: Readonly<Record<string, VerifiedStopLocation | undefined>> = Object.freeze({})

type LocationUiState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'done'; result: LocationLookupItem }

function locationStatus(result: LocationLookupItem): string {
  if (result.providerClassification === 'EXACT') return result.recognizedLocation ? 'Exacta · acceso físico no confirmado' : 'Exacta del proveedor · requiere revisión'
  if (result.providerClassification === 'APPROXIMATE') return 'Aproximada · requiere revisión'
  if (result.providerClassification === 'AMBIGUOUS' || result.cacheStatus === 'CACHE_AMBIGUOUS') return 'Ambigua · requiere revisión'
  if (result.providerClassification === 'NOT_FOUND' || result.cacheStatus === 'CACHE_NOT_FOUND') return 'No encontrada'
  if (result.cacheStatus === 'CACHE_RESOLVED') return 'Caché · ubicación sin verificar'
  if (result.cacheStatus === 'REVIEW_REQUIRED') return 'Dirección pendiente de revisión'
  if (result.cacheStatus === 'CACHE_UNAVAILABLE') return 'Caché no disponible'
  if (result.status === 'ERROR') return result.providerClassification ? `Error del proveedor: ${result.providerClassification}` : 'Servicio no disponible'
  return 'Sin ubicación confirmada'
}

function LocationDetails({
  state,
  stopId,
  stopIndex,
  previewCandidate,
  onSelectCandidate,
}: {
  state: LocationUiState
  stopId: string
  stopIndex: number
  previewCandidate: { stopId: string; candidateIndex: number } | null
  onSelectCandidate: (stopId: string, candidateIndex: number, candidate: LocationCandidateDetail, label: string) => void
}) {
  if (state.kind === 'loading') return <p role="status" className="mt-1 text-[11px] text-[#6B625C]">Consultando ubicación…</p>
  if (state.kind === 'error') return <p role="alert" className="mt-1 text-[11px] text-red-800">{state.message}</p>
  return <div className="mt-1 text-[11px] text-[#514942]">
    <p className="font-semibold">{locationStatus(state.result)}</p>
    {state.result.error && <p>Detalle: {state.result.error}</p>}
    {state.result.candidates.length > 0 && <div className="mt-1.5 space-y-1.5" aria-label="Candidatos geográficos devueltos">
      {state.result.candidates.map((candidate, index) => {
        const isPreviewing = previewCandidate?.stopId === stopId && previewCandidate?.candidateIndex === index
        const candidateLabel = `Parada ${stopIndex + 1} · Candidata ${index + 1}`
        return <div key={`${candidate.coordinates[0]}:${candidate.coordinates[1]}:${index}`} className={`rounded-md border p-2 transition-colors ${isPreviewing ? 'border-amber-400 bg-amber-50/70 text-[#322D29] ring-1 ring-amber-300' : 'border-[#E8DFD5] bg-[#FDFCFB] text-[#514942]'}`}>
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-[#72383D]">
              Candidata {index + 1}
              {candidate.communeMatches === true && <span className="ml-1 font-normal text-emerald-700">(Comuna coincidente)</span>}
              {candidate.communeMatches === false && <span className="ml-1 font-normal text-amber-800">(Comuna no coincidente)</span>}
            </span>
            <button
              type="button"
              onClick={() => onSelectCandidate(stopId, index, candidate, candidateLabel)}
              className={`rounded px-2 py-0.5 text-[10px] font-semibold transition-colors ${isPreviewing ? 'border border-amber-600 bg-amber-200 text-amber-900 shadow-sm' : 'border border-[#72383D]/40 bg-white text-[#72383D] hover:bg-[#FBF3F1]'}`}
              aria-pressed={isPreviewing}
            >
              {isPreviewing ? 'Previsualizando en mapa' : 'Previsualizar en mapa'}
            </button>
          </div>
          <div className="mt-1 space-y-0.5 text-[10px] leading-relaxed">
            {candidate.matchedAddress && <p><strong className="text-[#322D29]">Dirección devuelta:</strong> {candidate.matchedAddress}</p>}
            {(candidate.street || candidate.housenumber) && <p><strong className="text-[#322D29]">Calle y número:</strong> {[candidate.street, candidate.housenumber].filter(Boolean).join(' ')}</p>}
            {candidate.locality && <p><strong className="text-[#322D29]">Comuna:</strong> {candidate.locality}</p>}
            {candidate.accuracy && <p><strong className="text-[#322D29]">Precisión:</strong> {candidate.accuracy}</p>}
            {candidate.confidence != null && <p><strong className="text-[#322D29]">Confianza:</strong> {Math.round(candidate.confidence * 100)}%</p>}
            <p className="text-[#6B625C]">Coordenadas: lat {candidate.coordinates[1]}, lon {candidate.coordinates[0]}</p>
            <p className="text-[9px] italic text-amber-800">Marcador provisional · No confirma acceso vehicular, no modifica la NV ni persiste coordenadas.</p>
          </div>
        </div>
      })}
    </div>}
  </div>
}

function DeliveryDetails({ delivery, warnings }: { delivery: EvaluationDelivery; warnings: string[] }) {
  return <div className="min-w-0 text-xs">
    <div className="font-semibold text-[#322D29]">{delivery.customer.name || 'Cliente sin nombre'}</div>
    <div className="mt-0.5 break-words text-[#6B625C]">{delivery.destination.address || 'Sin dirección'} · {delivery.destination.commune || 'Sin comuna'}</div>
    <div className="mt-1 font-medium text-[#72383D]">{delivery.documents.map(formatRouteDocument).join(' · ') || 'Sin documento identificado'}</div>
    {delivery.invalidSourceFields && delivery.invalidSourceFields.length > 0 && <div className="mt-1 text-amber-800">Campos por revisar: {delivery.invalidSourceFields.join(', ')}</div>}
    {warnings.map(warning => <div key={warning} className="mt-1 text-amber-800">{warning}</div>)}
  </div>
}

export function RouteGeocodingDiagnostics({ result, deliveries }: { result: OptimizeRouteResult | null; deliveries: EvaluationDelivery[] }) {
  const byCard = new Map<string, OptimizedStop>()
  if (result?.ok) for (const stop of result.stops) for (const id of stop.cardIds) byCard.set(id.toLowerCase(), stop)
  const included = deliveries.flatMap(delivery => {
    const stop = byCard.get(delivery.source.recordId.toLowerCase())
    return stop ? [{ delivery, diagnostic: stop.diagnostic }] : []
  })
  const counts = new Map<string, number>()
  for (const { diagnostic } of included) counts.set(diagnostic.reason, (counts.get(diagnostic.reason) ?? 0) + 1)
  return <details className="shrink-0 border-b border-[#E8DFD5] bg-[#FBF3F1] px-3 py-2 text-[11px] text-[#514942]" aria-label="Diagnóstico de geocodificación">
    <summary className="cursor-pointer font-bold text-[#72383D]">Diagnóstico de geocodificación{result?.ok ? ` · ${included.length} tarjetas` : ''}</summary>
    <div className="max-h-[30vh] overflow-y-auto">
    {!result && <p className="mt-2 text-[#6B625C]">Esperando resultados de geocodificación.</p>}
    {result && !result.ok && <p role="status" className="mt-2 text-amber-800">Diagnóstico por tarjeta no disponible: {result.message} · {result.code}. No se puede determinar la autorización ni el estado de HeiGIT.</p>}
    {result?.ok && <>
    <div className="mt-2 space-y-1" aria-label="Resumen por causa">{Array.from(counts).map(([reason, count]) => <p key={reason}><strong>{count}</strong> · {reason}</p>)}</div>
    <div className="mt-2 space-y-2" aria-label="Diagnóstico por tarjeta">{included.map(({ delivery, diagnostic }) => <article key={delivery.source.recordId} className="rounded border border-[#E8DFD5] p-2">
      <p className="font-semibold">{delivery.documents.map(formatRouteDocument).join(' · ') || delivery.source.recordId} · {delivery.customer.name || 'Cliente sin nombre'}</p>
      <p>Autorizada: sí · HeiGIT: {diagnostic.heigit === 'RESPONDED' ? 'respondió' : diagnostic.heigit === 'NOT_QUERIED' ? 'no consultado' : 'sin confirmación'}{diagnostic.classification ? ` · ${diagnostic.classification}` : ''}</p>
      <p>PetGroup: {diagnostic.accepted ? 'aceptada' : 'no aceptada'} · Coordenadas enviadas a VROOM: {diagnostic.sentToVroom ? 'sí' : 'no'}</p>
      <p>Motivo: {diagnostic.reason}</p>
    </article>)}</div>
    </>}
    </div>
  </details>
}

export function PotentialStopCard({ stop, index, warningsByCardId, selection }: { stop: PotentialStop; index: number; warningsByCardId: Record<string, string[]>; selection?: { selected: boolean; excluded: boolean; located: boolean; onToggle: () => void } }) {
  const presentation = presentPotentialStop(stop, warningsByCardId)
  return <article className={`min-w-0 rounded-lg border px-3 py-2.5 ${selection?.excluded ? 'border-[#D1C7BD] bg-[#F3F0EB]' : 'border-[#E8DFD5] bg-white'}`}>
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
      {selection && <input type="checkbox" checked={selection.selected} onChange={selection.onToggle} aria-label={`Seleccionar parada ${index + 1}`} className="h-3.5 w-3.5 accent-[#72383D]" />}
      <span className="text-[10px] font-bold uppercase tracking-wide text-[#72383D]">Parada {index + 1}</span>
      <span className="min-w-0 break-words text-xs font-bold text-[#322D29]">{presentation.customerName}</span>
      <span className="text-[10px] text-[#6B625C]">{presentation.documentCount} {presentation.documentCount === 1 ? 'documento' : 'documentos'}</span>
      {selection && <span className={`text-[10px] font-semibold ${selection.excluded ? 'text-slate-600' : 'text-emerald-700'}`}>{selection.excluded ? 'Excluida del escenario' : 'Incluida en el escenario'}</span>}
    </div>
    <p className="mt-0.5 break-words text-xs text-[#6B625C]">{presentation.address} · {presentation.commune}</p>
    {selection && !selection.located && <p className="mt-0.5 text-[11px] text-amber-800">Ubicación pendiente de verificación</p>}
    <div className="mt-2 flex flex-wrap gap-1.5">
      {presentation.rows.map(({ delivery, documents, individualWarnings }) => <div key={delivery.source.recordId} className="flex flex-wrap items-center gap-1">
        {documents.length ? documents.map(({ document, label }, documentIndex) => <span key={`${document.type}-${document.id ?? document.folio ?? documentIndex}`} className={`rounded-md border px-1.5 py-0.5 text-[11px] font-semibold ${document.type === 'SALES_ORDER' ? 'border-[#E3D4D0] bg-[#FBF3F1] text-[#72383D]' : 'border-[#D7DFE6] bg-[#F2F6F9] text-[#405D72]'}`}>{label}</span>) : <span className="text-[11px] text-amber-800">Sin documento identificado</span>}
        {individualWarnings.map(warning => <span key={warning} className="text-[11px] text-amber-800">{warning}</span>)}
      </div>)}
    </div>
    {presentation.commonWarnings.map(warning => <p key={warning} className="mt-1 text-[11px] text-amber-800">{warning}</p>)}
    <details className="group mt-1.5 border-t border-[#F0EAE4] pt-1.5">
      <summary className="w-fit cursor-pointer text-[11px] font-semibold text-[#72383D] hover:underline">Ver detalle por documento</summary>
      <div className="mt-2 space-y-2">{presentation.rows.map(({ delivery, documents, individualWarnings }) => {
        const commercial = delivery.commercial
        const profit = commercial.profitability
        const amount = (value: number | null) => value == null ? 'No disponible' : formatPreparationClp(value)
        return <div key={delivery.source.recordId} className="rounded-md bg-[#F8F5F1] p-2 text-[11px] text-[#514942]">
          <p className="font-semibold text-[#322D29]">{documents.map(item => item.label).join(' · ') || 'Sin documento identificado'}</p>
          {(delivery.customer.name || 'Cliente sin nombre') !== presentation.customerName && <p>Cliente: {delivery.customer.name || 'Cliente sin nombre'}</p>}
          {(delivery.destination.address !== presentation.address || delivery.destination.commune !== presentation.commune) && <p>Destino: {delivery.destination.address || 'Sin dirección'} · {delivery.destination.commune || 'Sin comuna'}</p>}
          <p>Neto: {amount(commercial.netAmount)} · Impuesto: {amount(commercial.taxAmount)} · Bruto: {amount(commercial.grossAmount)} · Total: {amount(commercial.totalAmount)}</p>
          <p>Utilidad: {profit.availability === 'AVAILABLE' && profit.estimatedGrossProfit !== null ? `${amount(profit.estimatedGrossProfit)}${profit.costStatus === 'PARTIAL' ? ' (parcial)' : ''} · cobertura ${formatPreparationProfitabilityPercent(profit.costCoveragePct)}` : 'No disponible'}</p>
          {delivery.invalidSourceFields && delivery.invalidSourceFields.length > 0 && <p className="text-amber-800">Campos por revisar: {delivery.invalidSourceFields.join(', ')}</p>}
          {individualWarnings.map(warning => <p key={warning} className="text-amber-800">{warning}</p>)}
        </div>
      })}</div>
    </details>
  </article>
}

export function ScenarioWorkspace({ stops, unresolved, routeWarningsByCardId, locationsByStopId }: { stops: PotentialStop[]; unresolved: DeliveryStopsResult['unresolved']; routeWarningsByCardId: Record<string, string[]>; locationsByStopId: Readonly<Record<string, VerifiedStopLocation | undefined>> }) {
  const [scenario, setScenario] = useState(() => createRouteScenario([...stops, ...unresolved.map(item => ({ id: `stop:unresolved:${item.id}` }))]))
  const [locationStates, setLocationStates] = useState<Record<string, LocationUiState>>({})
  const [optimization, setOptimization] = useState<{ key: string; result: OptimizeRouteResult } | null>(null)
  const routeRequests = useRef(new Map<string, Promise<OptimizeRouteResult>>())
  const [previewCandidate, setPreviewCandidate] = useState<{
    stopId: string
    candidateIndex: number
    coordinates: [number, number]
    label: string
    address?: string | null
  } | null>(null)
  const locationsInFlight = useRef(new Set<string>())
  const dispatch = useCallback((action: ScenarioAction) => setScenario(current => updateRouteScenario(current, action)), [])
  const toggle = useCallback((stopId: string) => dispatch({ type: 'TOGGLE_SELECTION', stopId }), [dispatch])
  const includedCardIds = [
    ...stops.filter(stop => !scenario.excludedIds.has(stop.id)).flatMap(stop => stop.deliveries.map(delivery => delivery.source.recordId)),
    ...unresolved.filter(item => !scenario.excludedIds.has(`stop:unresolved:${item.id}`)).map(item => item.delivery.source.recordId),
  ]
  const requestKey = JSON.stringify(includedCardIds)
  useEffect(() => {
    let active = true
    const ids = JSON.parse(requestKey) as string[]
    if (!ids.length) return () => { active = false }
    let request = routeRequests.current.get(requestKey)
    if (!request) {
      request = optimizePreparationRouteAction(ids).catch(() => ({ ok: false as const, code: 'ROUTE_UNAVAILABLE', message: 'No se pudo calcular la ruta.' }))
      routeRequests.current.set(requestKey, request)
      void request.then(result => { if (!result.ok) routeRequests.current.delete(requestKey) })
    }
    void request.then(result => { if (active) setOptimization({ key: requestKey, result }) })
    return () => { active = false }
  }, [requestKey])
  const currentResult = optimization?.key === requestKey ? optimization.result : null
  const routeResult = currentResult?.ok ? currentResult : null
  const routeGeometry = useMemo(() => {
    if (!routeResult?.route) return null
    try { return decodeRouteGeometry(routeResult.route.encodedGeometry) } catch { return null }
  }, [routeResult])
  const optimizedOrder = useMemo(() => new Map(routeResult?.route?.orderedStops.flatMap(stop => stop.stopId ? [[stop.stopId, stop.sequence] as const] : []) ?? []), [routeResult])
  const handleSelectCandidate = useCallback((
    stopId: string,
    candidateIndex: number,
    candidate: LocationCandidateDetail,
    label: string
  ) => {
    setPreviewCandidate(current => {
      if (current?.stopId === stopId && current?.candidateIndex === candidateIndex) {
        return null
      }
      return {
        stopId,
        candidateIndex,
        coordinates: [candidate.coordinates[0], candidate.coordinates[1]],
        label: `${label} (provisional)`,
        address: candidate.matchedAddress ?? null,
      }
    })
  }, [])
  const effectiveLocations = useMemo(() => {
    const next: Record<string, VerifiedStopLocation | undefined> = { ...locationsByStopId }
    for (const stop of routeResult?.stops ?? []) {
      if (stop.stopId && stop.coordinates) next[stop.stopId] = { coordinates: stop.coordinates, verification: 'COORDINATE_VERIFIED', source: 'HEIGIT_PELIAS' }
    }
    for (const [id, state] of Object.entries(locationStates)) {
      if (state.kind === 'done' && state.result.recognizedLocation) next[id] = state.result.recognizedLocation
    }
    return next
  }, [locationsByStopId, locationStates, routeResult])
  const mapStops = useMemo(() => getScenarioMapStops(stops, effectiveLocations, scenario).map(stop => ({ ...stop, label: optimizedOrder.has(stop.id) ? String(optimizedOrder.get(stop.id)) : '–' })), [stops, effectiveLocations, scenario, optimizedOrder])
  const pendingStops = stops.filter(stop => !scenario.excludedIds.has(stop.id) && !getVerifiedStopLocation(effectiveLocations[stop.id]))
  const pendingDeliveries = [...pendingStops.flatMap(stop => stop.deliveries), ...unresolved.filter(item => !scenario.excludedIds.has(`stop:unresolved:${item.id}`)).map(item => item.delivery)]
  const pendingClients = new Set(pendingDeliveries.flatMap(delivery => delivery.customer.id != null && Number.isSafeInteger(delivery.customer.id) && delivery.customer.id > 0 ? [delivery.customer.id] : []))
  const pendingWithoutClientId = pendingDeliveries.filter(delivery => delivery.customer.id == null || !Number.isSafeInteger(delivery.customer.id) || delivery.customer.id <= 0).length
  const selectedIncluded = [...scenario.selectedIds].some(id => !scenario.excludedIds.has(id))
  const selectedExcluded = [...scenario.selectedIds].some(id => scenario.excludedIds.has(id))
  const consultLocation = async (stop: PotentialStop) => {
    if (locationsInFlight.current.has(stop.id)) return
    locationsInFlight.current.add(stop.id)
    setLocationStates(current => ({ ...current, [stop.id]: { kind: 'loading' } }))
    try {
      const cardIds = stop.deliveries.map(delivery => delivery.source.recordId)
      const response = await resolveLocationAction(cardIds)
      if (!response.ok) {
        setLocationStates(current => ({ ...current, [stop.id]: { kind: 'error', message: response.error } }))
      } else {
        const result = response.results[0]
        const expected = [...cardIds].sort().join(',')
        if (response.results.length !== 1 || !result || result.stopId !== stop.id || [...result.cardIds].sort().join(',') !== expected) {
          setLocationStates(current => ({ ...current, [stop.id]: { kind: 'error', message: 'La parada cambió; actualiza el tablero antes de consultar.' } }))
        } else {
          setLocationStates(current => ({ ...current, [stop.id]: { kind: 'done', result } }))
        }
      }
    } catch {
      setLocationStates(current => ({ ...current, [stop.id]: { kind: 'error', message: 'No se pudo consultar la ubicación.' } }))
    } finally {
      locationsInFlight.current.delete(stop.id)
    }
  }
  return <section className="grid min-h-0 flex-1 grid-rows-[minmax(180px,45%)_minmax(0,1fr)] gap-2 px-3 pt-2 lg:grid-cols-[minmax(0,7fr)_minmax(270px,3fr)] lg:grid-rows-1" aria-label="Mapa y escenario de ruta">
    <div className="relative min-h-0 min-w-0">
      <RouteMap
        vehicle={scenario.vehicle}
        stops={mapStops}
        onToggleSelection={toggle}
        previewCandidate={previewCandidate ? {
          coordinates: previewCandidate.coordinates,
          label: previewCandidate.label,
          address: previewCandidate.address,
        } : null}
        routeGeometry={routeGeometry}
        className="h-full min-h-0"
      />
      <div className="pointer-events-none absolute left-2 top-2 max-w-[calc(100%-5rem)] rounded-md bg-white/95 px-2 py-1 text-[10px] text-[#514942] shadow">Bodega: origen y regreso fijos · acceso vehicular no confirmado</div>
      {previewCandidate && <div className="pointer-events-auto absolute left-2 top-8 max-w-[calc(100%-5rem)] flex items-center gap-2 rounded-md border border-amber-400 bg-amber-50/95 px-2.5 py-1 text-[10px] font-semibold text-amber-900 shadow">
        <span className="truncate">Previsualizando: {previewCandidate.label}</span>
        <button type="button" onClick={() => setPreviewCandidate(null)} className="shrink-0 rounded border border-amber-600/40 bg-white px-1 py-0.5 text-[9px] font-bold text-amber-900 hover:bg-amber-100">Cerrar previsualización</button>
      </div>}
    </div>
    <aside className="flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-[#E8DFD5] bg-white" aria-label="Panel de entregas">
      <div className="shrink-0 border-b border-[#E8DFD5] px-3 py-2">
        <div className="flex items-center justify-between gap-2"><h3 className="flex items-center gap-1.5 text-xs font-bold text-[#322D29]"><MapPin className="h-3.5 w-3.5 text-[#72383D]" /> Entregas</h3><span className="text-[10px] font-semibold text-[#72383D]">{scenario.excludedIds.size ? 'Escenario modificado' : 'Escenario original'}</span></div>
        <p className="mt-1 text-[10px] text-[#6B625C]">{scenario.stopIds.size - scenario.excludedIds.size} incluidas · {scenario.excludedIds.size} excluidas · {scenario.selectedIds.size} seleccionadas</p>
        <p role="status" className="mt-1 text-[11px] font-semibold text-[#72383D]">{!includedCardIds.length ? 'Sin entregas incluidas' : !currentResult ? 'Calculando ruta…' : !currentResult.ok ? currentResult.message : !routeResult?.route ? (routeResult?.pending.length ? 'Sin paradas localizadas; ruta no disponible' : 'Sin paradas asignadas; ruta no disponible') : !routeGeometry ? 'No se pudo dibujar la geometría de la ruta' : `${routeResult.complete ? 'Ruta completa' : 'Ruta parcial'} · ${(routeResult.route.distanceMeters / 1000).toFixed(1)} km · ${Math.round(routeResult.route.travelSeconds / 60)} min de conducción`}</p>
        {routeResult && (routeResult.pending.length > 0 || routeResult.unassigned.length > 0) && <p className="mt-1 text-[10px] font-semibold text-amber-800">Pendientes de ubicación: {routeResult.pending.length} · No asignadas: {routeResult.unassigned.length}</p>}
        <p className="mt-1 text-[10px] font-semibold text-amber-800">Ubicaciones pendientes ({pendingStops.length}) · Clientes pendientes: {pendingClients.size}{pendingWithoutClientId ? ` · ${pendingWithoutClientId} entregas sin ID de cliente` : ''}</p>
        <div className="mt-2 flex flex-wrap gap-1 text-[10px]">
          <button type="button" onClick={() => dispatch({ type: 'SELECT_ALL' })} disabled={!scenario.stopIds.size} className="rounded border border-[#D1C7BD] px-1.5 py-1 font-semibold disabled:opacity-40">Seleccionar todas</button>
          <button type="button" onClick={() => dispatch({ type: 'CLEAR_SELECTION' })} disabled={!scenario.selectedIds.size} className="rounded border border-[#D1C7BD] px-1.5 py-1 font-semibold disabled:opacity-40">Limpiar selección</button>
          <button type="button" onClick={() => dispatch({ type: 'EXCLUDE_SELECTED' })} disabled={!selectedIncluded} className="rounded border border-[#D1C7BD] px-1.5 py-1 font-semibold disabled:opacity-40">Excluir seleccionadas</button>
          <button type="button" onClick={() => dispatch({ type: 'INCLUDE_SELECTED' })} disabled={!selectedExcluded} className="rounded border border-[#D1C7BD] px-1.5 py-1 font-semibold disabled:opacity-40">Reincorporar seleccionadas</button>
          <button type="button" onClick={() => dispatch({ type: 'RESTORE' })} disabled={!scenario.excludedIds.size && !scenario.selectedIds.size} className="rounded border border-[#72383D]/30 bg-[#FBF3F1] px-1.5 py-1 font-semibold text-[#72383D] disabled:opacity-40">Restaurar escenario original</button>
        </div>
      </div>
      <RouteGeocodingDiagnostics result={currentResult} deliveries={[...stops.flatMap(stop => stop.deliveries), ...unresolved.map(item => item.delivery)]} />
      <div className="min-h-0 flex-1 overflow-y-auto" aria-label="Lista de paradas">
        {stops.length === 0 && unresolved.length === 0 && <p className="px-3 py-5 text-xs text-[#6B625C]">No hay NV para los filtros actuales.</p>}
        {stops.map((stop, index) => {
          const presentation = presentPotentialStop(stop, routeWarningsByCardId)
          const selected = scenario.selectedIds.has(stop.id)
          const excluded = scenario.excludedIds.has(stop.id)
          const located = Boolean(getVerifiedStopLocation(effectiveLocations[stop.id]))
          const warningCount = presentation.commonWarnings.length + presentation.rows.reduce((count, row) => count + row.individualWarnings.length, 0)
          return <div key={stop.id} className={`border-b border-[#F0EAE4] px-3 py-2 ${selected ? 'bg-[#FBF3F1]' : ''}`}>
            <div className="flex items-center gap-2">
              <input type="checkbox" checked={selected} onChange={() => toggle(stop.id)} aria-label={`Seleccionar parada ${index + 1}`} className="h-3.5 w-3.5 shrink-0 accent-[#72383D]" />
              <button type="button" onClick={() => toggle(stop.id)} aria-pressed={selected} className="min-w-0 flex-1 text-left" title={`${presentation.customerName} · ${presentation.address} · ${presentation.commune}`}>
                <span className="block truncate text-xs font-semibold text-[#322D29]"><span className="mr-1 text-[#72383D]">{index + 1}.</span>{presentation.customerName}</span>
                <span className="block truncate text-[10px] text-[#6B625C]">{presentation.commune} · {presentation.documentCount} {presentation.documentCount === 1 ? 'documento' : 'documentos'}</span>
              </button>
              <div className="shrink-0 text-right text-[10px]"><span className={located ? 'text-emerald-700' : 'text-amber-800'}>{located ? 'Ubicada' : 'Pendiente'}</span><br /><span className={excluded ? 'text-slate-600' : 'text-[#72383D]'}>{excluded ? 'Excluida' : 'Incluida'}</span></div>
            </div>
            {!excluded && routeResult?.unassigned.some(item => item.stopId === stop.id) && <p className="ml-5 text-[10px] font-semibold text-amber-800">No asignada por VROOM</p>}
            {!excluded && routeResult?.pending.some(item => item.stopId === stop.id) && <p className="ml-5 text-[10px] font-semibold text-amber-800">Ubicación pendiente · {routeResult.pending.find(item => item.stopId === stop.id)?.locationStatus}</p>}
            {!excluded && optimizedOrder.has(stop.id) && <p className="ml-5 text-[10px] font-semibold text-[#72383D]">Orden de entrega: {optimizedOrder.get(stop.id)}</p>}
            <div className="ml-5 mt-1 flex flex-wrap items-center gap-2"><button type="button" onClick={() => void consultLocation(stop)} disabled={locationStates[stop.id]?.kind === 'loading'} className="rounded border border-[#72383D]/30 bg-[#FBF3F1] px-1.5 py-0.5 text-[10px] font-semibold text-[#72383D] disabled:opacity-50">{locationStates[stop.id]?.kind === 'loading' ? 'Consultando…' : locationStates[stop.id] ? 'Consultar de nuevo' : 'Consultar ubicación'}</button></div>
            {locationStates[stop.id] && <div className="ml-5"><LocationDetails state={locationStates[stop.id]} stopId={stop.id} stopIndex={index} previewCandidate={previewCandidate} onSelectCandidate={handleSelectCandidate} /></div>}
            <details className="ml-5 mt-0.5"><summary className="w-fit cursor-pointer text-[10px] font-semibold text-[#72383D]">Ver detalle{warningCount ? ` · ${warningCount} aviso${warningCount === 1 ? '' : 's'}` : ''}</summary><div className="mt-1"><PotentialStopCard stop={stop} index={index} warningsByCardId={routeWarningsByCardId} /></div></details>
          </div>
        })}
        {unresolved.length > 0 && <section aria-label="Entregas por revisar"><h4 className="flex items-center gap-1 px-3 py-2 text-[10px] font-bold uppercase text-amber-800"><TriangleAlert className="h-3 w-3" /> Entregas por revisar y ubicar ({unresolved.length})</h4>
          {unresolved.map(item => { const id = `stop:unresolved:${item.id}`; return <div key={item.id} className="border-b border-[#F0EAE4] px-3 py-2"><label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={scenario.selectedIds.has(id)} onChange={() => toggle(id)} aria-label={`Seleccionar entrega pendiente ${item.delivery.customer.name || 'sin nombre'}`} />{scenario.excludedIds.has(id) ? 'Excluida' : 'Incluida · pendiente de revisión'}</label><details><summary className="cursor-pointer text-xs font-semibold text-[#514942]">{item.delivery.customer.name || 'Cliente sin nombre'} · {item.delivery.destination.commune || 'Sin comuna'}</summary><div className="mt-2"><DeliveryDetails delivery={item.delivery} warnings={[...item.issues.map(issue => issueLabels[issue]), ...(routeWarningsByCardId[item.delivery.source.recordId] ?? [])]} /></div></details></div> })}
        </section>}
      </div>
    </aside>
  </section>
}

export function PreliminaryRouteDialog({ open, onOpenChange, companyId, filteredCards, profitabilityByNv, profitabilityLoading, profitabilityError, boardLoading, boardError, routeWarningsByCardId, locationsByStopId = NO_LOCATIONS }: Props) {
  const simulation = useMemo(() => {
    if (!open || boardLoading || boardError || !companyId) return null
    try {
      const evaluation = adaptFilteredPreparationCards({ companyId, filteredCards, profitabilityByNv })
      return { evaluation, ...buildDeliveryStops(evaluation.deliveries), error: null }
    } catch (error) {
      return { evaluation: null, stops: [], unresolved: [], error: error instanceof Error ? error.message : 'No se pudo construir la simulación.' }
    }
  }, [open, companyId, filteredCards, profitabilityByNv, boardLoading, boardError])
  const profit = simulation?.evaluation?.commercialSummary.profitability
  const customerCount = new Set(simulation?.evaluation?.deliveries.flatMap(delivery => delivery.customer.id != null && Number.isSafeInteger(delivery.customer.id) && delivery.customer.id > 0 ? [delivery.customer.id] : []) ?? []).size

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col gap-0 overflow-hidden rounded-xl border border-[#DDD4CA] bg-[#FCFBF9] p-0 text-theme-text shadow-xl ring-0" style={{ maxWidth: '1600px' }}>
      <div className="shrink-0 border-b border-[#E8DFD5] px-4 py-2.5 pr-12">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold">Evaluar ruta</DialogTitle>
          <DialogDescription className="text-xs text-theme-text/65">Simulación de ruta para las NV del filtro activo; no modifica el tablero.</DialogDescription>
        </DialogHeader>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {boardLoading ? <div className="flex items-center justify-center gap-2 py-10 text-xs text-theme-text-muted"><Loader2 className="h-4 w-4 animate-spin" /> Cargando tablero…</div>
          : boardError || !companyId ? <p role="alert" className="rounded-lg bg-red-50 p-3 text-xs text-red-800">{boardError || 'No se pudo identificar la empresa activa.'}</p>
          : simulation?.error ? <div role="alert" className="space-y-3 text-xs text-red-800">
            <p className="rounded-lg bg-red-50 p-3">No se pudo consolidar la simulación: {simulation.error}</p>
            <p>NV presentes en el filtro; revisar sus identidades antes de evaluar:</p>
            <ul className="max-h-48 overflow-y-auto rounded-lg border border-[#E8DFD5] p-3 text-[#322D29]">{filteredCards.map((card, index) => <li key={`${card.card_id}-${index}`}>NV #{card.nv_folio || card.nv_bsale_id} · {card.client_name || 'Cliente sin nombre'} · {card.address_raw || 'Sin dirección'} · {card.municipality_raw || card.normalized_city || card.city_raw || 'Sin comuna'}</li>)}</ul>
          </div>
          : simulation && <>
            <ScenarioWorkspace key={JSON.stringify([companyId, simulation.stops.map(stop => [stop.id, stop.deliveries.map(delivery => delivery.source.recordId)]), simulation.unresolved.map(item => item.id)])} stops={simulation.stops} unresolved={simulation.unresolved} routeWarningsByCardId={routeWarningsByCardId} locationsByStopId={locationsByStopId} />
            <div className="mt-2 flex shrink-0 items-center gap-4 overflow-x-auto border-t border-[#E8DFD5] px-4 py-1.5 text-[10px] text-[#6B625C]" aria-label="Indicadores del filtro completo">
              <span className="whitespace-nowrap">NV filtradas: <strong className="text-[#322D29]">{simulation.evaluation?.commercialSummary.documentCount ?? 0}</strong></span>
              <span className="whitespace-nowrap">Paradas: <strong className="text-[#322D29]">{simulation.stops.length}</strong></span>
              <span className="whitespace-nowrap">Clientes identificados: <strong className="text-[#322D29]">{customerCount}</strong></span>
              <span className="whitespace-nowrap">Por revisar: <strong className="text-[#322D29]">{simulation.unresolved.length}</strong></span>
              <span className="whitespace-nowrap">Utilidad comercial del filtro: <strong className="text-[#322D29]">{profitabilityLoading ? 'Calculando…' : profitabilityError ? 'No disponible' : profit?.availability === 'AVAILABLE' && profit.estimatedGrossProfit !== null ? `${formatPreparationClp(profit.estimatedGrossProfit)}${profit.costStatus === 'PARTIAL' ? ' (parcial)' : ''} · cobertura ${formatPreparationProfitabilityPercent(profit.costCoveragePct)}` : 'No disponible'}</strong></span>
            </div>
          </>}
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-[#E8DFD5] bg-[#F8F5F1] px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-4 overflow-x-auto text-[10px] text-[#6B625C]" aria-label="Comparación futura de ruta">
          <span className="shrink-0 font-semibold text-[#72383D]">Comparación futura</span>
          {['Distancia', 'Tiempo', 'Combustible', 'Peajes', 'Utilidad estimada'].map(label => <span key={label} className="shrink-0">{label}: pendiente</span>)}
        </div>
        <button type="button" onClick={() => onOpenChange(false)} className="shrink-0 rounded-md border border-[#D1C7BD] bg-white px-3 py-1 text-xs font-semibold text-[#322D29] hover:bg-[#F5F0EA]">Cerrar</button>
      </div>
    </DialogContent>
  </Dialog>
}
