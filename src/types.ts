// Core domain model, shared across connectors, selectors, the store, and
// every component. Symphony's own API shapes are intentionally looser
// (`unknown`/defensive optional chaining) where this app is parsing a real
// external response whose exact fields aren't all confirmed — see the
// comments in symphonyConnector.ts for which ones are guesses.

export type Role = 'admin' | 'user'

export interface NodeData {
  label: string
  isScenario?: boolean
  service?: string
  operation?: string
  text?: string
  // regressionInfo node only
  enabled?: boolean
  labels?: string[]
}

export interface FlowNode {
  id: string
  type: string
  position?: { x: number; y: number }
  data: NodeData
}

export interface FlowEdge {
  id: string
  source: string
  target: string
  type?: string
  animated?: boolean
}

export type NodeResultStatus = 'pass' | 'fail'

export interface NodeResult {
  status: NodeResultStatus
  reason?: string | null
  log?: string
}

export interface Run {
  id: string | number
  timestamp: number
  // 'Success' | 'Failed' are this app's own terminal states; any other
  // string is a real Symphony status (e.g. "Running") shown as-is.
  overallStatus: string
  cycleId: string
  results: Record<string, NodeResult>
  liveStatus?: Record<string, string>
  failureReason?: string | null
}

export type TicketStatus = 'Open' | 'Fixed - Verify Pending' | 'Backlog' | 'Closed'
export type TicketSeverity = 'Low' | 'Medium' | 'High'
export type TicketSystem = 'Jira' | 'Azure DevOps'

export interface Ticket {
  id: string
  runId: string | number | null
  cycleId: string
  ticketId: string
  system: TicketSystem
  // Which Azure DevOps org this ticket is linked to — null for a Jira
  // ticket, or an Azure DevOps one logged before multi-org support existed.
  organization: string | null
  severity: TicketSeverity
  status: TicketStatus
  assignee: string
  scenario: string | null
  summary: string
  url: string
  lastActivityAt: number
  createdAt: number
  lastFollowUpAt?: number
}

// What TicketForm.onSubmit hands to the store's logTicket action — just
// the ticket id and which org it's linked to; everything else the form
// used to collect (severity, assignee, summary, scenario) is defaulted,
// since the board itself is the real source of truth for those and "Sync
// from board" already pulls status/assignee in from there.
export interface NewTicketInput {
  ticketId: string
  system: TicketSystem
  organization: string | null
  severity: TicketSeverity
  status: TicketStatus
  assignee: string
  summary: string
  scenario: string | null
  runId: string | number | null
}

export interface Template {
  id: string
  symphonyTemplateId: string
  symphonyTemplateName: string
  symphonyGroup?: string
  symphonyOwner?: string
  symphonyStatus?: string | null
  symphonyEverRun?: boolean
  description: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  runHistory: Run[]
  tickets: Ticket[]
  lastSyncedAt: number
  createdAt: number
  updatedAt: number
}

export interface Cycle {
  id: string
  label: string
  startedAt: number
  closedAt: number | null
}

export interface RegressionGroup {
  id: string
  name: string
  templateIds: string[]
}

// What getSymphonyTemplate() resolves to — not yet wrapped in this app's
// own Template fields (symphonyTemplateId etc.), just what Symphony itself
// returns, mapped to this app's node/edge shape.
export interface SymphonyTemplateDetail {
  id: string
  name: string
  description: string
  group: string
  owner: string
  status: string | null
  everRun: boolean
  nodes: FlowNode[]
  edges: [string, string][]
}

// A row from listSymphonyTemplates() — summary only, no node list.
export interface SymphonyTemplateSummary {
  id: string
  name: string
  description: string
  group: string
  owner: string
  createdAt: number
  nodeCount: number
  status: string | null
}

export interface SymphonyJobSummary {
  jobId: string | number
  finishedAt: number
  status: string
}

export interface SymphonyJobDetail {
  steps: Record<string, NodeResult>
  nodeStatusText?: Record<string, string>
}

export interface SymphonyConnectionStatus {
  connected: boolean
  mode: 'mock' | 'live'
  baseUrl: string
  error?: string
}

export interface TicketBoardStatus {
  status: TicketStatus
  assignee: string
  summary: string
  lastActivityAt: number
  url: string
}

export interface AzureDevOpsIntegrationEntry {
  organization: string
  project: string
  configured: boolean
}

export interface FollowUpResult {
  ok: boolean
  postedAt: number
  text: string
  url: string
}

// ---- computed/derived shapes returned by selectors.ts ----

export interface TemplateMeta {
  owner: string
  enabled: boolean
  labels: string[]
}

export interface DashboardRow {
  id: string
  name: string
  groupNames: string[]
  owner: string
  labels: string[]
  totalNodes: number
  executedNodes: number
  passNodes: number
  failNodes: number
  nodePct: number
  executedThisCycle: boolean
  status: string
  failureReason: string | null
  flaky: boolean
  ticket: Ticket | null
  ticketCount: number
  openTicketCount: number
  staleTicketCount: number
  lastRun: Run | null
  comment: string
}

export interface TicketWithTemplate extends Ticket {
  templateId: string
  templateName: string
}

export interface DashboardSummary {
  rows: DashboardRow[]
  overallPct: number
  totalTemplates: number
  untrackedCount: number
  executedCount: number
  pendingCount: number
  totalNodesSum: number
  executedNodesSum: number
  pendingNodesSum: number
  flakyCount: number
  openTicketsCount: number
  staleTicketsCount: number
  allTickets: TicketWithTemplate[]
  groups: string[]
}

export interface GroupDashboardTemplateRow {
  id: string
  name: string
  totalNodes: number
  passNodes: number
  failNodes: number
  testedNodes: number
  pct: number
  status: string
}

export interface GroupDashboard {
  id: string
  name: string
  templateCount: number
  totalNodes: number
  testedNodes: number
  passNodes: number
  failNodes: number
  pct: number
  templates: GroupDashboardTemplateRow[]
}

export interface CycleTrendPoint {
  cycleId: string
  label: string
  open: boolean
  overallPct: number
}

// ---- backup/restore (export/import) payload shapes ----

export interface FullExportPayload {
  kind: 'full'
  schemaVersion: number
  exportedAt: number
  data: {
    templates: Template[]
    cycles: Cycle[]
    activeCycleId: string | null
    groups: RegressionGroup[]
  }
}

export interface CycleExportPayload {
  kind: 'cycle'
  schemaVersion: number
  exportedAt: number
  cycleId: string
  data: {
    cycle?: Cycle
    templates: Template[]
    groups: RegressionGroup[]
  }
}

export type ExportPayload = FullExportPayload | CycleExportPayload
