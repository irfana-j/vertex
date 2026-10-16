import { SYMPHONY_TEMPLATES, SYMPHONY_JOBS } from '../lib/symphonyConnector'
import { autoLayout } from '../lib/layout'
import { ticketUrl } from '../lib/devopsConnector'
import type { Cycle, FlowEdge, NodeResult, Run, Template, Ticket } from '../types'

// Seed data uses fixed ids, never random ones. This runs fresh on every
// page load (it's a module-level call), and the very first load hasn't
// written anything to localStorage yet — if these ids were random, a
// reload before any user action would regenerate a *different* seed and
// break any deep link (or template card) pointing at the old ids. Fixed
// ids make every fresh load produce byte-identical seed data.
const day = 86400000
const now = Date.now()

// A few job "details" (per-node status + logs) mirrored here so seed
// data can be built synchronously — this is the same data the connector's
// own JOB_DETAILS holds; kept in one small local table rather than
// importing an internal (non-exported) map.
const SEED_JOB_STEPS: Record<string, Record<string, NodeResult>> = {
  job_aws_vm_1: { svc1: { status: 'pass' } },
  job_aws_vm_2: { svc1: { status: 'pass' } },
  job_aws_vm_3: { svc1: { status: 'pass' } },
  job_aws_vm_4: { svc1: { status: 'pass' } },
  job_aws_vm_5: { svc1: { status: 'pass' } },
  job_aws_multi_1: {
    svc1: { status: 'pass' },
    svc2: { status: 'pass' },
    svc3: { status: 'pass' },
    svc4: {
      status: 'fail',
      reason: 'Infra',
      log: "2026-09-26T11:42:03Z ERROR CreateBackupVault: vault 'prod-backup' already exists with a conflicting retention policy (35d requested, 7d existing). Provisioning aborted; svc5/svc6 not attempted.",
    },
  },
  job_azure_disk_1: { svc1: { status: 'pass' } },
  job_azure_disk_2: {
    svc1: {
      status: 'fail',
      reason: 'Infra',
      log: '2026-09-19T08:14:51Z ERROR CreateDisk: QuotaExceeded — westus2 managed-disk quota (2048 GiB) exceeded for subscription. Requested 512 GiB, 128 GiB available.',
    },
  },
  job_azure_vm_1: { svc1: { status: 'pass' }, svc2: { status: 'pass' } },
  job_azure_vm_2: {
    svc1: { status: 'pass' },
    svc2: {
      status: 'fail',
      reason: 'Env',
      log: '2026-09-24T15:03:12Z ERROR AttachDisk: NIC attach timed out after 300s waiting for network context to become available.',
    },
  },
  job_azure_vm_3: { svc1: { status: 'pass' }, svc2: { status: 'pass' } },
  job_azure_vm_4: { svc1: { status: 'pass' }, svc2: { status: 'pass' } },
  job_phoenix_1: { svc1: { status: 'pass' }, svc2: { status: 'pass' }, svc3: { status: 'pass' } },
}

function edge(source: string, target: string): FlowEdge {
  return { id: `edge_${source}_${target}`, source, target, type: 'smoothstep' }
}

function symphonyTemplateById(id: string) {
  return SYMPHONY_TEMPLATES.find((t) => t.id === id)
}

interface TrackForSeedArgs {
  localId: string
  symphonyTemplateId: string
  cycleId: string
  labels: string[]
  jobLimit: number
  createdAt: number
}

// Mirrors what `trackSymphonyTemplate` + `syncJobResults` do at runtime,
// just against the connector's raw (synchronous) data instead of its
// async wrapper, since seed data has to be ready before first render.
function trackForSeed({ localId, symphonyTemplateId, cycleId, labels, jobLimit, createdAt }: TrackForSeedArgs): Template {
  const sym = symphonyTemplateById(symphonyTemplateId)
  if (!sym) throw new Error(`Unknown seed Symphony template id: ${symphonyTemplateId}`)
  const infoNode = {
    id: 'info',
    type: 'regressionInfo',
    position: { x: 0, y: 0 },
    data: { label: 'Template Info', enabled: true, labels },
  }
  const nodes = autoLayout([...sym.nodes, infoNode])
  const edges = sym.edges.map(([s, t]) => edge(s, t)).concat(edge(sym.nodes[sym.nodes.length - 1].id, 'info'))

  const jobs = (SYMPHONY_JOBS[symphonyTemplateId] || []).slice(0, jobLimit)
  const runHistory: Run[] = jobs.map((job) => {
    const steps = SEED_JOB_STEPS[job.jobId] || {}
    const failedStep = Object.values(steps).find((s) => s.status === 'fail')
    return {
      id: job.jobId,
      timestamp: job.finishedAt,
      overallStatus: job.status,
      cycleId,
      results: steps,
      failureReason: failedStep?.reason || null,
    }
  })

  return {
    id: localId,
    symphonyTemplateId,
    symphonyTemplateName: sym.name,
    symphonyGroup: sym.group,
    symphonyOwner: sym.owner,
    description: sym.description,
    nodes,
    edges,
    runHistory,
    tickets: [],
    lastSyncedAt: now,
    createdAt,
    updatedAt: now - day,
  }
}

export interface SeedData {
  templates: Template[]
  cycles: Cycle[]
  activeCycleId: string
}

export function createSeedData(): SeedData {
  // A single active regression cycle — every seeded run happened during it,
  // so numbers match what you'd see before any "Start new cycle" click.
  const cycle: Cycle = { id: 'cycle_seed_sep2026', label: 'Sep 2026', startedAt: now - 27 * day, closedAt: null }
  const cid = cycle.id

  // 1. AWS VM Creation — one scenario node, fully green this cycle.
  const t1 = trackForSeed({
    localId: 'tpl_aws_vm_creation',
    symphonyTemplateId: 'sym_aws_vm_creation',
    cycleId: cid,
    labels: ['Regression', 'AWS'],
    jobLimit: 5,
    createdAt: now - 40 * day,
  })

  // 2. AWS Full Stack Provisioning — six scenario nodes; the one job this
  // cycle stopped after node 4 failed, so nodes 5–6 were never reached —
  // this is the node-weighted-progress example: 4 of 6 scenarios ran,
  // not "1 template done" or "1 template not done."
  const t1b = trackForSeed({
    localId: 'tpl_aws_multi_resource',
    symphonyTemplateId: 'sym_aws_multi_resource',
    cycleId: cid,
    labels: ['Regression', 'AWS'],
    jobLimit: 1,
    createdAt: now - 20 * day,
  })
  const multiFailedJobId = 'job_aws_multi_1'
  const t1bTicket: Ticket = {
    id: 'ticket_t1b_1',
    runId: multiFailedJobId,
    cycleId: cid,
    ticketId: 'TCKT-5001',
    system: 'Azure DevOps',
    organization: null,
    severity: 'Medium',
    status: 'Open',
    assignee: 'Cloud DevOps',
    scenario: 'Create Backup Vault',
    summary: 'Retention policy conflict on existing prod-backup vault',
    url: ticketUrl('Azure DevOps', 'TCKT-5001', null),
    lastActivityAt: now - 11 * day,
    createdAt: now - 3 * day,
  }
  t1b.tickets = [t1bTicket]

  // 3. Azure Disk Creation — a job failed on quota; the ticket was logged
  // AFTER that failure, referencing that exact job.
  const t2 = trackForSeed({
    localId: 'tpl_azure_disk_creation',
    symphonyTemplateId: 'sym_azure_disk_creation',
    cycleId: cid,
    labels: ['Regression', 'Azure'],
    jobLimit: 2,
    createdAt: now - 35 * day,
  })
  const failedJobId = 'job_azure_disk_2'
  const t2Ticket: Ticket = {
    id: 'ticket_t2_1',
    runId: failedJobId,
    cycleId: cid,
    ticketId: 'TCKT-4821',
    system: 'Jira',
    organization: null,
    severity: 'High',
    status: 'Open',
    assignee: 'R. Menon',
    scenario: 'Create Disk',
    summary: 'Quota exceeded provisioning managed disk in westus2',
    url: ticketUrl('Jira', 'TCKT-4821', null),
    lastActivityAt: now - 10 * day,
    createdAt: now - 10 * day + 3600000,
  }
  t2.tickets = [t2Ticket]

  // 4. Azure VM Creation — flaky (pass / fail / pass across recent jobs),
  // no ticket logged yet — a real gap this model makes visible.
  const t3 = trackForSeed({
    localId: 'tpl_azure_vm_creation',
    symphonyTemplateId: 'sym_azure_vm_creation',
    cycleId: cid,
    labels: ['Regression', 'Azure'],
    jobLimit: 4,
    createdAt: now - 45 * day,
  })

  // 5. GCP IAM Role — tracked, but never synced a job this cycle. Its
  // ticket isn't about a failed job (there isn't one yet) — it's a
  // backlog item, logged as a general ticket with no runId.
  const t4 = trackForSeed({
    localId: 'tpl_gcp_iam_role',
    symphonyTemplateId: 'sym_gcp_iam_role',
    cycleId: cid,
    labels: ['Regression', 'GCP'],
    jobLimit: 0,
    createdAt: now - 18 * day,
  })
  const t4Ticket: Ticket = {
    id: 'ticket_t4_1',
    runId: null,
    cycleId: cid,
    ticketId: 'TCKT-4756',
    system: 'Azure DevOps',
    organization: null,
    severity: 'Low',
    status: 'Backlog',
    assignee: 'A. Krishnan',
    scenario: 'Create IAM Role',
    summary: 'Template not yet automated',
    url: ticketUrl('Azure DevOps', 'TCKT-4756', null),
    lastActivityAt: now - 18 * day,
    createdAt: now - 18 * day,
  }
  t4.tickets = [t4Ticket]

  // 6. Phoenix Data Pipeline — a non-cloud "project" group, to prove
  // grouping isn't hardcoded to AWS/Azure/GCP.
  const t5 = trackForSeed({
    localId: 'tpl_phoenix_data_pipeline',
    symphonyTemplateId: 'sym_phoenix_data_pipeline',
    cycleId: cid,
    labels: ['Regression', 'Phoenix'],
    jobLimit: 1,
    createdAt: now - 15 * day,
  })

  return { templates: [t1, t1b, t2, t3, t4, t5], cycles: [cycle], activeCycleId: cid }
}
