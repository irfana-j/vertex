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

export function getExecutedCount(template: Template, cycleId: string): number {
  return getRunsInCycle(template, cycleId).length
}

export function wasExecutedInCycle(template: Template, cycleId: string): boolean {
  return getExecutedCount(template, cycleId) > 0
}

export function getLastRun(template: Template, cycleId: string): Run | null {
  const runs = getRunsInCycle(template, cycleId)
  return runs.length ? runs[runs.length - 1] : null
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

// Every node id that appeared with a result (pass or fail) in any job
// synced this cycle — a node reached by a failing job still counts as
// "ran," it just ran and failed. A node the job never got to (stopped
// earlier in the chain) has no entry and doesn't count yet.
export function getExecutedScenarioNodeIds(template: Template, cycleId: string): Set<string> {
  // Only count ids that are actually scenario nodes — a job's results can
  // include config nodes too (e.g. "Global variables" reaching "Finished"),
  // which aren't part of node-weighted progress and would otherwise inflate
  // the count past the template's own scenario node total.
  const scenarioIds = new Set(getScenarioNodes(template).map((n) => n.id))
  const ids = new Set<string>()
  getRunsInCycle(template, cycleId).forEach((run) => {
    Object.keys(run.results || {}).forEach((nodeId) => {
      if (scenarioIds.has(nodeId)) ids.add(nodeId)
    })
  })
  return ids
}

// Per-node pass/fail, merged across every run in the cycle with later runs
// overriding earlier ones — so a node that failed once then passed on a
// retry within the same cycle reads as passing, not failing.
export function getNodeResultsInCycle(template: Template, cycleId: string): Record<string, NodeResult> {
  const merged: Record<string, NodeResult> = {}
  const runs = [...getRunsInCycle(template, cycleId)].sort((a, b) => a.timestamp - b.timestamp)
  runs.forEach((run) => {
    Object.entries(run.results || {}).forEach(([nodeId, result]) => {
      merged[nodeId] = result
    })
  })
  return merged
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

// A ticket logged in a past cycle showing up while looking at the current
// one is just noise — it was already dealt with (or deliberately left)
// back then. Scoping by cycle keeps the current view to what's actually
// relevant now; the ticket itself is never deleted, so selecting that past
// cycle elsewhere (the dashboard's own cycle picker) still shows it.
export function getTicketsForTemplateInCycle(template: Template, cycleId: string): Ticket[] {
  return getTicketsForTemplate(template).filter((t) => t.cycleId === cycleId)
}

export function getTicketForRun(template: Template, runId: string | number): Ticket | null {
  return (template.tickets || []).find((t) => t.runId === runId) || null
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

export function computeDashboard(templates: Template[], _cycles: Cycle[], activeCycleId: string, groups: RegressionGroup[]): DashboardSummary {
  const tracked = templates.filter(isRegressionTemplate)

  const rows: DashboardRow[] = tracked.map((t) => {
    const meta = getTemplateMeta(t)
    const lastRun = getLastRun(t, activeCycleId)
    const ticket = lastRun ? getTicketForRun(t, lastRun.id) : null
    const allTicketsForTemplate = getTicketsForTemplateInCycle(t, activeCycleId)
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
    getTicketsForTemplateInCycle(t, activeCycleId).forEach((tk) => allTickets.push({ ...tk, templateId: t.id, templateName: t.symphonyTemplateName }))
  })
  const openTickets = allTickets.filter(isTicketOpen)
  const staleTickets = openTickets.filter(isTicketStale)

  // The "All templates" table's own group filter mirrors the app's
  // user-defined groups (same ones computeCustomGroupDashboard rolls up) —
  // every created group appears here, even an empty one, not just groups
  // that happen to have a tracked template in them right now.
  const groupNames = groups.map((g) => g.name).sort()

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
  }
}

// Cumulative progress for each user-defined group (a set of tracked
// templates the operator chose to track together, e.g. "Azure rollout") —
// separate from Symphony's own group field. "Progress" here means tested
// (pass or fail both count, matching node-weighted progress everywhere
// else in this app), broken out by pass/fail so a group's failures are
// visible at a glance, with a per-template breakdown for drilling in.
export function computeCustomGroupDashboard(templates: Template[], groups: RegressionGroup[], cycleId: string): GroupDashboard[] {
  const tracked = templates.filter(isRegressionTemplate)
  const byId = new Map(tracked.map((t) => [t.id, t]))

  return groups.map((g) => {
    const members = g.templateIds.map((id) => byId.get(id)).filter((t): t is Template => Boolean(t))
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
        pct: scenarioNodes.length ? Math.round(((pass + fail) / scenarioNodes.length) * 100) : 0,
        status: getStatus(t, cycleId),
      }
    })

    const testedNodes = passNodes + failNodes
    return {
      id: g.id,
      name: g.name,
      templateCount: members.length,
      totalNodes,
      testedNodes,
      passNodes,
      failNodes,
      pct: totalNodes ? Math.round((testedNodes / totalNodes) * 100) : 0,
      templates: templateRows,
    }
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
