import React from 'react'
import { formatSettlementStatus } from '../utils/route-settlement-formatters'

export function SettlementStatusBadge({ status }: { status: string }) {
  const getBadgeStyle = () => {
    switch (status) {
      case 'IN_REVIEW':
      case 'CREATED_NOT_REVIEWED':
        return 'bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20'
      case 'SETTLED':
        return 'bg-green-500/10 text-green-600 dark:text-green-400 border border-green-500/20'
      case 'SETTLED_WITH_DIFFERENCE':
        return 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border border-orange-500/20'
      case 'CLOSED':
        return 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20'
      case 'CANCELLED':
        return 'bg-red-500/10 text-red-600 dark:text-red-400 border border-red-500/20'
      case 'PENDING':
      case 'PENDING_SETTLEMENT':
        return 'bg-yellow-500/10 text-yellow-600 dark:text-yellow-400 border border-yellow-500/20'
      default:
        return 'bg-slate-500/10 text-slate-600 dark:text-slate-400 border border-slate-500/20'
    }
  }

  const getLabel = () => {
    if (status === 'PENDING' || status === 'PENDING_SETTLEMENT') return 'Pendiente de rendición'
    if (status === 'CREATED_NOT_REVIEWED') return 'Pendiente de revisar'
    return formatSettlementStatus(status)
  }

  return (
    <span className={`px-2.5 py-1 text-[10px] uppercase font-bold tracking-wider rounded-lg ${getBadgeStyle()}`}>
      {getLabel()}
    </span>
  )
}
