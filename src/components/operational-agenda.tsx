'use client'

import { useState } from 'react'
import { ArrowRight, CalendarDays, ChevronRight, Clock3, MapPin, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { OPERATIONAL_TIME_ZONE } from '@/lib/datetime'

type DispatchAssignment = {
  weekday: number
  normalized_city: string
}

type DispatchSummary = {
  name: string
  cutoffTime: string
  assignments: DispatchAssignment[]
} | null

type OperationalAgendaProps = {
  today: string
  dispatch: DispatchSummary
  dispatchRoute: string
}

const WEEKDAYS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do']
const MONTHS = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre']
const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

function parseCivilDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function pad(value: number) {
  return String(value).padStart(2, '0')
}

function formatDateKey(year: number, month: number, day: number) {
  return `${year}-${pad(month)}-${pad(day)}`
}

function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate()
}

function weekdayFromCivilDate(year: number, month: number, day: number) {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const adjustedYear = month < 3 ? year - 1 : year
  return (adjustedYear + Math.floor(adjustedYear / 4) - Math.floor(adjustedYear / 100) + Math.floor(adjustedYear / 400) + offsets[month - 1] + day) % 7
}

function addCivilDays(value: string, amount: number) {
  const { year, month, day } = parseCivilDate(value)
  const date = new Date(Date.UTC(year, month - 1, day + amount))
  return formatDateKey(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate())
}

function monthLabel(year: number, month: number) {
  return `${MONTHS[month - 1]} ${year}`
}

function dateLabel(value: string) {
  const { year, month, day } = parseCivilDate(value)
  const weekday = weekdayFromCivilDate(year, month, day)
  return `${WEEKDAY_NAMES[weekday]} ${day} de ${MONTHS[month - 1].toLowerCase()}`
}

function MonthGrid({ year, month, today, compact = false }: { year: number; month: number; today: string; compact?: boolean }) {
  const totalDays = daysInMonth(year, month)
  const firstDay = (weekdayFromCivilDate(year, month, 1) + 6) % 7
  const cells = Array.from({ length: firstDay + totalDays }, (_, index) => index < firstDay ? null : index - firstDay + 1)

  return (
    <div>
      <div className={cn('mb-2 font-semibold text-theme-text', compact ? 'text-xs' : 'text-sm')}>{monthLabel(year, month)}</div>
      <div className="grid grid-cols-7 gap-y-1 text-center">
        {WEEKDAYS.map(day => <span key={day} className="text-[9px] font-semibold uppercase text-theme-text-muted/55">{day}</span>)}
        {cells.map((day, index) => {
          const dateKey = day ? formatDateKey(year, month, day) : ''
          const isToday = dateKey === today
          return (
            <span key={`${month}-${index}`} className={cn('mx-auto flex items-center justify-center rounded-full text-theme-text-muted', compact ? 'h-6 w-6 text-[10px]' : 'h-7 w-7 text-[11px]', isToday && 'bg-theme-accent font-bold text-white shadow-sm shadow-theme-accent/25')}>
              {day ?? ''}
            </span>
          )
        })}
      </div>
    </div>
  )
}

function getUpcomingDates(today: string, assignments: DispatchAssignment[]) {
  const scheduledWeekdays = [...new Set(assignments.map(assignment => assignment.weekday))]
  return Array.from({ length: 14 }, (_, offset) => addCivilDays(today, offset))
    .filter(date => {
      const parts = parseCivilDate(date)
      const weekday = weekdayFromCivilDate(parts.year, parts.month, parts.day)
      return scheduledWeekdays.includes(weekday === 0 ? 7 : weekday)
    })
    .slice(0, 5)
}

export function OperationalAgenda({ today, dispatch, dispatchRoute }: OperationalAgendaProps) {
  const [annualOpen, setAnnualOpen] = useState(false)
  const todayParts = parseCivilDate(today)
  const upcomingDates = dispatch ? getUpcomingDates(today, dispatch.assignments) : []
  const visibleUpcomingDates = upcomingDates.slice(0, 3)
  const additionalUpcomingCount = Math.max(0, upcomingDates.length - visibleUpcomingDates.length)

  return (
    <section className="space-y-3">
      <div className="px-1">
        <h2 className="text-lg font-semibold tracking-tight text-theme-text">Agenda operacional</h2>
      </div>

      <div className="flex flex-col gap-3">
        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-theme-text-accent">Calendario civil</p>
              <p className="mt-1 text-sm font-semibold text-theme-text">{dateLabel(today)}</p>
            </div>
            <CalendarDays className="h-4 w-4 text-theme-text-accent" />
          </div>
          <MonthGrid year={todayParts.year} month={todayParts.month} today={today} compact />
          <div className="mt-2 flex items-center justify-between border-t border-theme-border/70 pt-2">
            <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-theme-text-accent"><span className="h-1.5 w-1.5 rounded-full bg-theme-accent" /> Hoy</span>
            <button type="button" onClick={() => setAnnualOpen(true)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-theme-text-accent transition-colors hover:text-theme-accent-hover">
              Ver calendario anual <ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-theme-border bg-theme-surface p-3 shadow-sm">
          <div className="mb-2 flex items-start justify-between gap-3">
            <div>
              <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-sky-600 dark:text-sky-300">Operación WMS</p>
              <h3 className="mt-1 text-sm font-semibold text-theme-text">Próximos despachos</h3>
            </div>
            <Clock3 className="h-4 w-4 text-sky-600 dark:text-sky-300" />
          </div>

          {visibleUpcomingDates.length > 0 && dispatch ? (
            <div className="space-y-1">
              {visibleUpcomingDates.map(date => {
                const parts = parseCivilDate(date)
                const weekday = weekdayFromCivilDate(parts.year, parts.month, parts.day)
                const assignments = dispatch.assignments.filter(assignment => assignment.weekday === weekday || assignment.weekday === (weekday === 0 ? 7 : weekday))
                return (
                  <div key={date} className="flex items-center justify-between gap-2 rounded-lg border border-theme-border/70 bg-theme-text/[0.018] px-2 py-1.5">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="flex h-7 w-7 shrink-0 flex-col items-center justify-center rounded-md bg-sky-500/10 text-sky-700 dark:text-sky-300">
                        <span className="text-[8px] font-bold uppercase">{WEEKDAY_NAMES[weekday].slice(0, 3)}</span>
                        <span className="text-[11px] font-bold leading-none">{parts.day}</span>
                      </span>
                      <div className="min-w-0">
                        <p className="truncate text-[11px] font-semibold capitalize text-theme-text">{dateLabel(date)}</p>
                        <p className="mt-0.5 flex items-center gap-1 text-[9px] text-theme-text-muted/65"><MapPin className="h-2.5 w-2.5" /> {assignments.length} {assignments.length === 1 ? 'comuna' : 'comunas'} · {dispatch.name}</p>
                      </div>
                    </div>
                    <span className="shrink-0 text-[9px] font-medium tabular-nums text-theme-text-muted/65">{dispatch.cutoffTime}</span>
                  </div>
                )
              })}
              {additionalUpcomingCount > 0 && <p className="pt-1 text-[10px] text-theme-text-muted/55">+{additionalUpcomingCount} próximas jornadas</p>}
            </div>
          ) : (
            <div className="flex min-h-[120px] items-center justify-center rounded-lg border border-dashed border-theme-border bg-theme-text/[0.018] px-4 text-center">
              <p className="max-w-xs text-xs leading-relaxed text-theme-text-muted/65">No hay despachos programados próximos</p>
            </div>
          )}

          <a href={dispatchRoute} className="mt-2 inline-flex items-center gap-1.5 text-[10px] font-semibold text-sky-700 transition-colors hover:text-sky-500 dark:text-sky-300 dark:hover:text-sky-200">
            Ver calendario de despacho <ArrowRight className="h-3.5 w-3.5" />
          </a>
        </div>
      </div>

      {annualOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-theme-bg/70 p-4 backdrop-blur-sm" role="presentation" onClick={() => setAnnualOpen(false)}>
          <div role="dialog" aria-modal="true" aria-labelledby="annual-calendar-title" className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-2xl border border-theme-border bg-theme-surface p-4 shadow-2xl sm:p-6" onClick={event => event.stopPropagation()}>
            <div className="mb-5 flex items-center justify-between gap-3">
              <div>
                <p className="text-[9px] font-bold uppercase tracking-[0.18em] text-theme-text-accent">Calendario civil · {OPERATIONAL_TIME_ZONE}</p>
                <h2 id="annual-calendar-title" className="mt-1 text-lg font-semibold text-theme-text">Calendario anual {todayParts.year}</h2>
              </div>
              <button type="button" onClick={() => setAnnualOpen(false)} aria-label="Cerrar calendario anual" className="rounded-lg p-2 text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text"><X className="h-4 w-4" /></button>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
              {MONTHS.map((_, index) => <MonthGrid key={index} year={todayParts.year} month={index + 1} today={today} compact />)}
            </div>
          </div>
        </div>
      )}
    </section>
  )
}
