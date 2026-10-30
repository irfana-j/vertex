import type { Request, Response } from 'express'
import { getAzureDevOpsIntegrations, setAzureDevOpsIntegrations, type AzureDevOpsIntegration } from './db.js'

// Mirrors the reference logic: Basic auth with an empty username and the
// PAT as the password is the standard header Azure DevOps expects.
function authHeader(pat: string): string {
  return `Basic ${Buffer.from(`:${pat}`).toString('base64')}`
}

function workItemUrl(organization: string, id: string): string {
  return `https://dev.azure.com/${organization}/_workitems/edit/${id}`
}

// States that mean "this is done, as far as Azure DevOps is concerned" —
// same list the reference logic's SyncIncidentTickets checks against.
const TERMINAL_STATES = new Set(['done', 'closed', 'resolved', 'completed', 'removed', 'cancelled'])
export function isTerminalAdoState(state: string): boolean {
  return TERMINAL_STATES.has(state.trim().toLowerCase())
}

// Azure DevOps's REST API occasionally answers a perfectly normal GET with
// a transient 429 (rate limit) or a 502/503/504, or the outbound fetch
// itself throws (a DNS/connection blip) — confirmed in practice as
// intermittent "sync error" on the client even on a plain status check,
// not just under heavy load. None of that means the work item sync
// actually failed; retrying a couple of times below resolves it instead of
// surfacing a one-off network hiccup as a hard error. A real 4xx (bad
// id, 401 PAT, 404 project) returns immediately — retrying one of those
// would never succeed anyway.
const RETRYABLE_STATUS = new Set([429, 502, 503, 504])
const RETRY_DELAYS_MS = [300, 900]

async function fetchAdoWithRetry(url: string, init: RequestInit): Promise<globalThis.Response> {
  for (let attempt = 0; ; attempt++) {
    let res: globalThis.Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      if (attempt >= RETRY_DELAYS_MS.length) throw err
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
      continue
    }
    if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt >= RETRY_DELAYS_MS.length) return res
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
  }
}

async function findIntegration(organization: string): Promise<AzureDevOpsIntegration | null> {
  const list = await getAzureDevOpsIntegrations()
  return list.find((c) => c.organization === organization) || null
}

export async function listIntegrations(): Promise<{ organization: string; project: string; configured: boolean }[]> {
  const list = await getAzureDevOpsIntegrations()
  return list.map((c) => ({
    organization: c.organization,
    project: c.project,
    configured: Boolean(c.organization && c.project && c.personalAccessToken),
  }))
}

// A PAT left blank on an update means "keep the one already saved" for
// that organization — so fixing a typo in the project name doesn't force
// re-entering the token.
export async function upsertIntegration(input: { organization: string; project: string; personalAccessToken?: string }): Promise<void> {
  const organization = input.organization.trim()
  const list = await getAzureDevOpsIntegrations()
  const existing = list.find((c) => c.organization === organization)
  const entry: AzureDevOpsIntegration = {
    organization,
    project: input.project.trim(),
    personalAccessToken: input.personalAccessToken?.trim() || existing?.personalAccessToken || '',
  }
  const next = existing ? list.map((c) => (c.organization === organization ? entry : c)) : [...list, entry]
  await setAzureDevOpsIntegrations(next)
}

export async function deleteIntegration(organization: string): Promise<void> {
  const list = await getAzureDevOpsIntegrations()
  await setAzureDevOpsIntegrations(list.filter((c) => c.organization !== organization))
}

export async function testConnection(input: {
  organization: string
  project: string
  personalAccessToken?: string
}): Promise<{ ok: boolean; error?: string }> {
  const organization = input.organization.trim()
  const project = input.project.trim()
  const existing = await findIntegration(organization)
  const pat = input.personalAccessToken?.trim() || existing?.personalAccessToken || ''
  if (!organization || !project || !pat) return { ok: false, error: 'Organization, project and a personal access token are all required.' }
  try {
    const res = await fetch(`https://dev.azure.com/${organization}/_apis/projects/${project}?api-version=7.1`, {
      headers: { Authorization: authHeader(pat) },
    })
    if (res.ok) return { ok: true }
    if (res.status === 401 || res.status === 203) return { ok: false, error: 'Azure DevOps rejected the token (401) — check the PAT and its work item read/write scope.' }
    if (res.status === 404) return { ok: false, error: `No project "${project}" found in organization "${organization}".` }
    return { ok: false, error: `Azure DevOps returned ${res.status}.` }
  } catch (err) {
    return { ok: false, error: `Could not reach Azure DevOps: ${String(err)}` }
  }
}

// GET a work item's current state — used both by the client's manual
// "Sync from board" and by its periodic auto-sync. Returns the raw ADO
// state string (and whether it's terminal) rather than guessing how it
// maps onto this app's own ticket statuses — that decision belongs to the
// client, which also knows the ticket's current local status.
export async function forwardGetWorkItem(req: Request, res: Response): Promise<void> {
  const config = await findIntegration(req.params.organization)
  if (!config || !config.project || !config.personalAccessToken) {
    res.status(400).json({ error: `Azure DevOps organization "${req.params.organization}" is not configured.` })
    return
  }
  const id = req.params.id
  try {
    const upstream = await fetchAdoWithRetry(
      `https://dev.azure.com/${config.organization}/${config.project}/_apis/wit/workitems/${id}?api-version=7.1`,
      { headers: { Authorization: authHeader(config.personalAccessToken) } }
    )
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Azure DevOps GET work item failed: ${upstream.status}` })
      return
    }
    const data = (await upstream.json()) as {
      fields?: {
        'System.State'?: string
        'System.Title'?: string
        'System.AssignedTo'?: { displayName?: string }
        'System.ChangedDate'?: string
      }
    }
    const state = data.fields?.['System.State'] || ''
    res.json({
      state,
      isTerminal: isTerminalAdoState(state),
      title: data.fields?.['System.Title'] || '',
      assignee: data.fields?.['System.AssignedTo']?.displayName || '',
      lastActivityAt: data.fields?.['System.ChangedDate'] ? new Date(data.fields['System.ChangedDate']).getTime() : Date.now(),
      url: workItemUrl(config.organization, id),
    })
  } catch (err) {
    res.status(502).json({ error: `Azure DevOps upstream request failed: ${String(err)}` })
  }
}

// Azure DevOps renders System.Description as HTML, not plain text — a raw
// failure log with no escaping would both break on any `<`/`&` in it and
// collapse every newline into a single run-on line.
function logToHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  return `<pre>${escaped.replace(/\n/g, '<br/>')}</pre>`
}

// Creates a brand-new work item on the board — unlike forwardGetWorkItem /
// forwardPostComment, which both act on a ticket id that already exists.
// This is what the "Raise ticket" button next to a failed node's log
// calls: the node's failure log becomes the work item's description, and
// the board assigns the real ticket id this returns.
export async function forwardCreateWorkItem(req: Request, res: Response): Promise<void> {
  const config = await findIntegration(req.params.organization)
  if (!config || !config.project || !config.personalAccessToken) {
    res.status(400).json({ error: `Azure DevOps organization "${req.params.organization}" is not configured.` })
    return
  }
  const title = String(req.body?.title ?? '').trim()
  const description = String(req.body?.description ?? '')
  if (!title) {
    res.status(400).json({ error: 'A title is required to raise a ticket.' })
    return
  }
  // 'Bug' exists in every standard Azure DevOps process template (Agile,
  // Scrum, CMMI) this app is expected to run against.
  const workItemType = 'Bug'
  try {
    const upstream = await fetchAdoWithRetry(
      `https://dev.azure.com/${config.organization}/${encodeURIComponent(config.project)}/_apis/wit/workitems/$${workItemType}?api-version=7.1`,
      {
        method: 'PATCH',
        headers: { Authorization: authHeader(config.personalAccessToken), 'Content-Type': 'application/json-patch+json' },
        body: JSON.stringify([
          { op: 'add', path: '/fields/System.Title', value: title },
          { op: 'add', path: '/fields/System.Description', value: logToHtml(description) },
        ]),
      }
    )
    if (!upstream.ok) {
      const body = await upstream.text().catch(() => '')
      res.status(upstream.status).json({ error: `Azure DevOps create work item failed: ${upstream.status}${body ? ` — ${body.slice(0, 300)}` : ''}` })
      return
    }
    const data = (await upstream.json()) as { id: number; fields?: { 'System.State'?: string } }
    const state = data.fields?.['System.State'] || 'New'
    res.json({
      ticketId: String(data.id),
      state,
      isTerminal: isTerminalAdoState(state),
      url: workItemUrl(config.organization, String(data.id)),
    })
  } catch (err) {
    res.status(502).json({ error: `Azure DevOps upstream request failed: ${String(err)}` })
  }
}

export async function forwardPostComment(req: Request, res: Response): Promise<void> {
  const config = await findIntegration(req.params.organization)
  if (!config || !config.project || !config.personalAccessToken) {
    res.status(400).json({ error: `Azure DevOps organization "${req.params.organization}" is not configured.` })
    return
  }
  const id = req.params.id
  const text = String(req.body?.text ?? '')
  try {
    const upstream = await fetch(
      `https://dev.azure.com/${config.organization}/${config.project}/_apis/wit/workItems/${id}/comments?api-version=7.1-preview.3`,
      {
        method: 'POST',
        headers: { Authorization: authHeader(config.personalAccessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      }
    )
    if (!upstream.ok) {
      res.status(upstream.status).json({ error: `Azure DevOps post comment failed: ${upstream.status}` })
      return
    }
    res.json({ ok: true, postedAt: Date.now(), url: workItemUrl(config.organization, id) })
  } catch (err) {
    res.status(502).json({ error: `Azure DevOps upstream request failed: ${String(err)}` })
  }
}
