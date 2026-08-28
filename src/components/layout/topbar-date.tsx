'use client'

import { CalendarDays } from 'lucide-react'
import { Popover, PopoverContent, PopoverTitle, PopoverTrigger } from '@/components/ui/popover'
import { OPERATIONAL_TIME_ZONE, todayInSantiago } from '@/lib/datetime'
import { cn } from '@/lib/utils'

const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre']
const WEEKDAYS = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sa', 'Do']
const WEEKDAY_NAMES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado']

function parseCivilDate(value: string) {
  const [year, month, day] = value.split('-').map(Number)
  return { year, month, day }
}

function isLeapYear(year: number) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

function daysInMonth(year: number, month: number) {
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

function weekdayFromCivilDate(year: number, month: number, day: number) {
  const offsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const adjustedYear = month < 3 ? year - 1 : year
  return (adjustedYear + Math.floor(adjustedYear / 4) - Math.floor(adjustedYear / 100) + Math.floor(adjustedYear / 400) + offsets[month - 1] + day) % 7
}

function formatDateLabel(value: string) {
  const { year, month, day } = parseCivilDate(value)
  return `${WEEKDAY_NAMES[weekdayFromCivilDate(year, month, day)]} ${day} de ${MONTHS[month - 1]}`
}

export function TopbarDate() {
  const today = todayInSantiago()
  const { year, month, day } = parseCivilDate(today)
  const firstDayOffset = (weekdayFromCivilDate(year, month, 1) + 6) % 7
  const cells = Array.from({ length: firstDayOffset + daysInMonth(year, month) }, (_, index) => {
    return index < firstDayOffset ? null : index - firstDayOffset + 1
  })

  return (
    <Popover>
      <PopoverTrigger
        className="hidden h-8 shrink-0 items-center gap-1.5 rounded-md border border-theme-border/70 bg-theme-surface/50 px-2 text-[10px] font-semibold capitalize text-theme-text-muted transition-colors hover:bg-theme-text/5 hover:text-theme-text sm:flex"
        aria-label={`Abrir calendario, ${formatDateLabel(today)}`}
      >
        <CalendarDays className="h-3.5 w-3.5 text-theme-accent" />
        <span>{formatDateLabel(today)}</span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-64 border border-theme-border bg-theme-surface p-3 text-theme-text">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-theme-text-accent">Calendario civil</p>
            <PopoverTitle className="mt-0.5 text-sm font-semibold capitalize text-theme-text">{MONTHS[month - 1]} {year}</PopoverTitle>
          </div>
          <span className="text-[9px] font-medium text-theme-text-muted/70">{OPERATIONAL_TIME_ZONE}</span>
        </div>
        <div className="grid grid-cols-7 gap-y-1 text-center" role="grid" aria-label={`Calendario de ${MONTHS[month - 1]} ${year}`}>
          {WEEKDAYS.map(weekday => <span key={weekday} className="text-[9px] font-semibold uppercase text-theme-text-muted/55">{weekday}</span>)}
          {cells.map((cell, index) => {
            const isToday = cell === day
            return (
              <span
                key={`${month}-${index}`}
                role="gridcell"
                aria-current={isToday ? 'date' : undefined}
                className={cn('mx-auto flex h-7 w-7 items-center justify-center rounded-full text-[11px] text-theme-text-muted', isToday && 'bg-theme-accent font-bold text-white shadow-sm shadow-theme-accent/25')}
              >
                {cell ?? ''}
              </span>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
