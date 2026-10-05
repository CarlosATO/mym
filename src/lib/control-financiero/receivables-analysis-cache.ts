import type { FinanceReceivablesAnalysis } from './finance-api'

/**
 * Cache de análisis CxC en memoria (por sesión de cliente).
 *
 * Clave: company_id | year | period
 * - Deduplica requests simultáneos (promise in-flight reuse).
 * - No persiste entre recargas de página (sin LocalStorage).
 * - Scoped correctamente por empresa y año para evitar mezcla de datos.
 */

export type ReceivablesAnalysisCacheKey = {
  companyId: string
  year: number
  period: number
}

function serialize(key: ReceivablesAnalysisCacheKey): string {
  return `${key.companyId}|${key.year}|${key.period}`
}

export class ReceivablesAnalysisCache {
  private readonly values = new Map<string, FinanceReceivablesAnalysis>()
  private readonly pending = new Map<string, Promise<FinanceReceivablesAnalysis>>()

  get(key: ReceivablesAnalysisCacheKey): FinanceReceivablesAnalysis | undefined {
    return this.values.get(serialize(key))
  }

  /**
   * Devuelve el valor cacheado si existe.
   * Si hay un request en vuelo, lo reutiliza (sin duplicar).
   * Si no, ejecuta loader() y almacena el resultado.
   */
  load(
    key: ReceivablesAnalysisCacheKey,
    loader: () => Promise<FinanceReceivablesAnalysis>,
  ): Promise<FinanceReceivablesAnalysis> {
    const cacheKey = serialize(key)

    const cached = this.values.get(cacheKey)
    if (cached) return Promise.resolve(cached)

    const inFlight = this.pending.get(cacheKey)
    if (inFlight) return inFlight

    const request = loader()
      .then((data) => {
        this.values.set(cacheKey, data)
        this.pending.delete(cacheKey)
        return data
      })
      .catch((error) => {
        this.pending.delete(cacheKey)
        throw error
      })

    this.pending.set(cacheKey, request)
    return request
  }

  has(key: ReceivablesAnalysisCacheKey): boolean {
    return this.values.has(serialize(key))
  }

  isLoading(key: ReceivablesAnalysisCacheKey): boolean {
    return this.pending.has(serialize(key))
  }

  /** Limpia todo el cache (por ejemplo, al cambiar de empresa o año). */
  clear() {
    this.values.clear()
    this.pending.clear()
  }
}
