/**
 * Resolución multiempresa de credenciales BSale.
 *
 * Reglas:
 * - CAYLO  → BSALE_ACCESS_TOKEN_CAYLO (fallback legacy: BSALE_ACCESS_TOKEN)
 * - AMIMASCOTA → BSALE_ACCESS_TOKEN_AMIMASCOTA (SIN fallback a CAYLO)
 * - company_id desconocido → error explícito
 * - token ausente → error explícito
 *
 * NUNCA loguear ni exponer tokens. Los mensajes de error indican solo el nombre
 * de la variable faltante, no su valor.
 */

const BSALE_DEFAULT_BASE_URL = 'https://api.bsale.cl/v1'

export const KNOWN_COMPANY_IDS = {
  CAYLO: 'd1000000-0000-0000-0000-000000000001',
  AMIMASCOTA: 'd3000000-0000-0000-0000-000000000003',
} as const

export type KnownCompanyId = (typeof KNOWN_COMPANY_IDS)[keyof typeof KNOWN_COMPANY_IDS]

export interface BsaleCompanyConfig {
  baseUrl: string
  accessToken: string
  companyId: string
}

/**
 * Devuelve la configuración BSale para el company_id dado.
 *
 * Falla explícitamente si:
 * - company_id es desconocido
 * - falta el token para la empresa solicitada
 *
 * NO realiza fallback silencioso entre empresas.
 */
export function getBsaleConfigForCompany(companyId: string): BsaleCompanyConfig {
  const baseUrl =
    process.env.BSALE_API_BASE_URL?.trim() || BSALE_DEFAULT_BASE_URL

  switch (companyId) {
    case KNOWN_COMPANY_IDS.CAYLO: {
      // Intenta el token específico de CAYLO; cae en el legado BSALE_ACCESS_TOKEN
      // solo si BSALE_ACCESS_TOKEN_CAYLO no está definido (compatibilidad de transición).
      const accessToken =
        process.env.BSALE_ACCESS_TOKEN_CAYLO?.trim() ||
        process.env.BSALE_ACCESS_TOKEN?.trim()

      if (!accessToken) {
        throw new Error(
          'BSale configuration missing for company CAYLO: ' +
          'BSALE_ACCESS_TOKEN_CAYLO (or legacy BSALE_ACCESS_TOKEN) not set'
        )
      }
      return { baseUrl, accessToken, companyId }
    }

    case KNOWN_COMPANY_IDS.AMIMASCOTA: {
      // AMIMASCOTA NO tiene fallback al token de CAYLO.
      const accessToken = process.env.BSALE_ACCESS_TOKEN_AMIMASCOTA?.trim()
      if (!accessToken) {
        throw new Error(
          'BSale configuration missing for company AMIMASCOTA: ' +
          'BSALE_ACCESS_TOKEN_AMIMASCOTA not set'
        )
      }
      return { baseUrl, accessToken, companyId }
    }

    default:
      throw new Error(
        `BSale configuration missing for company: unknown company_id "${companyId}". ` +
        'Only CAYLO and AMIMASCOTA are configured.'
      )
  }
}

/**
 * Devuelve los headers HTTP necesarios para llamar a la API de BSale,
 * resolviendo el token según company_id.
 */
export function getBsaleHeadersForCompany(
  companyId: string
): Record<string, string> {
  const { accessToken } = getBsaleConfigForCompany(companyId)
  return {
    access_token: accessToken,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}
