'use client'

import { useSyncExternalStore } from 'react'

function fmtLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function todayLocal(): string {
  return fmtLocal(new Date())
}

function firstOfMonthLocal(): string {
  const now = new Date()
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
}

let state = { dateFrom: firstOfMonthLocal(), dateTo: todayLocal() }
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot() {
  return state
}

export function setDateRange(dateFrom: string, dateTo: string) {
  state = { dateFrom, dateTo }
  listeners.forEach(l => l())
}

export function useDateRange() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
