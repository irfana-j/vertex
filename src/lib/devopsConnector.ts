import type { AzureDevOpsIntegrationEntry, FollowUpResult, TicketBoardStatus, TicketStatus, TicketSystem } from '../types'

// Stands in for the DevOps board's REST API (Azure DevOps Boards / Jira —
// whichever `system` a ticket names).
//
// Azure DevOps calls go through this app's own backend (server/, see
// azureDevOps.ts) — same reasoning as the Symphony proxy: the personal
// access token lives server-side only and is never sent to the browser.
// This app can link several Azure DevOps organizations at once (see
// Settings), so every call below is scoped by `organization` rather than
// assuming a single global one. Jira isn't wired up that way yet — it
// still calls Jira directly from the browser using VITE_JIRA_* env vars,
// same as before, and falls back to mock data when unconfigured.
//
// The board is the source of truth for ticket status once a ticket is
// synced — this app's own `status` field is a cached copy that "Sync from
// board" (or bulk sync) refreshes, not something meant to drift forever.
// Azure DevOps's own workflow states (New, Active, Resolved, Closed, ...)
// don't map onto this app's own small status set, so syncing only ever
// pushes a ticket to 'Closed' once the board reaches a terminal state (or
// back to 'Open' if it was reopened there) — it never overwrites a Backlog
// / Fixed - Verify Pending triage call this app's own ticket statuses make
// that the board has no equivalent of.
const JIRA_BASE_URL = import.meta.env.VITE_JIRA_BASE_URL
const JIRA_EMAIL = import.meta.env.VITE_JIRA_EMAIL
const JIRA_API_TOKEN = import.meta.env.VITE_JIRA_API_TOKEN

const JIRA_CONFIGURED = Boolean(JIRA_BASE_URL)

function jiraAuthHeader(): string {
  return `Basic ${btoa(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`)}`
}

const LATENCY_MS = 300
const day = 86400000
const now = Date.now()

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS))
}

function boardUrl(system: TicketSystem, ticketId: string, organization: string | null): string {
  if (system === 'Jira') return `https://your-org.atlassian.net/browse/${ticketId}`
  return `https://dev.azure.com/${organization || 'your-org'}/_workitems/edit/${ticketId.replace(/\D/g, '') || ticketId}`
}

export async function listAzureDevOpsIntegrations(): Promise<AzureDevOpsIntegrationEntry[]> {
  const res = await fetch('/api/integrations/azuredevops', { credentials: 'include' })
  // Without this check, a transient failure here (a 401 racing right after
  // login, a brief backend restart) returned an error body shaped nothing
  // like { integrations }, so `data.integrations` was silently `undefined`
  // — callers that didn't guard against that (TicketForm's "Org" picker,
  // notably) threw inside an unawaited `.then()` with no `.catch`, which
  // just silently dropped the whole org list instead of surfacing anything.
  if (!res.ok) throw new Error(`Failed to load Azure DevOps integrations (${res.status})`)
  const data = (await res.json()) as { integrations: AzureDevOpsIntegrationEntry[] }
  return data.integrations
}

export async function upsertAzureDevOpsIntegration(input: {
  organization: string
  project: string
  personalAccessToken?: string
}): Promise<void> {
  const res = await fetch('/api/integrations/azuredevops', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Save failed (${res.status})`)
  }
}

export async function deleteAzureDevOpsIntegration(organization: string): Promise<void> {
  await fetch(`/api/integrations/azuredevops/${encodeURIComponent(organization)}`, { method: 'DELETE', credentials: 'include' })
}

export async function testAzureDevOpsIntegration(input: {
  organization: string
  project: string
  personalAccessToken?: string
}): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch('/api/integrations/azuredevops/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  })
  return res.json()
}

// Once a board reaches a terminal state, this app's own ticket is
// considered Closed — reopening it on the board flips it back to Open.
// Anything else (New, Active, a custom workflow state) leaves the current
// status alone rather than guessing at a mapping that doesn't exist. Shared
// by both Azure DevOps (isTerminalAdoState) and Jira (statusCategory.key)
// below, each of which has its own way of deciding "terminal" from a
// workflow that can otherwise be named anything a project wants.
function nextStatusFromBoard(isTerminal: boolean, currentStatus: TicketStatus): TicketStatus {
  if (isTerminal) return 'Closed'
  if (currentStatus === 'Closed') return 'Open'
  return currentStatus
}

async function getAzureDevOpsWorkItemStatus(organization: string, ticketId: string, currentStatus: TicketStatus): Promise<TicketBoardStatus> {
  const res = await fetch(`/api/azuredevops/${encodeURIComponent(organization)}/workitems/${encodeURIComponent(ticketId)}`, {
    credentials: 'include',
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Azure DevOps sync failed (${res.status})`)
  }
  const data = (await res.json()) as { state: string; isTerminal: boolean; title: string; assignee: string; lastActivityAt: number; url: string }
  return {
    status: nextStatusFromBoard(data.isTerminal, currentStatus),
    // The board's own literal column name (e.g. "To Do", "Doing", "Done")
    // — every project can name its workflow states differently, so this is
    // shown as-is rather than forced into this app's own four-value status.
    boardState: data.state,
    assignee: data.assignee,
    summary: data.title,
    lastActivityAt: data.lastActivityAt,
    url: data.url,
  }
}

async function postAzureDevOpsComment(organization: string, ticketId: string, text: string): Promise<FollowUpResult> {
  const res = await fetch(`/api/azuredevops/${encodeURIComponent(organization)}/workitems/${encodeURIComponent(ticketId)}/comment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ text }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Azure DevOps comment failed (${res.status})`)
  }
  const data = (await res.json()) as { postedAt: number; url: string }
  return { ok: true, postedAt: data.postedAt, text, url: data.url }
}

// The board's live state for tickets seeded in this app — only used when
// neither Azure DevOps nor Jira is configured, so "Sync from board" still
// has something real to demonstrate pulling in.
const BOARD_STATE: Record<string, { status: TicketStatus; assignee: string; summary: string; lastActivityAt: number }> = {
  'TCKT-4821': { status: 'Fixed - Verify Pending', assignee: 'R. Menon', summary: 'Quota exceeded provisioning managed disk in westus2', lastActivityAt: now - 2 * day },
  'TCKT-4756': { status: 'Backlog', assignee: 'A. Krishnan', summary: 'Template not yet automated', lastActivityAt: now - 9 * day },
  'TCKT-5001': { status: 'Open', assignee: 'Cloud DevOps', summary: 'Retention policy conflict on existing prod-backup vault', lastActivityAt: now - 11 * day },
}

// Whether a ticket actually has a real board behind it to sync status
// from — an Azure DevOps ticket needs a linked organization (one logged
// before multi-org support existed, or created with "No board link
// (manual)", has none), and a Jira one needs this deployment's Jira env
// vars configured. Anything else is a purely local/manual ticket with
// nothing to sync against, so its status has to stay hand-editable instead
// of presenting a "live from the board" status that isn't backed by one.
export function canSyncFromBoard(ticket: { system: TicketSystem; organization: string | null }): boolean {
  if (ticket.system === 'Azure DevOps') return Boolean(ticket.organization)
  if (ticket.system === 'Jira') return JIRA_CONFIGURED
  return false
}

export async function getTicketStatus({
  system,
  ticketId,
  organization,
  currentStatus,
}: {
  system: TicketSystem
  ticketId: string
  organization: string | null
  currentStatus: TicketStatus
}): Promise<TicketBoardStatus> {
  if (system === 'Azure DevOps') {
    if (!organization) throw new Error('This ticket has no linked Azure DevOps organization to sync against.')
    return getAzureDevOpsWorkItemStatus(organization, ticketId, currentStatus)
  }
  if (system === 'Jira' && JIRA_CONFIGURED) {
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}`, {
      headers: { Authorization: jiraAuthHeader(), Accept: 'application/json' },
    })
    if (!res.ok) throw new Error(`Jira getIssue failed: ${res.status}`)
    const data = await res.json()
    // Jira's status category is a fixed three-value field ('new' / 'indeterminate'
    // / 'done') every workflow maps onto regardless of what its own custom
    // states are called — the same role isTerminalAdoState plays for Azure
    // DevOps's free-text state. Previously this put Jira's raw status name
    // straight into `status`, which isn't one of this app's four values at
    // all (it only ever matched by accident, if a project happened to name
    // a state "Open" or "Closed").
    const isTerminal = data.fields.status?.statusCategory?.key === 'done'
    return {
      status: nextStatusFromBoard(isTerminal, currentStatus),
      boardState: data.fields.status?.name || '',
      assignee: data.fields.assignee?.displayName || '',
      summary: data.fields.summary || '',
      lastActivityAt: new Date(data.fields.updated).getTime(),
      url: `${JIRA_BASE_URL}/browse/${ticketId}`,
    }
  }
  const state = BOARD_STATE[ticketId] || { status: 'Open' as TicketStatus, assignee: '', summary: '', lastActivityAt: now }
  return delay({ ...state, boardState: state.status, url: boardUrl(system, ticketId, organization) })
}

// Posts a comment on the board asking for a status update — this is what
// the "Follow up" button calls. Signed with a fixed label rather than
// @mentioning the ticket's assignee: that name is free text this app
// never verified against a real board identity, and the PAT's own account
// shows as the comment's author regardless — a plain signature is honest
// about where the comment actually came from instead of looking like a
// person DMing themselves.
const FOLLOW_UP_SIGNATURE = 'Regression_Admin'

export async function postFollowUpComment({
  system,
  ticketId,
  organization,
}: {
  system: TicketSystem
  ticketId: string
  organization: string | null
}): Promise<FollowUpResult> {
  const text = `${FOLLOW_UP_SIGNATURE}: Following up — any update on this one? It's been open a while and is blocking regression sign-off.`

  if (system === 'Azure DevOps') {
    if (!organization) throw new Error('This ticket has no linked Azure DevOps organization to post to.')
    return postAzureDevOpsComment(organization, ticketId, text)
  }
  if (system === 'Jira' && JIRA_CONFIGURED) {
    const res = await fetch(`${JIRA_BASE_URL}/rest/api/3/issue/${ticketId}/comment`, {
      method: 'POST',
      headers: { Authorization: jiraAuthHeader(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] } }),
    })
    if (!res.ok) throw new Error(`Jira postComment failed: ${res.status}`)
    return { ok: true, postedAt: Date.now(), text, url: `${JIRA_BASE_URL}/browse/${ticketId}` }
  }

  const state = BOARD_STATE[ticketId]
  if (state) state.lastActivityAt = now
  return delay({ ok: true, postedAt: now, text, url: boardUrl(system, ticketId, organization) })
}

export function ticketUrl(system: TicketSystem, ticketId: string, organization: string | null): string {
  return boardUrl(system, ticketId, organization)
}
