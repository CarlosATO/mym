'use client'

type ReviewContext = {
  selected: {
    transaction_date: string
    operation_description: string
    credit_amount: number | string
    debit_amount: number | string
    balance_after: number | string
    category_name: string | null
    classification_source: string | null
    review_status: string | null
    counterparty: string | null
    classification_note: string | null
  }
  total: number
  pendingCount: number
  classifiedCount: number
  classifiedCategories: Array<{ categoryId: string; name: string; count: number }>
  matchingRules: Array<{ id: string; match_type: string; match_value: string; category_name: string | null }>
}

const MONTHS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

function formatDate(value: string) {
  const [year, month, day] = value.split('-')
  return `${day}-${MONTHS[Number(month) - 1]}-${year}`
}

function formatMoney(value: number | string) {
  return `$${new Intl.NumberFormat('es-CL', { maximumFractionDigits: 0 }).format(Number(value))}`
}

export function FinancialMovementReadOnlyReview({ context }: { context: ReviewContext }) {
  const { selected } = context
  return (
    <div className="space-y-4 p-5 text-xs">
      <div className="border border-[#D1C7BD] bg-white p-4">
        <p className="font-semibold">{selected.operation_description}</p>
        <p className="mt-2">Fecha: {formatDate(selected.transaction_date)} · Haber: {formatMoney(selected.credit_amount)} · Debe: {formatMoney(selected.debit_amount)} · Saldo: {formatMoney(selected.balance_after)}</p>
        <p className="mt-1 text-[#322D29]/60">Categoría: {selected.category_name ?? 'Sin categoría'} · Origen: {selected.classification_source ?? '—'} · Revisión: {selected.review_status ?? '—'}</p>
        <p className="mt-1 text-[#322D29]/60">Contraparte: {selected.counterparty ?? '—'}</p>
        {selected.classification_note && <p className="mt-2 text-[#322D29]/75">Observación: {selected.classification_note}</p>}
      </div>
      <div className="border border-[#AC9C8D] bg-white p-4">
        <p className="font-semibold">Información de clasificación/auditoría</p>
        <p className="mt-1">Coincidencias exactas: {context.total} · {context.pendingCount} pendientes · {context.classifiedCount} clasificados</p>
        {context.classifiedCategories.length > 0 && <div className="mt-3 space-y-1">{context.classifiedCategories.map(category => <p key={category.categoryId}>{category.name}: {category.count} movimientos</p>)}</div>}
      </div>
      {context.matchingRules.length > 0 && <div className="border-t border-[#D1C7BD] pt-4"><p className="font-semibold">Regla existente</p>{context.matchingRules.map(rule => <p key={rule.id} className="mt-2 border border-[#AC9C8D] bg-white p-3">{rule.match_type} · {rule.match_value}<br />→ {rule.category_name ?? 'Sin categoría'}</p>)}</div>}
    </div>
  )
}
