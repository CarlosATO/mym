export function makeKey(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function operationIdempotencyKey(sessionId: string, operation: 'start' | 'close'): string {
  if (typeof window === 'undefined') return makeKey()
  const storageKey = `inventarios:op:${sessionId}:${operation}`
  const existing = window.sessionStorage.getItem(storageKey)
  if (existing) return existing
  const key = makeKey()
  window.sessionStorage.setItem(storageKey, key)
  return key
}

export function clearOperationIdempotencyKey(sessionId: string, operation: 'start' | 'close'): void {
  if (typeof window === 'undefined') return
  window.sessionStorage.removeItem(`inventarios:op:${sessionId}:${operation}`)
}
