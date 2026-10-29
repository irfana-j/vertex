import { create } from 'zustand'
import { persist, createJSONStorage, type StateStorage } from 'zustand/middleware'
import { uid } from '../lib/id'
import { createNode, createEdge } from '../lib/nodeFactory'
import { autoLayout } from '../lib/layout'
import { getSymphonyTemplate, listJobsForTemplate, getJobDetail } from '../lib/symphonyConnector'
import { getTicketStatus, postFollowUpComment, ticketUrl } from '../lib/devopsConnector'
import { createSeedData } from './seed'
import type {
  Cycle,
  ExportPayload,
  FlowEdge,
  FlowNode,
  NewTicketInput,
  RegressionGroup,
  Run,
  SymphonyTemplateDetail,
  Template,
  TicketStatus,
} from '../types'

const seed = createSeedData()

// Runs at most `concurrency` of `fn` at once instead of either waiting for
// each one in turn (slow once a template has dozens of historical jobs) or
// firing all of them at once (confirmed live: 31 simultaneous requests
// through the Symphony proxy triggered "Failed to fetch" — a connection
// limit on the real upstream, not this app). A small worker pool is the
// middle ground.
async function mapWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  async function worker() {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

// Persisted to this app's own backend (server/) instead of localStorage, so
// both the admin and the read-only viewer see the same shared data even
// from different machines. The backend itself is "dumb" — just a JSON blob
// behind session auth — so this is the only place that talks to it; every
// action above keeps mutating local state via `set()` exactly as before,
// and persist's own setItem call (triggered by that `set()`) is what pushes
// the result to the backend. A viewer's PUT gets rejected (403, admin-only)
// server-side — enforced there, not just by hiding buttons in the UI.
const STORE_VERSION = 5

interface PersistedState {
  templates: Template[]
  cycles: Cycle[]
  activeCycleId: string | null
  groups: RegressionGroup[]
}

// Tracks in-flight writes to /api/state so a tab refresh/close right after a
// change can warn before discarding it instead of silently losing it — see
// the beforeunload listener and backendStorage.setItem below.
let pendingWriteCount = 0
if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (e) => {
    if (pendingWriteCount <= 0) return
    e.preventDefault()
    e.returnValue = ''
  })
}

const backendStorage: StateStorage = {
  getItem: async () => {
    const res = await fetch('/api/state', { credentials: 'include' })
    // The server always returns a valid body on success (DEFAULT_STATE at
    // worst) — it never legitimately has "no state" — so a non-ok response
    // here is a real failure (a 401 from a race right after login, a 502
    // from the backend being briefly down, etc.), not "nothing persisted
    // yet." Throwing instead of returning null matters: zustand's persist
    // treats a null getItem as "no data, keep whatever's already in memory"
    // and still marks hydration as finished successfully — which used to
    // mean a transient failure here silently left the seed/mock demo data
    // on screen with no error shown at all.
    if (!res.ok) throw new Error(`Failed to load state (${res.status})`)
    const data = await res.json()
    return JSON.stringify({ state: data, version: STORE_VERSION })
  },
  setItem: async (_name, value) => {
    const { state } = JSON.parse(value) as { state: unknown }
    const body = JSON.stringify(state)
    pendingWriteCount++
    try {
      await fetch('/api/state', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        // Every set() in this store fires this PUT in the background —
        // nothing awaits it — so a tab refresh right after making a change
        // can cancel it mid-flight before the server ever sees it; logging
        // back in then correctly shows the last state the server DID
        // receive, which looks like "my latest change disappeared." keepalive
        // tells the browser to finish sending this even if the page is
        // being unloaded, same mechanism as a beforeunload analytics ping.
        // It has a hard ~64KB combined-body limit in Chromium (the request
        // throws synchronously over that), so it's skipped for a large state
        // blob rather than risk a write silently failing instead of racing.
        keepalive: body.length < 60_000,
        body,
      })
    } finally {
      pendingWriteCount--
    }
  },
  removeItem: async () => {},
}

// zustand's persist has no error-aware hook other than the `onRehydrateStorage`
// factory below (fixed at persist() setup time), so App.tsx can't just pass a
// callback into `rehydrate()` itself — this tiny pub/sub bridges that gap.
type HydrationErrorListener = (message: string | null) => void
const hydrationErrorListeners = new Set<HydrationErrorListener>()
export function onHydrationError(cb: HydrationErrorListener): () => void {
  hydrationErrorListeners.add(cb)
  return () => hydrationErrorListeners.delete(cb)
}

function defaultCycleLabel(): string {
  return new Date().toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

function mirroredNodesAndEdges(
  symphonyTemplate: SymphonyTemplateDetail,
  existingInfoNode?: FlowNode
): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const infoNode = existingInfoNode || createNode('regressionInfo', symphonyTemplate.nodes.length)
  infoNode.id = 'info'
  const nodes = autoLayout([...symphonyTemplate.nodes, infoNode])
  const edges = [
    ...symphonyTemplate.edges.map(([s, t]) => createEdge(s, t)),
    createEdge(symphonyTemplate.nodes[symphonyTemplate.nodes.length - 1].id, infoNode.id),
  ]
  return { nodes, edges }
}

interface SyncResult {
  added: number
  updated: number
}

interface ImportResult {
  mode: 'replace' | 'merge'
  addedTemplates?: number
  addedRuns?: number
}

export interface StoreState {
  templates: Template[]
  cycles: Cycle[]
  activeCycleId: string | null
  // Set by the 10-minute background auto-sync (and manual "Sync all")
  // so the sidebar can show it's actually running, not just assumed to be.
  lastAutoSyncAt: number | null
  // User-defined sets of tracked templates (e.g. "Azure rollout") for
  // cumulative progress tracking — separate from Symphony's own group
  // field, which is this app's call, not Symphony's.
  groups: RegressionGroup[]

  createGroup: (name: string) => string
  renameGroup: (groupId: string, name: string) => void
  deleteGroup: (groupId: string) => void
  toggleTemplateInGroup: (groupId: string, templateId: string) => void

  exportState: (cycleId?: string) => ExportPayload
  importState: (payload: unknown) => ImportResult

  trackSymphonyTemplate: (symphonyTemplateId: string) => Promise<string | null>
  refreshTemplateStructure: (id: string) => Promise<void>
  updateTemplateFlow: (id: string, nodes: FlowNode[], edges: FlowEdge[]) => void
  deleteTemplate: (id: string) => void
  syncJobResults: (id: string, options?: { limit?: number }) => Promise<SyncResult>
  syncAllTemplates: () => Promise<SyncResult>

  logTicket: (templateId: string, ticketData: NewTicketInput) => Promise<void>
  updateTicket: (templateId: string, ticketId: string, patch: Partial<{ status: TicketStatus }>) => void
  syncTicketFromBoard: (templateId: string, ticketId: string) => Promise<void>
  syncAllTicketsFromBoard: () => Promise<void>
  followUpOnTicket: (templateId: string, ticketId: string) => Promise<{ ok: boolean; postedAt: number; text: string; url: string } | undefined>

  startNewCycle: (label?: string) => void
}

export const useStore = create<StoreState>()(
  persist(
    (set, get) => ({
      templates: seed.templates,
      cycles: seed.cycles,
      activeCycleId: seed.activeCycleId,
      lastAutoSyncAt: null,
      groups: [],

      createGroup: (name) => {
        const newGroup: RegressionGroup = { id: uid('group'), name: name.trim() || 'Untitled group', templateIds: [] }
        set((s) => ({ groups: [...s.groups, newGroup] }))
        return newGroup.id
      },
      renameGroup: (groupId, name) => {
        const trimmed = name.trim()
        if (!trimmed) return
        set((s) => ({ groups: s.groups.map((g) => (g.id === groupId ? { ...g, name: trimmed } : g)) }))
      },
      deleteGroup: (groupId) => {
        set((s) => ({ groups: s.groups.filter((g) => g.id !== groupId) }))
      },
      toggleTemplateInGroup: (groupId, templateId) => {
        set((s) => ({
          groups: s.groups.map((g) => {
            if (g.id !== groupId) return g
            const has = g.templateIds.includes(templateId)
            return { ...g, templateIds: has ? g.templateIds.filter((id) => id !== templateId) : [...g.templateIds, templateId] }
          }),
        }))
      },

      // Backup/restore (and the eventual migration path onto a real
      // backend). With no cycleId, this is a full snapshot — every cycle,
      // every tracked template (nodes, run history, tickets), every group —
      // round-tripping through export then import on an empty app
      // reproduces the exact same state. With a cycleId, it's a lighter,
      // shareable slice: every template kept in full (structure), but each
      // one's run history/tickets trimmed to just that cycle.
      exportState: (cycleId) => {
        const { templates, cycles, activeCycleId, groups } = get()
        if (!cycleId) {
          return { kind: 'full', schemaVersion: 1, exportedAt: Date.now(), data: { templates, cycles, activeCycleId, groups } }
        }
        const cycle = cycles.find((c) => c.id === cycleId)
        const scopedTemplates = templates.map((t) => ({
          ...t,
          runHistory: t.runHistory.filter((r) => r.cycleId === cycleId),
          tickets: t.tickets.filter((tk) => tk.cycleId === cycleId),
        }))
        return { kind: 'cycle', schemaVersion: 1, exportedAt: Date.now(), cycleId, data: { cycle, templates: scopedTemplates, groups } }
      },

      // A "full" export replaces everything outright — the guaranteed-exact
      // round trip. A "cycle" export merges instead: existing templates
      // (matched by symphonyTemplateId, since local ids are random per
      // track) gain whatever runs/tickets they're missing; templates not
      // already tracked get added whole. Group membership is remapped
      // through the same match so it still points at the right template
      // even when its local id differs between the two app instances.
      //
      // `payload` is untrusted — it's whatever JSON a person picked from
      // disk — so this is deliberately defensive rather than trusting it
      // matches ExportPayload.
      importState: (payload) => {
        const parsed = payload as Partial<ExportPayload> | null | undefined
        if (!parsed?.data) throw new Error('Not a recognized export file')

        if (parsed.kind === 'full') {
          const { templates, cycles, activeCycleId, groups } = parsed.data as Extract<ExportPayload, { kind: 'full' }>['data']
          set({
            templates: templates || [],
            cycles: cycles || [],
            activeCycleId: activeCycleId || cycles?.[0]?.id || null,
            groups: groups || [],
          })
          return { mode: 'replace' }
        }

        const cycleData = parsed.data as Extract<ExportPayload, { kind: 'cycle' }>['data']
        let addedTemplates = 0
        let addedRuns = 0
        set((s) => {
          const cycles = cycleData.cycle && !s.cycles.some((c) => c.id === cycleData.cycle!.id) ? [...s.cycles, cycleData.cycle] : s.cycles

          const bySymId = new Map(s.templates.map((t) => [t.symphonyTemplateId, t]))
          const idRemap = new Map<string, string>()
          const mergedTemplates = [...s.templates]

          ;(cycleData.templates || []).forEach((incoming) => {
            const existing = bySymId.get(incoming.symphonyTemplateId)
            if (!existing) {
              mergedTemplates.push(incoming)
              idRemap.set(incoming.id, incoming.id)
              addedTemplates++
              addedRuns += incoming.runHistory.length
              return
            }
            idRemap.set(incoming.id, existing.id)
            const runIds = new Set(existing.runHistory.map((r) => r.id))
            const newRuns = incoming.runHistory.filter((r) => !runIds.has(r.id))
            const ticketIds = new Set(existing.tickets.map((tk) => tk.id))
            const newTickets = incoming.tickets.filter((tk) => !ticketIds.has(tk.id))
            addedRuns += newRuns.length
            const idx = mergedTemplates.findIndex((t) => t.id === existing.id)
            mergedTemplates[idx] = {
              ...existing,
              runHistory: [...existing.runHistory, ...newRuns],
              tickets: [...existing.tickets, ...newTickets],
            }
          })

          const byName = new Map(s.groups.map((g) => [g.name, g]))
          const mergedGroups = [...s.groups]
          ;(cycleData.groups || []).forEach((incoming) => {
            const remappedIds = incoming.templateIds.map((id) => idRemap.get(id) ?? id)
            const existing = byName.get(incoming.name)
            if (!existing) {
              mergedGroups.push({ ...incoming, templateIds: remappedIds })
              return
            }
            const idx = mergedGroups.findIndex((g) => g.id === existing.id)
            mergedGroups[idx] = { ...existing, templateIds: [...new Set([...existing.templateIds, ...remappedIds])] }
          })

          return { cycles, templates: mergedTemplates, groups: mergedGroups }
        })
        return { mode: 'merge', addedTemplates, addedRuns }
      },

      // Pulls a template's real structure from Symphony and starts
      // tracking it here — this is how a template enters the regression
      // dashboard; nothing gets hand-built on a blank canvas anymore.
      // Which GROUP (cloud, or a project) it belongs to comes from
      // Symphony too — this app never infers it from the nodes.
      trackSymphonyTemplate: async (symphonyTemplateId) => {
        const symphonyTemplate = await getSymphonyTemplate(symphonyTemplateId)
        if (!symphonyTemplate) return null
        const infoNode = createNode('regressionInfo', symphonyTemplate.nodes.length)
        const { nodes, edges } = mirroredNodesAndEdges(symphonyTemplate, infoNode)
        const template: Template = {
          id: uid('tpl'),
          symphonyTemplateId: symphonyTemplate.id,
          symphonyTemplateName: symphonyTemplate.name,
          symphonyGroup: symphonyTemplate.group,
          symphonyOwner: symphonyTemplate.owner,
          symphonyStatus: symphonyTemplate.status,
          symphonyEverRun: symphonyTemplate.everRun,
          description: symphonyTemplate.description,
          nodes,
          edges,
          runHistory: [],
          tickets: [],
          lastSyncedAt: Date.now(),
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }
        set((s) => ({ templates: [...s.templates, template] }))
        // Pull in just the latest job right away, instead of showing an
        // empty "Not run" state until the user manually clicks Sync — capped
        // to one job so tracking stays fast; "Sync job results" afterwards
        // does the full history.
        await get().syncJobResults(template.id, { limit: 1 })
        return template.id
      },

      // Re-pulls a template's structure (and group) from Symphony without
      // touching the regression metadata, run history or tickets this app
      // owns — for when the real flow changes on Symphony's side.
      refreshTemplateStructure: async (id) => {
        const template = get().templates.find((t) => t.id === id)
        if (!template) return
        const symphonyTemplate = await getSymphonyTemplate(template.symphonyTemplateId)
        if (!symphonyTemplate) return
        const infoNode = template.nodes.find((n) => n.type === 'regressionInfo')
        const { nodes, edges } = mirroredNodesAndEdges(symphonyTemplate, infoNode)
        set((s) => ({
          templates: s.templates.map((t) =>
            t.id === id
              ? {
                  ...t,
                  nodes,
                  edges,
                  symphonyTemplateName: symphonyTemplate.name,
                  symphonyGroup: symphonyTemplate.group,
                  symphonyOwner: symphonyTemplate.owner,
                  symphonyStatus: symphonyTemplate.status,
                  symphonyEverRun: symphonyTemplate.everRun,
                  description: symphonyTemplate.description,
                  lastSyncedAt: Date.now(),
                }
              : t
          ),
        }))
      },

      // Persists local canvas edits — in practice just node position drags
      // and the Template Info node's own data, since everything else is a
      // read-only mirror of Symphony's structure.
      updateTemplateFlow: (id, nodes, edges) => {
        set((s) => ({
          templates: s.templates.map((t) => (t.id === id ? { ...t, nodes, edges, updatedAt: Date.now() } : t)),
        }))
      },

      deleteTemplate: (id) => {
        set((s) => ({ templates: s.templates.filter((t) => t.id !== id) }))
      },

      // Syncs by job id: lists which jobs exist for this template, then —
      // only for ones not already ingested — fetches that job's full
      // per-node detail (pass/fail, and a log for anything that failed).
      // This is what "Run regression" used to fake with a random
      // pass/fail; now it's just reflecting what Symphony actually ran.
      // `limit` caps how many of the latest jobs get pulled in — used right
      // after tracking to show the latest job fast (one round trip) instead
      // of the full history; the manual Sync button omits it for a full sync.
      syncJobResults: async (id, options) => {
        const limit = options?.limit
        const template = get().templates.find((t) => t.id === id)
        if (!template) return { added: 0, updated: 0 }
        let jobs = await listJobsForTemplate(template.symphonyTemplateId)
        if (limit) jobs = jobs.slice(0, limit)
        const existingById = new Map(template.runHistory.map((r) => [r.id, r]))
        const activeCycleId = get().activeCycleId

        // A run already captured mid-execution (overallStatus not yet
        // Success/Failed) is NOT done — Symphony keeps going after that
        // snapshot, so re-fetch it on every sync until it reaches a
        // terminal state, instead of freezing it at whatever it looked
        // like the first time it was seen.
        //
        // overallStatus alone isn't trustworthy for this, though — confirmed
        // live: a Terraform-style run paused awaiting manual approval can
        // report an overall status of "Failed" while every node is still
        // sitting at "Planned"/"Awaiting", nothing actually executed yet.
        // Trusting overallStatus alone would freeze that run as done forever
        // once approved and actually run. So a run only counts as genuinely
        // finished if its own last-seen per-node status text doesn't still
        // show something non-terminal.
        const PENDING_NODE_STATUS = /planned|awaiting|pending|queued/i
        const isGenuinelyDone = (run: Run | undefined): boolean => {
          if (!run) return false
          if (run.overallStatus !== 'Success' && run.overallStatus !== 'Failed') return false
          return !Object.values(run.liveStatus || {}).some((s) => PENDING_NODE_STATUS.test(s))
        }
        //
        // Detail fetches run a few at a time (mapWithConcurrency) —
        // listJobsForTemplate no longer has the real API narrow the job
        // list server-side (see its own comment), so a template with a
        // long history can mean dozens of these in one sync. Fully
        // sequential made a first sync take over a minute against ~30
        // historical jobs; firing all of them at once instead got
        // "Failed to fetch" from the real Symphony host partway through —
        // a connection limit on its side, confirmed live.
        const jobsNeedingDetail = jobs.filter((job) => !isGenuinelyDone(existingById.get(job.jobId)))
        const details = await mapWithConcurrency(jobsNeedingDetail, 4, (job) => getJobDetail(job.jobId))
        const newRuns: Run[] = []
        const updatedRuns = new Map<string | number, Run>()
        jobsNeedingDetail.forEach((job, i) => {
          const detail = details[i]
          const existing = existingById.get(job.jobId)
          const failedStep = Object.values(detail.steps || {}).find((s) => s.status === 'fail')
          const run: Run = {
            id: job.jobId,
            timestamp: job.finishedAt,
            overallStatus: job.status,
            cycleId: existing?.cycleId ?? activeCycleId ?? '',
            results: detail.steps || {},
            // Real Symphony status text per node (e.g. "Running", "Planned")
            // for nodes that aren't pass/fail yet — lets the UI show what's
            // actually happening instead of a generic "not reached".
            liveStatus: detail.nodeStatusText || {},
            failureReason: failedStep?.reason || null,
          }
          if (existing) updatedRuns.set(job.jobId, run)
          else newRuns.push(run)
        })

        set((s) => ({
          templates: s.templates.map((t) =>
            t.id === id
              ? {
                  ...t,
                  runHistory: [...t.runHistory.map((r) => updatedRuns.get(r.id) ?? r), ...newRuns],
                  lastSyncedAt: Date.now(),
                  updatedAt: Date.now(),
                }
              : t
          ),
        }))
        return { added: newRuns.length, updated: updatedRuns.size }
      },

      // Syncs every tracked template, one at a time — what the 10-minute
      // background auto-sync calls, and reusable for a manual "sync
      // everything" action later. Errors on one template (e.g. a transient
      // network hiccup) don't stop the rest from syncing.
      syncAllTemplates: async () => {
        const ids = get().templates.map((t) => t.id)
        let added = 0
        let updated = 0
        for (const id of ids) {
          try {
            const result = await get().syncJobResults(id)
            added += result.added
            updated += result.updated
          } catch {
            // Leave this template as-is and keep going — a real sync error
            // for it will surface next time its own page is opened.
          }
        }
        set({ lastAutoSyncAt: Date.now() })
        return { added, updated }
      },

      // A ticket is logged AFTER you know the result — either against a
      // specific failed job (runId set) or as a general/backlog item
      // (runId: null). Its cycle is inherited from that job's run, or
      // defaults to whichever cycle is currently active. The board link
      // is derived from system + ticket id so it's clickable immediately.
      logTicket: async (templateId, ticketData) => {
        const newId = uid('ticket')
        set((s) => ({
          templates: s.templates.map((t) => {
            if (t.id !== templateId) return t
            const run = ticketData.runId ? t.runHistory.find((r) => r.id === ticketData.runId) : null
            const cycleId = run ? run.cycleId : s.activeCycleId || ''
            const now = Date.now()
            const entry = {
              id: newId,
              ...ticketData,
              cycleId,
              url: ticketUrl(ticketData.system, ticketData.ticketId, ticketData.organization),
              lastActivityAt: now,
              createdAt: now,
            }
            return { ...t, tickets: [...(t.tickets || []), entry] }
          }),
        }))
        // Linked to a real org — pull its assignee/status/summary in right
        // away instead of waiting for the next manual or 15-minute sync.
        if (ticketData.system === 'Azure DevOps' && ticketData.organization) {
          try {
            await get().syncTicketFromBoard(templateId, newId)
          } catch {
            // Leave it as freshly logged — the ticket's own Sync button
            // can retry, same as any other failed board sync.
          }
        }
      },

      updateTicket: (templateId, ticketId, patch) => {
        set((s) => ({
          templates: s.templates.map((t) =>
            t.id === templateId ? { ...t, tickets: t.tickets.map((tk) => (tk.id === ticketId ? { ...tk, ...patch } : tk)) } : t
          ),
        }))
      },

      // Pulls the ticket's live state from the board — this is how a
      // status change made directly on the board (not through this app)
      // shows up here.
      syncTicketFromBoard: async (templateId, ticketId) => {
        const template = get().templates.find((t) => t.id === templateId)
        const ticket = template?.tickets.find((tk) => tk.id === ticketId)
        if (!ticket) return
        const board = await getTicketStatus({
          system: ticket.system,
          ticketId: ticket.ticketId,
          organization: ticket.organization,
          currentStatus: ticket.status,
        })
        set((s) => ({
          templates: s.templates.map((t) =>
            t.id === templateId
              ? {
                  ...t,
                  tickets: t.tickets.map((tk) =>
                    tk.id === ticketId
                      ? {
                          ...tk,
                          status: board.status,
                          assignee: board.assignee || tk.assignee,
                          summary: board.summary || tk.summary,
                          lastActivityAt: board.lastActivityAt,
                          url: board.url,
                        }
                      : tk
                  ),
                }
              : t
          ),
        }))
      },

      // Same, for every ticket across every template — the dashboard's
      // "Sync all tickets" action.
      syncAllTicketsFromBoard: async () => {
        const pairs: [string, string][] = []
        get().templates.forEach((t) => t.tickets.forEach((tk) => pairs.push([t.id, tk.id])))
        for (const [templateId, ticketId] of pairs) {
          try {
            await get().syncTicketFromBoard(templateId, ticketId)
          } catch {
            // One bad/renamed/deleted work item shouldn't stop the rest of
            // the board from syncing — same reasoning as syncAllTemplates.
          }
        }
      },

      // Posts a comment on the board tagging the assignee and asking for
      // a status update — the "Follow up" button. Resets the staleness
      // clock the same way a real new comment would.
      followUpOnTicket: async (templateId, ticketId) => {
        const template = get().templates.find((t) => t.id === templateId)
        const ticket = template?.tickets.find((tk) => tk.id === ticketId)
        if (!ticket) return undefined
        const result = await postFollowUpComment({ system: ticket.system, ticketId: ticket.ticketId, organization: ticket.organization })
        set((s) => ({
          templates: s.templates.map((t) =>
            t.id === templateId
              ? {
                  ...t,
                  tickets: t.tickets.map((tk) =>
                    tk.id === ticketId ? { ...tk, lastActivityAt: result.postedAt, lastFollowUpAt: result.postedAt } : tk
                  ),
                }
              : t
          ),
        }))
        return result
      },

      // Closes the current cycle and opens a new one. All future syncs
      // stamp against the new cycle; past runs keep pointing at the one
      // they actually happened in, so history and trend stay intact.
      startNewCycle: (label) => {
        const now = Date.now()
        const newCycle: Cycle = { id: uid('cycle'), label: label?.trim() || defaultCycleLabel(), startedAt: now, closedAt: null }
        set((s) => ({
          cycles: [...s.cycles.map((c) => (c.id === s.activeCycleId ? { ...c, closedAt: now } : c)), newCycle],
          activeCycleId: newCycle.id,
        }))
      },
    }),
    {
      name: 'vertex-regression-studio',
      storage: createJSONStorage<PersistedState>(() => backendStorage),
      version: STORE_VERSION,
      // Hydration now depends on being logged in (the backend 401s an
      // unauthenticated GET) — App.tsx calls `useStore.persist.rehydrate()`
      // itself right after login succeeds, instead of this running
      // automatically at module load.
      skipHydration: true,
      // Fires on every rehydrate() call (initial post-login load AND the
      // viewer's 60s background refresh), with `error` set only when
      // getItem threw. Note zustand's own hydrate() swallows that rejection
      // internally (its promise chain always resolves), so this is the only
      // way to learn a rehydrate attempt actually failed.
      onRehydrateStorage: () => (_state, error) => {
        const message = error ? (error instanceof Error ? error.message : String(error)) : null
        hydrationErrorListeners.forEach((cb) => cb(message))
      },
      // lastAutoSyncAt is this browser's own observation of when ITS
      // auto-sync last ran, not shared app data — excluded so a viewer's
      // tab doesn't overwrite it with its own (never-running) null.
      partialize: (s): PersistedState => ({ templates: s.templates, cycles: s.cycles, activeCycleId: s.activeCycleId, groups: s.groups }),
      migrate: (persisted, version): PersistedState => {
        // Pre-v5 templates had no per-node/group model and tickets had no
        // board url or activity timestamp — that shape doesn't reconcile
        // with this one, so start clean rather than trying to reshape it.
        if (version < 5) return { templates: seed.templates, cycles: seed.cycles, activeCycleId: seed.activeCycleId, groups: [] }
        return persisted as PersistedState
      },
    }
  )
)
