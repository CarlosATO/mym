import type { ReactNode } from 'react'

export type EmployeeSectionProps = {
  title: string
  children: ReactNode
  className?: string
}

export function EmployeeSection({ title, children, className = '' }: EmployeeSectionProps) {
  return <section className={`rounded-lg border border-theme-border/80 p-4 ${className}`}><h2 className="mb-3 border-b border-theme-border pb-2 text-sm font-semibold text-theme-text">{title}</h2>{children}</section>
}

export function EmployeeDetails({ rows }: { rows: [string, string | null][] }) {
  return <dl className="grid gap-2 sm:grid-cols-2">{rows.map(([label, value]) => <div key={label}><dt className="text-[10px] font-bold uppercase tracking-wider text-theme-text-muted">{label}</dt><dd className="mt-0.5 text-sm text-theme-text">{value || '—'}</dd></div>)}</dl>
}
