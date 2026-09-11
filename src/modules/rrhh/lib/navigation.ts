import { Home, UsersRound } from 'lucide-react'
import type { BreadcrumbValue, ModuleNavigation } from '@/components/layout/module-shell-types'

const rrhhBase = '/dashboard/rrhh'

export const rrhhNavigation: ModuleNavigation = {
  home: {
    id: 'inicio',
    label: 'Inicio',
    icon: Home,
    target: { href: rrhhBase },
    active: { pathname: { exact: rrhhBase } },
  },
  groups: [{
    id: 'personal',
    label: 'Gestión de Personas',
    items: [{
      id: 'personal',
      label: 'Personal',
      icon: UsersRound,
      target: { href: `${rrhhBase}/personal` },
      active: { pathname: { prefix: `${rrhhBase}/personal` } },
      visibility: { anyOf: ['rrhh.personal.view', 'system.admin'] },
    }],
  }],
}

export const getRrhhBreadcrumb: BreadcrumbValue = ({ pathname }) =>
  pathname.startsWith(`${rrhhBase}/personal`) ? ['RRHH', 'Personal'] : ['RRHH']
