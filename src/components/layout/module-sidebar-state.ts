export type ViewportMode = 'mobile' | 'medium' | 'wide'

export type SidebarStateInput = {
  viewport: ViewportMode
  desktopCollapsed: boolean
  temporaryExpanded: boolean
  mobileOpen: boolean
}

export type SidebarState = {
  expanded: boolean
  reserveCollapsed: boolean
  overlay: boolean
}

export function resolveSidebarState({
  viewport,
  desktopCollapsed,
  temporaryExpanded,
  mobileOpen,
}: SidebarStateInput): SidebarState {
  if (viewport === 'mobile') {
    return {
      expanded: mobileOpen,
      reserveCollapsed: true,
      overlay: mobileOpen,
    }
  }

  if (viewport === 'wide') {
    return {
      expanded: !desktopCollapsed,
      reserveCollapsed: desktopCollapsed,
      overlay: false,
    }
  }

  return {
    expanded: temporaryExpanded,
    reserveCollapsed: true,
    overlay: temporaryExpanded,
  }
}
