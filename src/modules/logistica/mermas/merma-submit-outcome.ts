import type { MermaWorkflowResult } from '@/lib/integraciones/bsale-mermas-workflow-core'

export type MermaSubmitDecision = {
  cleanupEvidence: boolean
  message?: string
  destination?: string
}

export function resolveMermaSubmitOutcome(result: MermaWorkflowResult): MermaSubmitDecision {
  switch (result.outcome) {
    case 'FINALIZED':
      return { cleanupEvidence: false, destination: '/dashboard/logistica/mermas' }
    case 'NOT_CREATED':
      return { cleanupEvidence: true, message: result.error }
    case 'BSALE_FAILED':
      return {
        cleanupEvidence: false,
        destination: `/dashboard/logistica/mermas/${result.requestId}`,
        message: `La solicitud ${result.requestCode} fue creada, pero Bsale rechazó el movimiento de Merma.`,
      }
    case 'RECONCILIATION_REQUIRED':
      return {
        cleanupEvidence: false,
        destination: `/dashboard/logistica/mermas/${result.requestId}`,
        message: `La solicitud ${result.requestCode} fue creada. El movimiento en Bsale requiere revisión antes de continuar.`,
      }
    case 'SENDING':
      return {
        cleanupEvidence: false,
        destination: `/dashboard/logistica/mermas/${result.requestId}`,
        message: `La solicitud ${result.requestCode} fue creada. El movimiento en Bsale sigue en proceso y quedó pendiente de revisión.`,
      }
    case 'LOCAL_APPLICATION_PENDING':
      return {
        cleanupEvidence: false,
        destination: `/dashboard/logistica/mermas/${result.requestId}`,
        message: 'La Merma fue creada en Bsale, pero PetGroup no pudo completar el ingreso local. La solicitud quedó pendiente de regularización.',
      }
  }
}
