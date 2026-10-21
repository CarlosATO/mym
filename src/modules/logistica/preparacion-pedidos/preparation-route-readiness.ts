export type PreparationRouteReadiness = 'INCIDENTS' | 'READY_TO_INVOICE' | 'BLOCKED'

export type PreparationReadinessLoadState = 'loading' | 'ready' | 'error'

export type PreparationRouteReadinessRow = {
  card_id: string
  company_id: string
  bsale_nv_id: number
  bsale_nv_folio: string | null
  has_open_commercial_incidents: boolean
  open_commercial_incident_count: number
  route_readiness: PreparationRouteReadiness
  bsale_nv_state: number | null
  bsale_nv_found: boolean
}

export function getPreparationColumnId(
  status: string,
  readiness: PreparationRouteReadiness | null | undefined,
): string {
  if (status === 'AUDITED') {
    return readiness === 'READY_TO_INVOICE' ? 'READY_TO_INVOICE' : 'INCIDENTS'
  }
  return status
}

export function isPreparationReadinessTerminal(
  readiness: PreparationRouteReadiness | null | undefined,
): boolean {
  return readiness === 'READY_TO_INVOICE'
    || readiness === 'INCIDENTS'
    || readiness === 'BLOCKED'
}

export function getPreparationReadinessLabel(
  readiness: PreparationRouteReadiness | null | undefined,
  state: PreparationReadinessLoadState,
): string | null {
  if (state === 'loading') return 'Verificando elegibilidad'
  if (state === 'error') return 'Elegibilidad no disponible'
  if (readiness === 'BLOCKED') return 'Bloqueada'
  if (readiness === 'READY_TO_INVOICE') return 'Lista para facturar'
  if (readiness === 'INCIDENTS') return 'Incidencias'
  return 'Elegibilidad no disponible'
}
