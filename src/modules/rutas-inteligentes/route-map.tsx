'use client'

import { useEffect, useRef, useState } from 'react'
import type { Map as MapLibreMap, Marker } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { loadMapLibre } from './maplibre-loader'
import type { VroomRoundTripVehicle } from './warehouse-origin'
import type { ScenarioMapStop } from './route-scenario'

export type PreviewCandidate = {
  coordinates: [number, number]
  label: string
  address?: string | null
}

export function RouteMap({
  vehicle,
  stops,
  onToggleSelection,
  className = 'h-64 sm:h-80',
  previewCandidate = null,
  routeGeometry = null,
}: {
  vehicle: VroomRoundTripVehicle
  stops: ScenarioMapStop[]
  onToggleSelection: (id: string) => void
  className?: string
  previewCandidate?: PreviewCandidate | null
  routeGeometry?: Array<[number, number]> | null
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const libraryRef = useRef<typeof import('maplibre-gl') | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const coordinatesKey = JSON.stringify(stops.map(stop => stop.coordinates))
  const previewCoordinatesKey = previewCandidate ? JSON.stringify(previewCandidate.coordinates) : null

  useEffect(() => {
    let cancelled = false
    void loadMapLibre().then(library => {
      if (cancelled || !containerRef.current) return
      libraryRef.current = library
      const map = new library.Map({
        container: containerRef.current,
        style: 'https://tiles.openfreemap.org/styles/liberty',
        center: [vehicle.start[0], vehicle.start[1]],
        zoom: 10,
      })
      mapRef.current = map
      map.addControl(new library.NavigationControl(), 'top-right')
      map.on('load', () => { if (!cancelled) setReady(true) })
      map.on('error', () => { if (!cancelled) setError('No se pudo cargar completamente el mapa. Las paradas siguen disponibles en la lista.') })
    }).catch(() => { if (!cancelled) setError('No se pudo iniciar el mapa. Las paradas siguen disponibles en la lista.') })
    return () => { cancelled = true; mapRef.current?.remove(); mapRef.current = null; libraryRef.current = null }
  }, [vehicle])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !routeGeometry) return
    map.addSource('optimized-route', { type: 'geojson', data: { type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: routeGeometry } } })
    map.addLayer({ id: 'optimized-route', type: 'line', source: 'optimized-route', paint: { 'line-color': '#72383D', 'line-width': 5, 'line-opacity': 0.85 }, layout: { 'line-join': 'round', 'line-cap': 'round' } })
    return () => { if (map.getLayer('optimized-route')) map.removeLayer('optimized-route'); if (map.getSource('optimized-route')) map.removeSource('optimized-route') }
  }, [ready, routeGeometry])

  useEffect(() => {
    const map = mapRef.current
    const library = libraryRef.current
    if (!ready || !map || !library) return
    const markers: Marker[] = []
    const warehouse = document.createElement('div')
    warehouse.className = 'rounded-md border-2 border-white bg-[#322D29] px-2 py-1 text-xs font-bold text-white shadow-lg'
    warehouse.textContent = 'Bodega · origen y regreso'
    warehouse.title = 'Punto Google Maps; acceso vehicular no confirmado'
    markers.push(new library.Marker({ element: warehouse, anchor: 'bottom' }).setLngLat([vehicle.start[0], vehicle.start[1]]).addTo(map))
    const coordinateCounts = new Map<string, number>()
    for (const stop of stops) {
      const key = JSON.stringify(stop.coordinates)
      coordinateCounts.set(key, (coordinateCounts.get(key) ?? 0) + 1)
    }
    const coordinatePositions = new Map<string, number>()
    for (const stop of stops) {
      const key = JSON.stringify(stop.coordinates)
      const position = coordinatePositions.get(key) ?? 0
      coordinatePositions.set(key, position + 1)
      const offset = (position - ((coordinateCounts.get(key) ?? 1) - 1) / 2) * 36
      const button = document.createElement('button')
      button.type = 'button'
      button.className = `flex h-8 w-8 items-center justify-center rounded-full border-2 border-white text-xs font-bold text-white shadow-lg ${stop.excluded ? 'bg-slate-500' : 'bg-[#72383D]'} ${stop.selected ? 'ring-4 ring-amber-400' : ''}`
      button.textContent = stop.label
      button.setAttribute('aria-label', `Parada ${stop.label}, ${stop.excluded ? 'excluida' : 'incluida'}${stop.selected ? ', seleccionada' : ''}`)
      button.setAttribute('aria-pressed', String(stop.selected))
      button.addEventListener('click', () => onToggleSelection(stop.id))
      markers.push(new library.Marker({ element: button, anchor: 'center', offset: [offset, 0] }).setLngLat([stop.coordinates[0], stop.coordinates[1]]).addTo(map))
    }

    if (previewCandidate) {
      const previewEl = document.createElement('div')
      previewEl.className = 'flex flex-col items-center pointer-events-auto cursor-default'
      previewEl.setAttribute('role', 'status')
      previewEl.setAttribute('aria-label', `Ubicación provisional: ${previewCandidate.label}`)

      const badge = document.createElement('div')
      badge.className = 'flex items-center gap-1.5 rounded-md border-2 border-dashed border-amber-600 bg-amber-50/95 px-2 py-1 text-xs font-bold text-amber-900 shadow-xl ring-2 ring-amber-400/80 backdrop-blur-sm'
      badge.innerHTML = `<span class="inline-block h-2 w-2 rounded-full bg-amber-500 animate-pulse"></span><span>${previewCandidate.label}</span>`
      if (previewCandidate.address) {
        badge.title = `${previewCandidate.label} · ${previewCandidate.address} · Marcador provisional sin confirmar`
      }

      const stem = document.createElement('div')
      stem.className = 'h-2 w-0.5 bg-amber-600'

      const pin = document.createElement('div')
      pin.className = 'h-2 w-2 rounded-full border border-white bg-amber-700 shadow-sm'

      previewEl.appendChild(badge)
      previewEl.appendChild(stem)
      previewEl.appendChild(pin)

      markers.push(new library.Marker({ element: previewEl, anchor: 'bottom' }).setLngLat([previewCandidate.coordinates[0], previewCandidate.coordinates[1]]).addTo(map))
    }

    return () => { for (const marker of markers) marker.remove() }
  }, [ready, stops, onToggleSelection, vehicle, previewCandidate])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map || !previewCoordinatesKey) return
    const coordinates = JSON.parse(previewCoordinatesKey) as [number, number]
    map.flyTo({
      center: coordinates,
      zoom: 15,
      essential: true,
    })
  }, [ready, previewCoordinatesKey])

  useEffect(() => {
    const map = mapRef.current
    const library = libraryRef.current
    if (!ready || !map || !library || previewCandidate) return
    const locations = JSON.parse(coordinatesKey) as Array<[number, number]>
    if (!locations.length) return
    const bounds = new library.LngLatBounds([vehicle.start[0], vehicle.start[1]], [vehicle.start[0], vehicle.start[1]])
    for (const location of locations) bounds.extend(location)
    map.fitBounds(bounds, { padding: 48, maxZoom: 14, duration: 0 })
  }, [coordinatesKey, ready, vehicle, previewCandidate])

  return <div className={`relative overflow-hidden rounded-lg border border-[#DDD4CA] bg-[#F3F0EB] ${className}`}>
    <div ref={containerRef} aria-label="Mapa de bodega y paradas ubicadas" className="h-full w-full" />
    {!ready && !error && <div className="absolute inset-0 flex items-center justify-center bg-[#F3F0EB] text-xs text-[#6B625C]">Cargando mapa…</div>}
    {error && <div role="status" className="absolute bottom-2 left-2 right-2 rounded-md bg-white/95 px-3 py-2 text-xs text-amber-800 shadow">{error}</div>}
  </div>
}
