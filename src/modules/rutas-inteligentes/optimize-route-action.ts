'use server'

import { randomUUID } from 'node:crypto'
import { requireWmsPermission } from '@/app/actions/logistica/authorization'
import { MYM_PREPARATION_COMPANY_ID } from './authorize-geocoding.server'
import { resolvePreparationGeocoding } from './geocode-cache.server'
import { getVerifiedStopLocation } from './route-scenario'
import type { OptimizedStop, OptimizeRouteResult } from './optimize-route-types'

const MAX_STOPS = 45
const EDGE_URL = 'https://oekmztbfasmildyuajji.supabase.co/functions/v1/rutas-vroom-optimize'
const obj = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
const nonnegative = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0
const fail = (code: string, message: string): OptimizeRouteResult => ({ ok: false, code, message })

/** El navegador solo proporciona tarjetas; direcciones y coordenadas se obtienen en servidor. */
export async function optimizePreparationRouteAction(cardIds: string[]): Promise<OptimizeRouteResult> {
  try {
    const before = await requireWmsPermission('module.logistica.view')
    if (before.companyId !== MYM_PREPARATION_COMPANY_ID) return fail('UNAUTHORIZED', 'Empresa no autorizada para optimizar rutas.')
    if (!Array.isArray(cardIds) || !cardIds.length) return fail('NO_CARDS', 'Selecciona al menos una tarjeta.')
    const resolved = await resolvePreparationGeocoding(cardIds, { maxStops: MAX_STOPS })
    const after = await requireWmsPermission('module.logistica.view')
    if (before.user.id !== after.user.id || before.companyId !== after.companyId || before.effectiveRole !== after.effectiveRole || before.isOperatorBodega !== after.isOperatorBodega) return fail('UNAUTHORIZED', 'La autorización cambió durante la consulta.')
    if (resolved.length > MAX_STOPS) return fail('TOO_MANY_STOPS', 'El límite es de 45 paradas incluidas.')

    const inputOrder = new Map(cardIds.map((id, index) => [id.toLowerCase(), index]))
    const seenCards = new Set<string>()
    const stops = resolved.map(item => {
      const ids = [...item.cardIds].sort((a, b) => (inputOrder.get(a.toLowerCase()) ?? Infinity) - (inputOrder.get(b.toLowerCase()) ?? Infinity))
      for (const id of ids) {
        const key = id.toLowerCase()
        if (!inputOrder.has(key) || seenCards.has(key)) throw new Error('invalid cards')
        seenCards.add(key)
      }
      const provider = item.providerResult
      const coordinates = provider?.classification === 'EXACT' && provider.status === 'RECOGNIZED'
        ? getVerifiedStopLocation(provider.location ?? undefined) : null
      const classification = provider?.classification ?? null
      const heigit = classification && !classification.startsWith('PROVIDER_') ? 'RESPONDED' : !provider || provider.error === 'INVALID_DESTINATION' ? 'NOT_QUERIED' : 'UNKNOWN'
      const reason = coordinates ? 'Ubicación aceptada por PetGroup.'
        : provider?.diagnosticReason ?? provider?.error ?? classification ?? item.reviewReason ?? item.issues?.join(', ') ?? (item.cacheFailure ? `${item.status}: ${item.cacheFailure.category}${item.cacheFailure.edgeCode ? ` · ${item.cacheFailure.edgeCode}` : ''}` : item.status)
      return { stopId: item.stopId, cardIds: ids, locationStatus: classification ?? item.status, coordinates, diagnostic: { authorized: true, heigit, classification, accepted: Boolean(coordinates), reason, sentToVroom: Boolean(coordinates) } } satisfies OptimizedStop
    }).sort((a, b) => (inputOrder.get(a.cardIds[0]?.toLowerCase()) ?? Infinity) - (inputOrder.get(b.cardIds[0]?.toLowerCase()) ?? Infinity))
    if (seenCards.size !== cardIds.length || stops.some(stop => !stop.cardIds.length)) throw new Error('invalid cards')

    // Los UUID no codifican direcciones, clientes ni identificadores comerciales.
    const mapped = stops.map(stop => ({ id: randomUUID(), stop }))
    const byId = new Map<string, OptimizedStop>(mapped.map(item => [item.id, item.stop]))
    const secret = process.env.SUPABASE_SECRET_KEY?.trim()
    if (!secret?.startsWith('sb_secret_')) return fail('CONFIGURATION', 'No está configurada la clave de servidor para optimizar rutas.')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30_000)
    let response: Response
    let payload: Record<string, unknown> | null
    try {
      response = await fetch(EDGE_URL, {
        method: 'POST', headers: { apikey: secret, 'content-type': 'application/json' }, cache: 'no-store', redirect: 'error', signal: controller.signal,
        body: JSON.stringify({ company_id: before.companyId, included_stop_ids: mapped.map(item => item.id), stops: mapped.flatMap(item => item.stop.coordinates ? [{ stop_id: item.id, coordinates: item.stop.coordinates }] : []) }),
      })
      payload = obj(await response.json().catch(() => null))
    } finally { clearTimeout(timer) }
    if (!response.ok || payload?.ok !== true) {
      const code = typeof payload?.code === 'string' && /^[A-Z_]+$/.test(payload.code) ? payload.code : 'EDGE_UNAVAILABLE'
      return fail(code, 'No se pudo optimizar la ruta. Intenta nuevamente.')
    }
    if (payload.company_id !== before.companyId || payload.included_stop_count !== stops.length || !Array.isArray(payload.pending_stop_ids) || !Array.isArray(payload.unassigned_stop_ids) || typeof payload.complete !== 'boolean') throw new Error('invalid response')
    const seen = new Set<string>()
    const translate = (id: unknown): OptimizedStop => {
      if (typeof id !== 'string' || seen.has(id) || !byId.has(id)) throw new Error('invalid stop')
      seen.add(id)
      return byId.get(id)!
    }
    const pending = payload.pending_stop_ids.map(translate)
    const unassigned = payload.unassigned_stop_ids.map(translate)
    if (pending.some(stop => stop.coordinates !== null) || unassigned.some(stop => stop.coordinates === null)) throw new Error('invalid status')
    let route: Extract<OptimizeRouteResult, { ok: true }>['route'] = null
    if (payload.route !== null) {
      const raw = obj(payload.route)
      if (!raw || typeof raw.encoded_geometry !== 'string' || !raw.encoded_geometry.length || raw.encoded_geometry.length > 1_000_000 || raw.geometry_encoding !== 'polyline' || !nonnegative(raw.distance_meters) || !nonnegative(raw.travel_seconds) || !Array.isArray(raw.ordered_stops) || !raw.ordered_stops.length) throw new Error('invalid route')
      const orderedStops = raw.ordered_stops.map((value, index) => {
        const step = obj(value)
        if (!step || step.sequence !== index + 1) throw new Error('invalid sequence')
        const stop = translate(step.stop_id)
        if (!stop.coordinates || !Array.isArray(step.coordinates) || step.coordinates[0] !== stop.coordinates[0] || step.coordinates[1] !== stop.coordinates[1] || step.coordinates.length !== 2) throw new Error('invalid coordinates')
        return { ...stop, sequence: index + 1 }
      })
      route = { encodedGeometry: raw.encoded_geometry, geometryEncoding: 'polyline', distanceMeters: raw.distance_meters, travelSeconds: raw.travel_seconds, orderedStops }
    }
    if (seen.size !== mapped.length || payload.routed_stop_count !== (route?.orderedStops.length ?? 0) || payload.complete !== (pending.length === 0 && unassigned.length === 0)) throw new Error('incomplete response')
    const final = await requireWmsPermission('module.logistica.view')
    if (before.user.id !== final.user.id || before.companyId !== final.companyId || before.effectiveRole !== final.effectiveRole || before.isOperatorBodega !== final.isOperatorBodega) return fail('UNAUTHORIZED', 'La autorización cambió durante la consulta.')
    return { ok: true, complete: payload.complete, stops, pending, unassigned, route }
  } catch {
    return fail('ROUTE_UNAVAILABLE', 'No se pudo autorizar o calcular la ruta; revisa las tarjetas y el límite de 45 paradas.')
  }
}
