import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'

export interface WizardStep {
  id: number
  label: string
}

interface InventoryWizardStepperProps {
  steps: WizardStep[]
  current: number
}

export function InventoryWizardStepper({ steps, current }: InventoryWizardStepperProps) {
  return (
    <ol aria-label="Progreso del asistente" className="flex items-center gap-1 overflow-x-auto py-1">
      {steps.map((step, index) => {
        const state = step.id < current ? 'done' : step.id === current ? 'active' : 'pending'
        return (
          <li key={step.id} className="flex shrink-0 items-center gap-1">
            {index > 0 && <span className="h-px w-4 bg-theme-border" aria-hidden />}
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium',
                state === 'active' && 'border-theme-accent bg-theme-accent/10 text-theme-accent',
                state === 'done' && 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
                state === 'pending' && 'border-theme-border text-theme-text-muted/60'
              )}
            >
              <span
                className={cn(
                  'flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold',
                  state === 'active' && 'bg-theme-accent text-white',
                  state === 'done' && 'bg-emerald-500 text-white',
                  state === 'pending' && 'bg-theme-text/8'
                )}
              >
                {state === 'done' ? <Check className="h-2.5 w-2.5" /> : step.id}
              </span>
              <span className="whitespace-nowrap">{step.label}</span>
            </span>
          </li>
        )
      })}
    </ol>
  )
}
