import type {
  CycleTrendPoint,
  Cycle,
  DashboardRow,
  DashboardSummary,
  FlowNode,
  GroupDashboard,
  NodeResult,
  RegressionGroup,
  Run,
  Team,
  Template,
  TemplateMeta,
  Ticket,
  TicketWithTemplate,
} from '../types'

const STALE_DAYS = 5
const day = 86400000

export function getRegressionNode(template: Template): FlowNode | null {
  return template.nodes.find((n) => n.type === 'regressionInfo') || null
}

// A "scenario" node is any node Symphony flags as one — an actual
// provisioning step, not setup/config. This is what "number of nodes
// ran / total nodes" progress counts, and it isn't tied to any one node
// "type" string, since Symphony can introduce new operation kinds without
// this app needing to know about them.
export function getScenarioNodes(template: Template): FlowNode[] {
  return template.nodes.filter((n) => n.data?.isScenario)
}

// Grouping (cloud, or a project) is Symphony's call, not inferred here.
export function getTemplateGroup(template: Template): string {
  return template.symphonyGroup || 'Ungrouped'
}

export function getTemplateMeta(template: Template): TemplateMeta {
  const info = getRegressionNode(template)
  return {
    // Owner comes from Symphony, same as the template's name and group —
    // this app doesn't assign ownership, it just reflects it.
    owner: template.symphonyOwner || 'Unassigned',
    enabled: info?.data.enabled ?? true,
    labels: info?.data.labels || [],
  }
}

// A template only counts toward the regression dashboard once it has a
// Template Info node, that node's "Enabled for regression" toggle is
// on, AND its labels include "Regression" — the same label the node
// carries by default. Without all three, an in-progress or throwaway
// template would silently skew the group/use-case percentages.
export function isRegressionTemplate(template: Template): boolean {
  const info = getRegressionNode(template)
  if (!info || info.data.enabled === false) return false
  return (info.data.labels || []).some((l) => l.trim().toLowerCase() === 'regression')
}

// ---- cycle-scoped run helpers ----
// "Current regression period" means: only runs stamped with the active
// cycle's id count toward this template's status and node coverage. A
// template that passed last cycle but hasn't synced a job this cycle
// shows its nodes as not-yet-run, not as still-passing leftover state.

export function getRunsInCycle(template: Template, cycleId: string): Run[] {
  return (template.runHistory || []).filter((r) => r.cycleId === cycleId)
}

// startNewCycle() always stamps the outgoing cycle's closedAt with the same
// moment the new cycle's startedAt is set, so cycles form one contiguous
// timeline with no gaps — every instant after the first cycle began falls
// inside exactly one cycle's [startedAt, closedAt) window. Used to derive a
// run's cycle from when the job actually finished, instead of whichever
// cycle happened to be active the first time this app noticed that job
// (which could be well before it actually completed, if it was still
// Awaiting/Planned/On Hold at the time).
export function resolveCycleForTimestamp(cycles: Cycle[], timestamp: number): string {
  const sorted = [...cycles].sort((a, b) => a.startedAt - b.startedAt)
  const match = sorted.find((c) => timestamp >= c.startedAt && (c.closedAt === null || timestamp < c.closedAt))
  // A timestamp from before the very first cycle existed (seed/import data,
  // or clock skew) has no real window to belong to — fall back to the
  // earliest cycle rather than leaving it unassigned.
  return match?.id ?? sorted[0]?.id ?? ''
}

export function getExecutedCount(template: Template, cycleId: string): number {
  return getRunsInCycle(template, cycleId).length
}

export function wasExecutedInCycle(template: Template, cycleId: string): boolean {
  return getExecutedCount(template, cycleId) > 0
}

// The chronologically latest run in this cycle, by the job's own finish
// timestamp — NOT just the last element of runHistory. Sync can add or
// update runs out of timestamp order (a backfilled older job synced after
// a newer one, a re-synced still-running job updated in place), so array
// position alone isn't reliable evidence of which run is actually latest.
export function getLastRun(template: Template, cycleId: string): Run | null {
  const runs = getRunsInCycle(template, cycleId)
  if (!runs.length) return null
  return runs.reduce((latest, r) => (r.timestamp > latest.timestamp ? r : latest), runs[0])
}

export function getStatus(template: Template, cycleId: string): string {
  const last = getLastRun(template, cycleId)
  if (!last) return 'Not Run'
  return last.overallStatus
}

export function getFailureReason(template: Template, cycleId: string): string | null {
  const last = getLastRun(template, cycleId)
  return last?.failureReason || null
}

// Every node id the template's LATEST job this cycle actually reached —
// not a union across every job synced this cycle. Merging across jobs used
// to let a node a re-run never got back to (because it failed earlier in
// the chain, or the template changed) keep showing its pass from an older
// job — quietly hiding a real regression behind stale data. The latest job
// is the true current state of this template; an older job's results stop
// counting the moment a newer one exists, exactly the way Symphony's own
// "latest run" already works.
export function getExecutedScenarioNodeIds(template: Template, cycleId: string): Set<string> {
  // Only count ids that are actually scenario nodes — a job's results can
  // include config nodes too (e.g. "Global variables" reaching "Finished"),
  // which aren't part of node-weighted progress and would otherwise inflate
  // the count past the template's own scenario node total.
  const scenarioIds = new Set(getScenarioNodes(template).map((n) => n.id))
  const ids = new Set<string>()
  const last = getLastRun(template, cycleId)
  Object.keys(last?.results || {}).forEach((nodeId) => {
    if (scenarioIds.has(nodeId)) ids.add(nodeId)
  })
  return ids
}

// Per-node pass/fail from the latest job this cycle ONLY — see
// getExecutedScenarioNodeIds above for why this isn't a merge across every
// run in the cycle anymore.
export function getNodeResultsInCycle(template: Template, cycleId: string): Record<string, NodeResult> {
  return getLastRun(template, cycleId)?.results || {}
}

// The single most recent job for this template, regardless of cycle —
// what "latest job details" means: the one Symphony most recently ran,
// whether or not it happened in the cycle you're currently looking at.
export function getLatestRunOverall(template: Template): Run | null {
  const runs = template.runHistory || []
  if (!runs.length) return null
  return [...runs].sort((a, b) => b.timestamp - a.timestamp)[0]
}

// The most recent job's per-node results, keyed by node id — used to show
// each node's latest pass/fail (and failure log) on the canvas itself.
export function getLatestNodeResults(template: Template): Record<string, NodeResult> {
  const runs = template.runHistory || []
  return runs.length ? runs[runs.length - 1].results || {} : {}
}

// Flakiness is a property of the template's behaviour over time, not of
// one cycle, so it looks at the most recent runs regardless of cycle.
export function isFlaky(template: Template): boolean {
  const h = template.runHistory || []
  if (h.length < 2) return false
  const recent = h.slice(-3).map((r) => r.overallStatus)
  const last = recent[recent.length - 1]
  return last === 'Success' && recent.includes('Failed')
}

// ---- tickets (attached to a specific failed run, or general/backlog) ----

export function getTicketsForTemplate(template: Template): Ticket[] {
  return template.tickets || []
}

export function getTicketForRun(template: Template, runId: string | number): Ticket | null {
  return (template.tickets || []).find((t) => t.runId === runId) || null
}

// Scoped to one run AND one node — not just nodeId — so a node that fails
// again in a later run shows a fresh "Raise ticket" option instead of the
// old ticket from a run that's since been rerun.
export function getTicketForNode(template: Template, runId: string | number | null, nodeId: string): Ticket | null {
  if (runId === null) return null
  return (template.tickets || []).find((t) => t.runId === runId && t.nodeId === nodeId) || null
}

export function isTicketOpen(ticket: Ticket): boolean {
  return ticket.status === 'Open' || ticket.status === 'Fixed - Verify Pending' || ticket.status === 'Backlog'
}

// No activity on the board in a while — surfaces the follow-up action.
export function isTicketStale(ticket: Ticket): boolean {
  if (!isTicketOpen(ticket) || !ticket.lastActivityAt) return false
  return (Date.now() - ticket.lastActivityAt) / day >= STALE_DAYS
}

export function daysSinceActivity(ticket: Ticket): number | null {
  if (!ticket.lastActivityAt) return null
  return Math.floor((Date.now() - ticket.lastActivityAt) / day)
}

export function computeDashboard(
  templates: Template[],
  _cycles: Cycle[],
  activeCycleId: string,
  groups: RegressionGroup[],
  teams: Team[]
): DashboardSummary {
  const tracked = templates.filter(isRegressionTemplate)
  const teamById = new Map(teams.map((tm) => [tm.id, tm]))

  const rows: DashboardRow[] = tracked.map((t) => {
    const meta = getTemplateMeta(t)
    const lastRun = getLastRun(t, activeCycleId)
    const ticket = lastRun ? getTicketForRun(t, lastRun.id) : null
    // A ticket raised in an earlier cycle and still unresolved is still a
    // real open issue against this template — it doesn't vanish just
    // because a new cycle started. Tickets are scoped to the template they
    // were raised against, not to whichever cycle happened to be active
    // when they were logged.
    const allTicketsForTemplate = getTicketsForTemplate(t)
    const scenarioNodes = getScenarioNodes(t)
    const executedNodeIds = getExecutedScenarioNodeIds(t, activeCycleId)
    const latestResults = getNodeResultsInCycle(t, activeCycleId)
    const totalNodes = scenarioNodes.length
    const executedNodes = scenarioNodes.filter((n) => executedNodeIds.has(n.id)).length
    const passNodes = scenarioNodes.filter((n) => executedNodeIds.has(n.id) && latestResults[n.id]?.status === 'pass').length
    const failNodes = executedNodes - passNodes
    return {
      id: t.id,
      name: t.symphonyTemplateName,
      groupNames: groups.filter((g) => g.templateIds.includes(t.id)).map((g) => g.name),
      teamName: t.teamId ? teamById.get(t.teamId)?.name ?? null : null,
      owner: meta.owner,
      labels: meta.labels,
      totalNodes,
      executedNodes,
      passNodes,
      failNodes,
      nodePct: totalNodes ? Math.round((executedNodes / totalNodes) * 100) : 0,
      executedThisCycle: !!lastRun,
      status: getStatus(t, activeCycleId),
      failureReason: getFailureReason(t, activeCycleId),
      flaky: isFlaky(t),
      ticket,
      ticketCount: allTicketsForTemplate.length,
      openTicketCount: allTicketsForTemplate.filter(isTicketOpen).length,
      staleTicketCount: allTicketsForTemplate.filter(isTicketStale).length,
      lastRun,
      comment: lastRun
        ? lastRun.overallStatus === 'Success'
          ? 'All checks passed'
          : `Failed: ${lastRun.failureReason || 'unknown reason'}${ticket ? '' : ' — no ticket logged yet'}`
        : 'Not executed this cycle',
    }
  })

  const executedRows = rows.filter((r) => r.executedThisCycle)
  const pendingRows = rows.filter((r) => !r.executedThisCycle)
  const flaky = rows.filter((r) => r.flaky)

  const totalNodesSum = rows.reduce((s, r) => s + r.totalNodes, 0) || 1
  const executedNodesSum = rows.reduce((s, r) => s + r.executedNodes, 0)
  const overallPct = Math.round((executedNodesSum / totalNodesSum) * 100)

  const allTickets: TicketWithTemplate[] = []
  tracked.forEach((t) => {
    getTicketsForTemplate(t).forEach((tk) => allTickets.push({ ...tk, templateId: t.id, templateName: t.symphonyTemplateName }))
  })
  const openTickets = allTickets.filter(isTicketOpen)
  const staleTickets = openTickets.filter(isTicketStale)

  // The "All templates" table's own group filter mirrors the app's
  // user-defined groups (same ones computeCustomGroupDashboard rolls up) —
  // every created group appears here, even an empty one, not just groups
  // that happen to have a tracked template in them right now.
  const groupNames = groups.map((g) => g.name).sort()
  // Same reasoning as groupNames — every created team appears in the
  // filter, even one with no tracked template assigned to it yet.
  const teamNames = teams.map((tm) => tm.name).sort()

  return {
    rows,
    overallPct,
    totalTemplates: rows.length,
    untrackedCount: templates.length - tracked.length,
    executedCount: executedRows.length,
    pendingCount: pendingRows.length,
    totalNodesSum,
    executedNodesSum,
    pendingNodesSum: totalNodesSum - executedNodesSum,
    flakyCount: flaky.length,
    openTicketsCount: openTickets.length,
    staleTicketsCount: staleTickets.length,
    allTickets,
    groups: groupNames,
    teams: teamNames,
  }
}

// Shared by computeCustomGroupDashboard and computeTeamDashboard below.
// `pct` is a success rate — passed nodes over ALL nodes in the group/team
// (every node in every member template, run or not), not just the ones
// tested so far. A node that hasn't run yet, or that failed, both count
// against it exactly the same as each other: neither is "passing" yet.
// That's deliberate — with only a sliver of a large group actually
// exercised, this bar should read as barely-started, not as a deceptively
// high rate computed against a tiny tested-so-far denominator.
// `budgetMs` is this group/team's own regression window, in milliseconds —
// null means no deadline is tracked here, so isOverdue is always false.
// Different teams can run on different schedules (see Team.regressionBudgetDays),
// so this is no longer one fixed constant shared app-wide.
function computeMembersRollup(id: string, name: string, members: Template[], cycle: Cycle, budgetMs: number | null): GroupDashboard {
  const cycleId = cycle.id
  let totalNodes = 0
  let passNodes = 0
  let failNodes = 0

  const templateRows = members.map((t) => {
    const scenarioNodes = getScenarioNodes(t)
    const executedIds = getExecutedScenarioNodeIds(t, cycleId)
    const latestResults = getNodeResultsInCycle(t, cycleId)
    let pass = 0
    let fail = 0
    scenarioNodes.forEach((n) => {
      if (!executedIds.has(n.id)) return
      if (latestResults[n.id]?.status === 'pass') pass++
      else fail++
    })
    totalNodes += scenarioNodes.length
    passNodes += pass
    failNodes += fail
    return {
      id: t.id,
      name: t.symphonyTemplateName,
      totalNodes: scenarioNodes.length,
      passNodes: pass,
      failNodes: fail,
      testedNodes: pass + fail,
      pct: scenarioNodes.length ? Math.round((pass / scenarioNodes.length) * 100) : 0,
      status: getStatus(t, cycleId),
    }
  })

  const testedNodes = passNodes + failNodes
  // Separate from the node-weighted pct above: whether a template ran at
  // all this cycle, regardless of what its nodes turned up. A template
  // whose every node failed still counts as "run" here — this metric
  // answers "did we cover everything," not "did everything pass."
  const templatesRunCount = members.filter((t) => wasExecutedInCycle(t, cycleId)).length
  const allRun = members.length > 0 && templatesRunCount === members.length

  // The instant this group/team actually finished: the LATEST of each
  // template's own first-run-this-cycle timestamp — it only crosses 100%
  // once the slowest template to get its first run finally gets one. Using
  // each template's *first* run (not its latest) means re-syncing an
  // already-covered template later never moves this once it's set — it's
  // genuinely frozen, not just "currently showing 100%."
  const finishedAt = allRun
    ? members.reduce((latest, t) => {
        const runs = getRunsInCycle(t, cycleId)
        if (!runs.length) return latest
        const firstRun = Math.min(...runs.map((r) => r.timestamp))
        return Math.max(latest, firstRun)
      }, 0)
    : null

  const elapsedMs = (cycle.closedAt ?? Date.now()) - cycle.startedAt
  const isOverdue = members.length > 0 && finishedAt === null && budgetMs !== null && elapsedMs > budgetMs

  return {
    id,
    name,
    templateCount: members.length,
    totalNodes,
    testedNodes,
    passNodes,
    failNodes,
    pct: totalNodes ? Math.round((passNodes / totalNodes) * 100) : 0,
    templatesRunCount,
    templatesRunPct: members.length ? Math.round((templatesRunCount / members.length) * 100) : 0,
    finishedAt,
    isOverdue,
    templates: templateRows,
  }
}

// Cumulative progress for each user-defined group (a set of tracked
// templates the operator chose to track together, e.g. "Azure rollout") —
// separate from Symphony's own group field. A template can sit in any
// number of groups. Regression Groups don't carry their own deadline (only
// Teams do — see computeTeamDashboard below), so these never show overdue.
export function computeCustomGroupDashboard(templates: Template[], groups: RegressionGroup[], cycle: Cycle): GroupDashboard[] {
  const tracked = templates.filter(isRegressionTemplate)
  const byId = new Map(tracked.map((t) => [t.id, t]))

  return groups.map((g) => {
    const members = g.templateIds.map((id) => byId.get(id)).filter((t): t is Template => Boolean(t))
    return computeMembersRollup(g.id, g.name, members, cycle, null)
  })
}

// Cumulative progress per team — unlike Regression Groups above, a
// template belongs to at most one team, so this is a straight partition of
// tracked templates by teamId rather than a many-to-many membership list.
// A team like "Cloud" that spans several Regression Groups (AWS, Azure,
// GCP) still gets ONE combined progress bar here; its own group rollup
// above still breaks those clouds out individually.
export function computeTeamDashboard(templates: Template[], teams: Team[], cycle: Cycle): GroupDashboard[] {
  const tracked = templates.filter(isRegressionTemplate)

  return teams.map((team) => {
    const members = tracked.filter((t) => t.teamId === team.id)
    const budgetMs = team.regressionBudgetDays !== null ? team.regressionBudgetDays * day : null
    return computeMembersRollup(team.id, team.name, members, cycle, budgetMs)
  })
}

// One point per cycle (closed cycles + the live active one): the share of
// scenario NODES executed by the end of that cycle, across every tracked
// template — this is what answers "what did THIS regression period
// actually achieve," weighted by how big each template actually is.
export function computeCycleTrend(templates: Template[], cycles: Cycle[]): CycleTrendPoint[] {
  const tracked = templates.filter(isRegressionTemplate)
  const sorted = [...cycles].sort((a, b) => a.startedAt - b.startedAt)
  const totalNodes = tracked.reduce((s, t) => s + getScenarioNodes(t).length, 0) || 1
  return sorted.map((cycle) => {
    const executedNodes = tracked.reduce((s, t) => s + getExecutedScenarioNodeIds(t, cycle.id).size, 0)
    return {
      cycleId: cycle.id,
      label: cycle.label,
      open: cycle.closedAt === null,
      overallPct: Math.round((executedNodes / totalNodes) * 100),
    }
  })
}
