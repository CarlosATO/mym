'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getSalesOrderPreparationCommercialAlert,
  type PreparationCommercialAlert,
} from '@/app/actions/logistica/sales-order-preparation-commercial'
import type { SalesOrderPreparationCardInfo } from '@/app/actions/logistica/sales-order-preparation'

export const PREPARATION_COMMERCIAL_POLL_INTERVAL_MS = 60_000
const PREPARATION_COMMERCIAL_CACHE_TTL_MS = 30_000
const PREPARATION_COMMERCIAL_MAX_CONCURRENCY = 3

type AlertState = Record<string, PreparationCommercialAlert>

function isOperationalCard(card: SalesOrderPreparationCardInfo): boolean {
  return card.status === 'IN_PREPARATION'
}

export function usePreparationCommercialAlerts(
  cards: SalesOrderPreparationCardInfo[],
  options?: {
    activeCardId?: string | null
    isDrawerOpen?: boolean
  },
): {
  alerts: AlertState
  clearCard: (cardId: string) => void
  checkCardNow: (cardId: string) => Promise<void>
} {
  const isDrawerOpen = options?.isDrawerOpen
  const activeCardId = options?.activeCardId
  const [alerts, setAlerts] = useState<AlertState>({})
  const cardsRef = useRef(cards)
  const checkedAtRef = useRef<Map<string, number>>(new Map())
  const inFlightRef = useRef<Map<string, Promise<void>>>(new Map())
  const mountedRef = useRef(true)

  const cardIdsKey = useMemo(
    () => cards.filter(isOperationalCard).map(card => card.card_id).sort().join(','),
    [cards],
  )

  useEffect(() => {
    cardsRef.current = cards
  }, [cards])

  const checkCard = useCallback(async (card: SalesOrderPreparationCardInfo, force: boolean) => {
    const now = Date.now()
    const checkedAt = checkedAtRef.current.get(card.card_id) ?? 0
    if (!force && now - checkedAt < PREPARATION_COMMERCIAL_CACHE_TTL_MS) return

    const existing = inFlightRef.current.get(card.card_id)
    if (existing) return existing

    // Marcar timestamp de inicio inmediatamente para evitar que renders concurrentes dupliquen llamadas
    checkedAtRef.current.set(card.card_id, now)

    const request = getSalesOrderPreparationCommercialAlert(card.card_id)
      .then(result => {
        checkedAtRef.current.set(card.card_id, Date.now())
        if (!mountedRef.current) return
        setAlerts(current => {
          if (result.error || !result.data) {
            // A confirmed change remains visible until a valid verification supersedes it.
            return current[card.card_id]?.status === 'CHANGED'
              ? current
              : { ...current, [card.card_id]: {
                status: 'UNAVAILABLE',
                detail: result.error ?? 'No se pudo verificar Bsale.',
                verifiedAt: null,
                verificationSource: 'NONE',
                differences: [],
                totalDelta: null,
              } }
          }
          return { ...current, [card.card_id]: result.data }
        })
      })
      .catch(error => {
        checkedAtRef.current.set(card.card_id, Date.now())
        if (!mountedRef.current) return
        setAlerts(current => current[card.card_id]?.status === 'CHANGED'
          ? current
          : { ...current, [card.card_id]: {
            status: 'UNAVAILABLE',
            detail: error instanceof Error ? error.message : 'No se pudo verificar Bsale.',
            verifiedAt: null,
            verificationSource: 'NONE',
            differences: [],
            totalDelta: null,
          } })
      })
      .finally(() => inFlightRef.current.delete(card.card_id))

    inFlightRef.current.set(card.card_id, request)
    return request
  }, [])

  const checkVisibleCards = useCallback(async (force = false) => {
    if (!mountedRef.current || document.visibilityState === 'hidden') return
    const operational = cardsRef.current.filter(isOperationalCard)

    // Si el drawer está abierto, verificamos prioritariamente la tarjeta activa
    // para evitar que consultas masivas de tarjetas ajenas saturen los sockets HTTP
    if (isDrawerOpen && activeCardId) {
      const activeCard = operational.find(c => c.card_id === activeCardId)
      if (activeCard) {
        await checkCard(activeCard, force)
      }
      return
    }

    const candidates = operational
    for (let index = 0; index < candidates.length; index += PREPARATION_COMMERCIAL_MAX_CONCURRENCY) {
      await Promise.all(candidates.slice(index, index + PREPARATION_COMMERCIAL_MAX_CONCURRENCY).map(card => checkCard(card, force)))
    }
  }, [checkCard, isDrawerOpen, activeCardId])

  const clearCard = useCallback((cardId: string) => {
    checkedAtRef.current.set(cardId, Date.now())
    setAlerts(current => {
      if (!(cardId in current)) return current
      const next = { ...current }
      delete next[cardId]
      return next
    })
  }, [])

  const checkCardNow = useCallback(async (cardId: string) => {
    const card = cardsRef.current.find(c => c.card_id === cardId)
    if (card && isOperationalCard(card)) {
      await checkCard(card, true)
    }
  }, [checkCard])

  // Ciclo de vida y polling periódico: no destruye mountedRef en cambios de tarjetas
  useEffect(() => {
    mountedRef.current = true
    void checkVisibleCards(false)
    const interval = window.setInterval(() => { void checkVisibleCards(false) }, PREPARATION_COMMERCIAL_POLL_INTERVAL_MS)
    const handleVisibilityChange = () => {
      // visibilitychange respeta el TTL de 30s sin forzar ráfagas masivas
      if (document.visibilityState === 'visible') void checkVisibleCards(false)
    }
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => {
      mountedRef.current = false
      window.clearInterval(interval)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  }, [checkVisibleCards])

  // Trigger por cambio en conjunto de tarjetas operativas
  useEffect(() => {
    if (!cardIdsKey) return
    void checkVisibleCards(false)
  }, [cardIdsKey, checkVisibleCards])

  useEffect(() => {
    const activeIds = new Set(cards.filter(isOperationalCard).map(card => card.card_id))
    if (activeIds.size === 0) return
    for (const cardId of checkedAtRef.current.keys()) {
      if (!activeIds.has(cardId)) checkedAtRef.current.delete(cardId)
    }
  }, [cards])

  const activeIds = new Set(cards.filter(isOperationalCard).map(card => card.card_id))
  return {
    alerts: Object.fromEntries(Object.entries(alerts).filter(([cardId]) => activeIds.has(cardId))),
    clearCard,
    checkCardNow,
  }
}
