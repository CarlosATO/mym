import type { LucideIcon } from 'lucide-react'

export type ModuleIdentity = {
  id: string
  label: string
  subtitle?: string
  icon?: LucideIcon
}

export type NavTarget =
  | { href: string }
  | {
      pathname: string
      query?: Record<string, string | undefined>
      preserveQuery?: string[] | ((key: string, value: string) => boolean)
    }

export type NavigationLocation = {
  pathname: string
  searchParams: Pick<URLSearchParams, 'get' | 'has'>
}

export type ActiveMatcher =
  | {
      pathname?: { exact?: string; prefix?: string }
      query?: Record<string, string | string[]>
    }
  | ((location: NavigationLocation) => boolean)

export type VisibilityRule = {
  anyOf?: string[]
  allOf?: string[]
}

export type ModuleNavItem = {
  id: string
  label: string
  icon?: LucideIcon
  target: NavTarget
  active?: ActiveMatcher
  visibility?: VisibilityRule
  disabled?: boolean
  children?: ModuleNavItem[]
}

export type ModuleNavGroup = {
  id: string
  label?: string
  items: ModuleNavItem[]
}

export type ModuleNavigation = {
  home?: ModuleNavItem
  primaryAction?: ModuleNavItem
  groups: ModuleNavGroup[]
}

export type SurfaceMode = 'standard' | 'compact' | 'none'

export type BreadcrumbValue = string[] | ((location: NavigationLocation) => string[])

export function buildNavHref(target: NavTarget, currentSearchParams?: Pick<URLSearchParams, 'get'>) {
  if ('href' in target) return target.href

  const params = new URLSearchParams()
  Object.entries(target.query ?? {}).forEach(([key, value]) => {
    if (value !== undefined) params.set(key, value)
  })
  if (target.preserveQuery && currentSearchParams) {
    const preserveQuery = target.preserveQuery
    const preservedKeys = Array.isArray(target.preserveQuery)
      ? target.preserveQuery
      : Object.keys(target.query ?? {})
    preservedKeys.forEach(key => {
      const value = currentSearchParams.get(key)
      if (value !== null && (Array.isArray(preserveQuery) || preserveQuery(key, value))) params.set(key, value)
    })
  }
  const query = params.toString()
  return query ? `${target.pathname}?${query}` : target.pathname
}

export function matchesActive(location: NavigationLocation, matcher?: ActiveMatcher, target?: NavTarget) {
  if (!matcher) {
    if (!target || !('pathname' in target)) return false
    return location.pathname === target.pathname
  }

  if (typeof matcher === 'function') return matcher(location)

  if (matcher.pathname) {
    const { exact, prefix } = matcher.pathname
    if (exact && location.pathname !== exact) return false
    if (prefix && !location.pathname.startsWith(prefix)) return false
  }

  return Object.entries(matcher.query ?? {}).every(([key, expected]) => {
    const actual = location.searchParams.get(key)
    return Array.isArray(expected) ? expected.includes(actual ?? '') : actual === expected
  })
}

export function isVisible(item: ModuleNavItem, permissions: string[]) {
  const visibility = item.visibility
  if (!visibility) return true
  if (visibility.anyOf && !visibility.anyOf.some(permission => permissions.includes(permission))) return false
  if (visibility.allOf && !visibility.allOf.every(permission => permissions.includes(permission))) return false
  return true
}
