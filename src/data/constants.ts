import type { TicketSeverity, TicketStatus, TicketSystem } from '../types'

export const TICKET_SYSTEMS: TicketSystem[] = ['Jira', 'Azure DevOps']

export const TICKET_SEVERITIES: TicketSeverity[] = ['Low', 'Medium', 'High']

export const TICKET_STATUSES: TicketStatus[] = ['Open', 'Fixed - Verify Pending', 'Backlog', 'Closed']

export const FAILURE_REASONS = ['Infra', 'Script', 'Env', 'Data']

export const CLOUD_COLOR: Record<string, string> = {
  AWS: 'var(--aws)',
  Azure: 'var(--azure)',
  GCP: 'var(--gcp)',
}

// Groups come from Symphony and aren't limited to the three clouds above
// (a project-based group like "Phoenix" is just as valid) — this gives
// any group a stable, distinct color without hardcoding its name.
const GROUP_FALLBACK_COLORS = ['#9333EA', '#DB2777', '#0EA5E9', '#65A30D', '#EA580C']
export function getGroupColor(group: string | undefined | null): string {
  if (!group) return GROUP_FALLBACK_COLORS[0]
  if (CLOUD_COLOR[group]) return CLOUD_COLOR[group]
  let hash = 0
  for (let i = 0; i < group.length; i++) hash = (hash * 31 + group.charCodeAt(i)) >>> 0
  return GROUP_FALLBACK_COLORS[hash % GROUP_FALLBACK_COLORS.length]
}
