/** Configuración de adjuntos de rendición de rutas.
 *  Importable tanto en client components como en server actions.
 */
export const SETTLEMENT_ATTACHMENT_BUCKET = 'rendicion-rutas'
export const SETTLEMENT_ATTACHMENT_MAX_SIZE = 10 * 1024 * 1024 // 10 MB
export const SETTLEMENT_ATTACHMENT_ALLOWED_MIMES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
] as const
