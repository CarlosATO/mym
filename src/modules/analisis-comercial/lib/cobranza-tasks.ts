import type { CobranzaClient } from './cobranza-metrics'

export type CobranzaTaskUrgency = 'OVERDUE' | 'TODAY' | 'NONE'
export type CobranzaTaskType = 'COMMITMENT' | 'FOLLOW_UP'

export type CobranzaWorkflow = {
  stage?: string | null
  commitment_at?: string | null
  commitment_amount?: number | string | null
  next_action_at?: string | null
}

export type CobranzaTask = {
  id: string
  clientId: number
  clientName: string
  type: CobranzaTaskType
  date: string
  urgency: Exclude<CobranzaTaskUrgency, 'NONE'>
  amount: number | null
}

export function civilDate(value: string | null | undefined): string | null {
  if (!value) return null
  const match = value.match(/^\d{4}-\d{2}-\d{2}/)
  return match?.[0] ?? null
}

export function todayInChile(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.filter(part => part.type !== 'literal').map(part => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}

export function taskUrgency(date: string | null | undefined, today: string): CobranzaTaskUrgency {
  const civil = civilDate(date)
  if (!civil || civil > today) return 'NONE'
  return civil === today ? 'TODAY' : 'OVERDUE'
}

const urgencyRank: Record<CobranzaTaskUrgency, number> = { OVERDUE: 0, TODAY: 1, NONE: 2 }

function amountOrNull(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null
  const amount = Number(value)
  return Number.isFinite(amount) ? amount : null
}

export function buildCobranzaTasks(
  clients: CobranzaClient[],
  workflows: Record<number, CobranzaWorkflow>,
  today: string,
): CobranzaTask[] {
  const tasks: CobranzaTask[] = []
  for (const client of clients) {
    const workflow = workflows[client.clientId]
    if (!workflow || workflow.stage === 'CLOSED') continue
    const candidates: Array<{ type: CobranzaTaskType; date: string | null; amount: number | null }> = [
      { type: 'COMMITMENT', date: civilDate(workflow.commitment_at), amount: amountOrNull(workflow.commitment_amount) },
      { type: 'FOLLOW_UP', date: civilDate(workflow.next_action_at), amount: null },
    ]
    for (const candidate of candidates) {
      const urgency = taskUrgency(candidate.date, today)
      if (candidate.date && urgency !== 'NONE') {
        tasks.push({
          id: `${client.clientId}-${candidate.type}-${candidate.date}`,
          clientId: client.clientId,
          clientName: client.name,
          type: candidate.type,
          date: candidate.date,
          urgency,
          amount: candidate.amount,
        })
      }
    }
  }
  return sortCobranzaTasks(tasks, clients)
}

export function sortCobranzaTasks(tasks: CobranzaTask[], clients: CobranzaClient[] = []): CobranzaTask[] {
  const clientById = new Map(clients.map(client => [client.clientId, client]))
  return [...tasks].sort((left, right) => {
    const urgency = urgencyRank[left.urgency] - urgencyRank[right.urgency]
    if (urgency !== 0) return urgency
    const leftClient = clientById.get(left.clientId)
    const rightClient = clientById.get(right.clientId)
    const commercial = (rightClient?.overdueAmount ?? 0) - (leftClient?.overdueAmount ?? 0)
      || (rightClient?.oldestDaysOverdue ?? 0) - (leftClient?.oldestDaysOverdue ?? 0)
      || left.clientName.localeCompare(right.clientName, 'es')
    if (left.urgency === 'OVERDUE') return left.date.localeCompare(right.date) || commercial
    return commercial || left.date.localeCompare(right.date)
  })
}

export function effectivePriority(
  priority: CobranzaClient['priority'],
  task: CobranzaTask | null | undefined,
): CobranzaClient['priority'] {
  return task ? 'Alta' : priority
}

export function taskForClient(clientId: number, tasks: CobranzaTask[]): CobranzaTask | null {
  return tasks
    .filter(task => task.clientId === clientId)
    .sort((left, right) => urgencyRank[left.urgency] - urgencyRank[right.urgency] || left.date.localeCompare(right.date))[0] ?? null
}

export function prioritizeCobranzaColumn(
  clients: CobranzaClient[],
  workflows: Record<number, CobranzaWorkflow>,
  today: string,
): CobranzaClient[] {
  const tasks = buildCobranzaTasks(clients, workflows, today)
  const byClient = new Map<number, CobranzaTask>()
  for (const task of tasks) {
    const current = byClient.get(task.clientId)
    if (!current || urgencyRank[task.urgency] < urgencyRank[current.urgency] || (task.urgency === 'OVERDUE' && task.date < current.date)) byClient.set(task.clientId, task)
  }
  return clients.map((client, index) => ({ client, index, task: byClient.get(client.clientId) })).sort((left, right) => {
    const leftRank = left.task ? urgencyRank[left.task.urgency] : urgencyRank.NONE
    const rightRank = right.task ? urgencyRank[right.task.urgency] : urgencyRank.NONE
    if (leftRank !== rightRank) return leftRank - rightRank
    if (left.task?.urgency === 'OVERDUE' && right.task?.urgency === 'OVERDUE') return left.task.date.localeCompare(right.task.date) || left.index - right.index
    return left.index - right.index
  }).map(entry => entry.client)
}
