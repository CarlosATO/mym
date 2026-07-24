'use client'

import { useCallback, useSyncExternalStore } from 'react'

let currentSection = 'vista-general'
const listeners = new Set<() => void>()

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function getSnapshot() {
  return currentSection
}

export function setSidebarSection(section: string) {
  currentSection = section
  listeners.forEach(l => l())
}

export function useSidebarSection() {
  const activeSection = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const navigate = useCallback((section: string) => {
    setSidebarSection(section)
  }, [])

  return { activeSection, navigate }
}
