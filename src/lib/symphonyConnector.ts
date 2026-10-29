import type { FlowEdge, FlowNode, SymphonyConnectionStatus, SymphonyJobDetail, SymphonyJobSummary, SymphonyTemplateDetail, SymphonyTemplateSummary } from '../types'

// Stands in for Symphony's REST API. Every function here is what a real
// integration would call — swap the bodies for real fetch() calls when
// Symphony API access exists; nothing else in the app needs to change,
// since callers only depend on the shapes returned here.
//
// Symphony owns: template structure (every node, not just cloud-service
// ones), which GROUP a template belongs to (a cloud, or a project — that
// grouping is Symphony's call, not this app's), and job results (one job
// per execution, identified by job id, with a pass/fail + log per node).
// This app owns everything about tracking those templates for regression
// (use cases, owner, schedule, tickets, cycles).
//
// ---- Symphony is wired up server-side (see server/src/symphonyProxy.ts) ----
// Customer code / username / password live only on the server now (its own
// SYMPHONY_CUSTOMER_CODE / SYMPHONY_USERNAME / SYMPHONY_PASSWORD env vars),
// never in the client bundle — so there's nothing Symphony-specific this
// app needs baked in at build time (.env.local) at all anymore. The two
// constants below default to this app's own backend proxy paths; only
// override them via VITE_SYMPHONY_BASE_URL/VITE_SYMPHONY_TOKEN_URL if
// you're pointing somewhere other than that proxy for some reason.
const SYMPHONY_BASE_URL = import.meta.env.VITE_SYMPHONY_BASE_URL || '/api/symphony-dnd'
const SYMPHONY_API_TOKEN = import.meta.env.VITE_SYMPHONY_API_TOKEN
const SYMPHONY_TOKEN_URL = import.meta.env.VITE_SYMPHONY_TOKEN_URL || '/api/symphony-auth/token'

// Every real Symphony response below is parsed defensively (`any`/optional
// chaining) rather than fully typed — the exact field names are confirmed
// by capturing live traffic (see the comments at each call site), not from
// a published schema, so treating them as `unknown`-ish is the honest
// reflection of "we're parsing someone else's API," not a shortcut.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type RawApiResponse = any

interface JwtPayload {
  roles?: string[]
  user_name?: string
  // Standard JWT "expires at," seconds since epoch — present on every real
  // Symphony token observed so far. When it's there, it's the actual source
  // of truth for freshness instead of the guessed TOKEN_TTL_MS fallback.
  exp?: number
  [key: string]: unknown
}

// Token exchange: POST { customerCode, username, password } as JSON to the
// auth/token endpoint — every real Symphony call (templates, job sync,
// everything) goes through this first. Caches the result in memory only
// (never persisted).
let cachedToken: string | null = null
let cachedTokenPayload: JwtPayload | null = null
let cachedTokenAt = 0
// Fallback only, for the (so-far unseen) case of a token with no decodable
// `exp` claim — the real expiry from the JWT itself is what normally governs
// refresh timing now, so this no longer needs tuning against Symphony's
// actual session length.
const TOKEN_TTL_MS = 25 * 60 * 1000
// Refresh a bit before the token's real expiry rather than right at it, so
// an in-flight request started just before `exp` doesn't land after it.
const TOKEN_REFRESH_MARGIN_MS = 60 * 1000

// Symphony's token is a JWT — decoding its payload (no verification, it's
// not secret, just base64) is how the app recovers the logged-in user's
// `user_name` and `roles`, which some endpoints (job listing) expect back
// as query params rather than inferring them from the token itself.
function decodeJwtPayload(token: string): JwtPayload | null {
  try {
    const base64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    return JSON.parse(atob(base64)) as JwtPayload
  } catch {
    return null
  }
}

function isCachedTokenFresh(): boolean {
  if (!cachedToken) return false
  const exp = cachedTokenPayload?.exp
  if (typeof exp === 'number') return Date.now() < exp * 1000 - TOKEN_REFRESH_MARGIN_MS
  return Date.now() - cachedTokenAt < TOKEN_TTL_MS
}

// Forces the next getSymphonyBearerToken() call to exchange a brand-new
// token instead of trusting the cache — used when Symphony rejects a
// request with 401 even though the cache still looked fresh (clock skew,
// the token being revoked early on Symphony's side, etc.), so that one
// unexpected 401 can self-heal with a retry instead of surfacing as an
// error the user has to "fix" with an unrelated full page reload.
function invalidateSymphonyToken() {
  cachedToken = null
  cachedTokenPayload = null
  cachedTokenAt = 0
}

async function getSymphonyBearerToken(): Promise<string | null> {
  if (SYMPHONY_API_TOKEN) return SYMPHONY_API_TOKEN
  if (!SYMPHONY_TOKEN_URL) return null
  if (isCachedTokenFresh()) return cachedToken
  // No credentials in the body — the server fills those in from its own
  // env vars (see server/src/symphonyProxy.ts) regardless of what's sent.
  const res = await fetch(SYMPHONY_TOKEN_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
  if (!res.ok) throw new Error(`Symphony token exchange failed: ${res.status}`)
  const data: RawApiResponse = await res.json()
  // Adjust this once the real response shape is confirmed — common shapes
  // are { token }, { accessToken }, or a nested { data: { token } }.
  cachedToken = data.token || data.accessToken || data.data?.token || data.data?.accessToken
  cachedTokenPayload = cachedToken ? decodeJwtPayload(cachedToken) : null
  cachedTokenAt = Date.now()
  return cachedToken
}

type QueryValue = string | number | boolean | string[]

// Shared GET helper for every real Symphony call below — resolves the
// bearer token (static or exchanged), builds the query string (repeating
// a key for each item of an array value, e.g. adminUser[]), and throws on
// a non-OK response so callers don't each repeat this.
//
// The token goes on the Authorization header with NO "Bearer " prefix —
// confirmed from a real captured request; Symphony's API expects the raw
// token there, not the usual "Bearer <token>" form.
async function symphonyGet(path: string, query?: Record<string, QueryValue>): Promise<RawApiResponse> {
  // The base might be a same-origin proxy path (e.g. "/api/symphony-dnd") rather
  // than an absolute URL — the second arg here resolves that case and is
  // ignored when SYMPHONY_BASE_URL is already absolute.
  const url = new URL(`${SYMPHONY_BASE_URL}${path}`, window.location.origin)
  if (query) {
    Object.entries(query).forEach(([k, v]) => {
      if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(k, item))
      else url.searchParams.set(k, String(v))
    })
  }
  const doFetch = async (): Promise<Response> => {
    const token = await getSymphonyBearerToken()
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (token) headers.Authorization = token
    return fetch(url, { headers })
  }
  let res = await doFetch()
  if (res.status === 401 && cachedToken) {
    // The cached token looked fresh but Symphony rejected it anyway — force
    // one real token exchange and retry before giving up, so this can
    // recover on its own instead of needing a full page reload (which only
    // "fixes" it by coincidentally resetting the in-memory token cache).
    invalidateSymphonyToken()
    res = await doFetch()
  }
  if (!res.ok) throw new Error(`Symphony GET ${path} failed: ${res.status}`)
  return res.json()
}

const LATENCY_MS = 300
const day = 86400000
const now = Date.now()

function delay<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), LATENCY_MS))
}

// Symphony's job timestamps come as "DD-MM-YYYY HH:mm:ss" (confirmed real
// sample: "14-10-2026 14:08:14") — not ISO, so `new Date(str)` can't be
// trusted to parse it consistently. Returns epoch ms, or null if unparseable.
function parseSymphonyDate(str: string | undefined | null): number | null {
  if (!str) return null
  const m = /^(\d{2})-(\d{2})-(\d{4})[ T](\d{2}):(\d{2}):(\d{2})/.exec(str)
  if (!m) return null
  const [, dd, mm, yyyy, hh, min, ss] = m
  return new Date(Number(yyyy), Number(mm) - 1, Number(dd), Number(hh), Number(min), Number(ss)).getTime()
}

// ---- mock data (used whenever VITE_SYMPHONY_BASE_URL is unset) ----

interface MockSymphonyTemplate {
  id: string
  name: string
  description: string
  group: string
  owner: string
  createdAt: number
  nodes: FlowNode[]
  edges: [string, string][]
}

// `isScenario: true` nodes are what "number of nodes ran / total nodes"
// progress counts — an actual provisioning step. Setup/config nodes
// (Global Variables and friends) are part of the template and shown on
// the canvas, but aren't scenarios themselves.
function scenarioNode(id: string, label: string, service: string, operation: string): FlowNode {
  return { id, type: 'operation', data: { label, service, operation, isScenario: true } }
}
function configNode(id: string, label: string, text: string): FlowNode {
  return { id, type: 'config', data: { label, text, isScenario: false } }
}

// Chains the first (config) node to every scenario node — reasonable for
// a mock; a real Symphony template's actual edges would come from its
// definition too, if the UI ever needs to show branching instead of a fan-out.
function fanOutEdges(nodes: FlowNode[]): [string, string][] {
  const [first, ...rest] = nodes
  return rest.map((n) => [first.id, n.id])
}

type MockSymphonyTemplateSeed = Omit<MockSymphonyTemplate, 'edges'>

const SYMPHONY_TEMPLATES_SEED: MockSymphonyTemplateSeed[] = [
  {
    id: 'sym_aws_vm_creation',
    name: 'AWS VM Creation',
    description: 'Creates a VM in AWS using the provided template parameters.',
    group: 'AWS',
    owner: 'Cloud DevOps',
    createdAt: now - 95 * day,
    nodes: [configNode('gv', 'Global Variables', 'AWS account, region, key pair.'), scenarioNode('svc1', 'Create VM', 'AWS', 'Create VM')],
  },
  {
    id: 'sym_aws_multi_resource',
    name: 'AWS Full Stack Provisioning',
    description: 'Provisions a complete AWS resource set: compute, storage, backup and IAM in one template.',
    group: 'AWS',
    owner: 'Cloud DevOps',
    createdAt: now - 60 * day,
    nodes: [
      configNode('gv', 'Global Variables', 'AWS account, region, key pair.'),
      scenarioNode('svc1', 'Create VM', 'AWS', 'Create VM'),
      scenarioNode('svc2', 'Create Disk', 'AWS', 'Create Disk'),
      scenarioNode('svc3', 'Attach Disk', 'AWS', 'Attach Disk'),
      scenarioNode('svc4', 'Create Backup Vault', 'AWS', 'Create Backup Vault'),
      scenarioNode('svc5', 'Create IAM Role', 'AWS', 'Create IAM Role'),
      scenarioNode('svc6', 'Install Agent', 'AWS', 'Install Agent'),
    ],
  },
  {
    id: 'sym_azure_disk_creation',
    name: 'Azure Disk Creation',
    description: 'Creates a managed disk in Azure and validates attach readiness.',
    group: 'Azure',
    owner: 'R. Menon',
    createdAt: now - 80 * day,
    nodes: [configNode('gv', 'Global Variables', 'Azure subscription, resource group.'), scenarioNode('svc1', 'Create Disk', 'Azure', 'Create Disk')],
  },
  {
    id: 'sym_azure_vm_creation',
    name: 'Azure VM Creation',
    description: 'Creates a VM in Azure and attaches the primary NIC.',
    group: 'Azure',
    owner: 'S. Iyer',
    createdAt: now - 100 * day,
    nodes: [
      configNode('gv', 'Global Variables', 'Azure subscription, VNet.'),
      scenarioNode('svc1', 'Create VM', 'Azure', 'Create VM'),
      scenarioNode('svc2', 'Attach NIC', 'Azure', 'Attach Disk'),
    ],
  },
  {
    id: 'sym_gcp_iam_role',
    name: 'GCP IAM Role',
    description: 'Creates a custom IAM role and binds it to a service account.',
    group: 'GCP',
    owner: 'A. Krishnan',
    createdAt: now - 40 * day,
    nodes: [configNode('gv', 'Global Variables', 'GCP project, service account.'), scenarioNode('svc1', 'Create IAM Role', 'GCP', 'Create IAM Role')],
  },
  // Not yet tracked by anything in this app — exists in Symphony, shows
  // up in the "track a template" picker so that flow has something to do.
  {
    id: 'sym_aws_backup_vault',
    name: 'AWS Backup Vault Creation',
    description: 'Creates a backup vault and attaches a retention policy.',
    group: 'AWS',
    owner: 'Cloud DevOps',
    createdAt: now - 5 * day,
    nodes: [configNode('gv', 'Global Variables', 'AWS account, region.'), scenarioNode('svc1', 'Create Backup Vault', 'AWS', 'Create Backup Vault')],
  },
  {
    id: 'sym_gcp_network_peering',
    name: 'GCP Network Peering',
    description: 'Establishes VPC peering between two GCP projects.',
    group: 'GCP',
    owner: 'A. Krishnan',
    createdAt: now - 2 * day,
    nodes: [configNode('gv', 'Global Variables', 'GCP project pair, VPC names.'), scenarioNode('svc1', 'Create VM', 'GCP', 'Create VM')],
  },
  // A non-cloud example — grouping in Symphony isn't only by cloud
  // provider, so this app can't assume it is either.
  {
    id: 'sym_phoenix_data_pipeline',
    name: 'Phoenix Data Pipeline',
    description: 'Provisions the ingestion, transform and load stages for the Phoenix project pipeline.',
    group: 'Project Phoenix',
    owner: 'S. Iyer',
    createdAt: now - 15 * day,
    nodes: [
      configNode('gv', 'Global Variables', 'Phoenix project account, region.'),
      scenarioNode('svc1', 'Create Ingestion Queue', 'AWS', 'Create Backup Vault'),
      scenarioNode('svc2', 'Create Transform Job', 'AWS', 'Install Agent'),
      scenarioNode('svc3', 'Create Load Target', 'AWS', 'Create Disk'),
    ],
  },
]

// Symphony realistically holds thousands of templates — these extra ones
// (lightweight, never tracked by seed data) exist purely so the "Track a
// Symphony template" picker's id/date/group filters have enough volume to
// actually be worth using, instead of filtering a list of eight.
const EXTRA_GROUPS = ['AWS', 'Azure', 'GCP', 'Project Phoenix', 'Project Atlas', 'Project Nimbus']
const EXTRA_OWNERS = ['Cloud DevOps', 'R. Menon', 'S. Iyer', 'A. Krishnan']
const EXTRA_OPERATIONS: [string, string][] = [
  ['Create VM', 'AWS'],
  ['Create Disk', 'Azure'],
  ['Attach Disk', 'GCP'],
  ['Create Backup Vault', 'AWS'],
  ['Create IAM Role', 'Azure'],
  ['Install Agent', 'GCP'],
]
function generateExtraTemplates(count: number): MockSymphonyTemplateSeed[] {
  return Array.from({ length: count }, (_, i) => {
    const group = EXTRA_GROUPS[i % EXTRA_GROUPS.length]
    const nodeCount = (i % 4) + 1
    const nodes = [configNode('gv', 'Global Variables', `${group} account/project config.`)]
    for (let n = 0; n < nodeCount; n++) {
      const [operation, service] = EXTRA_OPERATIONS[(i + n) % EXTRA_OPERATIONS.length]
      nodes.push(scenarioNode(`svc${n + 1}`, operation, service, operation))
    }
    return {
      id: `sym_gen_${String(i + 1).padStart(4, '0')}`,
      name: `${group} Template ${i + 1}`,
      description: `Auto-generated ${group} template with ${nodeCount} scenario node${nodeCount > 1 ? 's' : ''}, for filter/volume testing.`,
      group,
      owner: EXTRA_OWNERS[i % EXTRA_OWNERS.length],
      createdAt: now - ((i * 11 + 3) % 150) * day,
      nodes,
    }
  })
}

export const SYMPHONY_TEMPLATES: MockSymphonyTemplate[] = [...SYMPHONY_TEMPLATES_SEED, ...generateExtraTemplates(24)].map((t) => ({
  ...t,
  edges: fanOutEdges(t.nodes),
}))

// Job summaries per template — lightweight, what a job-list endpoint
// returns. Full per-node status + logs come from getJobDetail(jobId),
// fetched only for jobs this app hasn't ingested yet.
export const SYMPHONY_JOBS: Record<string, SymphonyJobSummary[]> = {
  sym_aws_vm_creation: Array.from({ length: 5 }, (_, i) => ({ jobId: `job_aws_vm_${i + 1}`, finishedAt: now - (5 - i) * day, status: 'Success' })),
  sym_aws_multi_resource: [{ jobId: 'job_aws_multi_1', finishedAt: now - 3 * day, status: 'Failed' }],
  sym_azure_disk_creation: [
    { jobId: 'job_azure_disk_1', finishedAt: now - 12 * day, status: 'Success' },
    { jobId: 'job_azure_disk_2', finishedAt: now - 10 * day, status: 'Failed' },
  ],
  sym_azure_vm_creation: [
    { jobId: 'job_azure_vm_1', finishedAt: now - 9 * day, status: 'Success' },
    { jobId: 'job_azure_vm_2', finishedAt: now - 6 * day, status: 'Failed' },
    { jobId: 'job_azure_vm_3', finishedAt: now - 2 * day, status: 'Success' },
    { jobId: 'job_azure_vm_4', finishedAt: now - 1 * day, status: 'Success' },
  ],
  sym_gcp_iam_role: [],
  sym_aws_backup_vault: [],
  sym_gcp_network_peering: [],
  sym_phoenix_data_pipeline: [{ jobId: 'job_phoenix_1', finishedAt: now - 4 * day, status: 'Success' }],
}

// Full per-node results for each job — what `/flexijobs/jobdetail/{id}`
// returns in the real pipeline. A node missing from `steps` means the job
// never reached it (e.g. the run stopped after an earlier node failed).
const JOB_DETAILS: Record<string, SymphonyJobDetail> = {
  job_aws_vm_1: { steps: { svc1: { status: 'pass' } } },
  job_aws_vm_2: { steps: { svc1: { status: 'pass' } } },
  job_aws_vm_3: { steps: { svc1: { status: 'pass' } } },
  job_aws_vm_4: { steps: { svc1: { status: 'pass' } } },
  job_aws_vm_5: { steps: { svc1: { status: 'pass' } } },
  job_aws_multi_1: {
    steps: {
      svc1: { status: 'pass' },
      svc2: { status: 'pass' },
      svc3: { status: 'pass' },
      svc4: {
        status: 'fail',
        reason: 'Infra',
        log: "2026-09-26T11:42:03Z ERROR CreateBackupVault: vault 'prod-backup' already exists with a conflicting retention policy (35d requested, 7d existing). Provisioning aborted; svc5/svc6 not attempted.",
      },
    },
  },
  job_azure_disk_1: { steps: { svc1: { status: 'pass' } } },
  job_azure_disk_2: {
    steps: {
      svc1: {
        status: 'fail',
        reason: 'Infra',
        log: '2026-09-19T08:14:51Z ERROR CreateDisk: QuotaExceeded — westus2 managed-disk quota (2048 GiB) exceeded for subscription. Requested 512 GiB, 128 GiB available.',
      },
    },
  },
  job_azure_vm_1: { steps: { svc1: { status: 'pass' }, svc2: { status: 'pass' } } },
  job_azure_vm_2: {
    steps: {
      svc1: { status: 'pass' },
      svc2: {
        status: 'fail',
        reason: 'Env',
        log: '2026-09-24T15:03:12Z ERROR AttachDisk: NIC attach timed out after 300s waiting for network context to become available.',
      },
    },
  },
  job_azure_vm_3: { steps: { svc1: { status: 'pass' }, svc2: { status: 'pass' } } },
  job_azure_vm_4: { steps: { svc1: { status: 'pass' }, svc2: { status: 'pass' } } },
  job_phoenix_1: { steps: { svc1: { status: 'pass' }, svc2: { status: 'pass' }, svc3: { status: 'pass' } } },
}

// ---- connector API — this is the boundary a real integration replaces ----

export async function getConnectionStatus(): Promise<SymphonyConnectionStatus> {
  if (!SYMPHONY_BASE_URL) return delay({ connected: true, mode: 'mock', baseUrl: 'https://symphony.internal/api (mock)' })
  // No dedicated health endpoint is confirmed, so this reuses the same
  // token exchange every real call already depends on — if that succeeds
  // (or is already cached from a prior call), the connection is genuinely live.
  try {
    await getSymphonyBearerToken()
    return { connected: true, mode: 'live', baseUrl: SYMPHONY_BASE_URL }
  } catch (err) {
    return { connected: false, mode: 'live', baseUrl: SYMPHONY_BASE_URL, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface SymphonyTemplateList extends Array<SymphonyTemplateSummary> {
  totalCount?: number
  allTemplateCount?: number
}

// Worked example — every other function below follows this same shape:
// check SYMPHONY_BASE_URL, call fetch() with the Bearer token, map the
// response into the shape this function already returns from mock data.
//
// Query params mirror the real GET /templates endpoint's filter contract
// (pagination, search, group filter via filterInfo[]). pageSize is set
// high since this app does its own search/group/date filtering client
// side on top of whatever page this pulls — tighten it down (and start
// passing filterInfo) once this needs to page through thousands for real.
export async function listSymphonyTemplates(): Promise<SymphonyTemplateList> {
  if (SYMPHONY_BASE_URL) {
    const baseQuery = {
      globalSearch: '',
      // false returns every template tenant-wide (matches allTemplateCount
      // in the response) — true would scope results to just the logged-in
      // account's own templates (myTemplateCount), which misses templates
      // owned by other users.
      viewAllTemplatesFlag: false,
      // Was `true` — unlike every other flag here, it had no comment
      // explaining why, which is exactly how a one-off incidental UI state
      // (Symphony's own "Favorites" toggle happening to be on when this
      // request was captured) ends up baked in by accident. `false` here
      // matches favButton below (already `false`) and stops this from
      // silently filtering out every template that was never individually
      // favorited, regardless of whether the account has real access to it.
      favouriteFlag: false,
      favButton: false,
      selectedTempStatus: 'All',
      sharedTemplateFlag: false,
      table: 'active',
      standard: false,
      order: 'desc',
      orderBy: '',
      'filterInfo[0][filterKey]': 'Filter By Group',
      'filterInfo[0][filterOperator]': '',
    }
    // Probe with pageSize=1 first just to read totalCount cheaply, then
    // fetch one full page sized to match — avoids guessing a fixed page
    // size that's either too small (truncates "1000s of templates") or
    // rejected outright as too large by the server.
    //
    // Confirmed real envelope: { flag, data: { totalCount, allTemplateCount,
    // myTemplateCount, sharedTemplateCount, totalData: [...] } }. totalCount
    // is what this endpoint can actually return rows for; allTemplateCount
    // is the whole tenant's count — in testing against this account these
    // two differed a lot (177 vs 17758) and no combination of the query
    // flags closed that gap, which points at an account-permission scope
    // (this account can only list templates shared with/owned by it, not
    // the entire tenant) rather than a wrong query.
    const probe = await symphonyGet('/templates', { ...baseQuery, pageSize: 1, pageNumber: 1 })
    const totalCount = Number(probe?.data?.totalCount) || 0
    const allTemplateCount = Number(probe?.data?.allTemplateCount) || totalCount
    if (totalCount === 0) return Object.assign([], { totalCount: 0, allTemplateCount })
    const full = await symphonyGet('/templates', { ...baseQuery, pageSize: Math.min(totalCount, 5000), pageNumber: 1 })
    const list: RawApiResponse[] = full?.data?.totalData ?? []
    if (list[0]) console.log('[Symphony] raw template row:', list[0])
    const mapped: SymphonyTemplateList = list.map((t) => {
      const createdRaw = t.createdOn ?? t.updatedOnDateOnly ?? t.updatedOn
      return {
        // Confirmed live: Symphony's own JSON returns this as a number, not
        // a string — coerced here so every id this app ever stores/compares
        // is consistently a string, matching its own type. Left as `any`
        // upstream, a bare number silently passing as `string` is exactly
        // how listJobsForTemplate's `===` match against it went stale (a
        // string-vs-number strict-equals is always false).
        id: String(t.template_id ?? t.templateId ?? t.id),
        name: t.template_name ?? t.templateName ?? t.name,
        description: t.description ?? '',
        group: t.templateGroups?.[0] ?? t.template_group ?? t.group ?? 'Unknown',
        owner: t.templateOwners?.length ? t.templateOwners.join(', ') : (t.user_name ?? t.updatedBy ?? 'Unassigned'),
        createdAt: createdRaw ? new Date(createdRaw).getTime() : Date.now(),
        nodeCount: t.nodeCount ?? t.nodesCount ?? 0,
        status: t.status ?? null,
      }
    })
    // Extra props — stays a plain array (map/filter/length all still work
    // normally), but callers can check these to show the account-visible
    // count alongside the (likely larger, likely inaccessible) tenant total.
    mapped.totalCount = totalCount
    mapped.allTemplateCount = allTemplateCount
    return mapped
  }
  return delay(
    SYMPHONY_TEMPLATES.map(({ id, name, description, group, owner, createdAt, nodes }) => ({
      id,
      name,
      description,
      group,
      owner,
      createdAt,
      nodeCount: nodes.length,
      status: null,
    }))
  )
}

// UNCONFIRMED endpoint — guessed as the singular counterpart to the list
// endpoint (GET /templates/{id}), returning the same shape captured in a
// real exported template (process_flow + stepInfoDetails, template_id,
// template_name, etc.) If this 404s or shape-mismatches, open this exact
// template for edit in Symphony's own UI, check the Network tab for the
// real URL/response, and this can be corrected the same way the token and
// jobs endpoints were.
// Confirmed real endpoint (captured from a live "view template" request):
// GET /templates/{id}?id={id}&table=active&intentRequired=true&type=viewTemplate
// Confirmed real envelope: { flag, data: { ..., stepInfoDetails: [...], template_id, template_name, templateOwners, templateGroups } }.
export async function getSymphonyTemplate(symphonyTemplateId: string): Promise<SymphonyTemplateDetail | null> {
  if (SYMPHONY_BASE_URL) {
    await getSymphonyBearerToken()
    const roles = cachedTokenPayload?.roles || []
    const data = await symphonyGet(`/templates/${symphonyTemplateId}`, {
      id: symphonyTemplateId,
      table: 'active',
      intentRequired: true,
      type: 'viewTemplate',
      ...(roles.length ? { 'userRoleName[]': roles } : {}),
    })
    const tpl: RawApiResponse = data?.data ?? data
    const steps: RawApiResponse[] = tpl?.stepInfoDetails ?? []
    // Heuristic — confirmed real templates mix setup/flow-control steps
    // ("Global variables", "Breakpoint", "*Decision") in with actual
    // provisioning actions in the same stepInfoDetails list. Only those
    // three kinds are excluded from node-weighted progress; everything
    // else counts as a scenario — deliberately NOT excluding by name
    // like "Start" otherwise, since a real action node can legitimately
    // be named e.g. "StartVM" and must still count.
    const NON_SCENARIO_NAMES = new Set(['global variables', 'global variable', 'breakpoint'])
    const isNonScenario = (s: RawApiResponse) => {
      const label = (s.name ?? s.key ?? '').trim().toLowerCase()
      return NON_SCENARIO_NAMES.has(label) || label.endsWith('decision')
    }
    const nodes: FlowNode[] = steps.map((s) => ({
      id: s.id ?? s.key,
      type: isNonScenario(s) ? 'config' : 'operation',
      data: {
        label: s.name ?? s.key ?? s.id,
        text: s.stepInfo?.stepDescription ?? '',
        isScenario: !isNonScenario(s),
      },
    }))
    const edges: FlowEdge[] = steps.flatMap((s) =>
      (s.children || []).map((c: RawApiResponse) => ({ id: `edge_${s.id ?? s.key}_${c.id ?? c.key}`, source: s.id ?? s.key, target: c.id ?? c.key }))
    )
    return {
      id: String(tpl?.template_id ?? symphonyTemplateId),
      name: tpl?.template_name ?? '',
      description: tpl?.description ?? '',
      group: tpl?.templateGroups?.[0] ?? 'Unknown',
      owner: tpl?.templateOwners?.length ? tpl.templateOwners.join(', ') : 'Unassigned',
      // Surfaced so the UI can explain an empty run history as "never run
      // in Symphony yet" instead of looking like a sync failure — confirmed
      // real example: a Draft template with lastSuccessfulRun: null and
      // genuinely zero matching jobs.
      status: tpl?.status ?? null,
      everRun: Boolean(tpl?.lastSuccessfulRun),
      // Returned as a typed FlowNode/FlowEdge pair here; nodeFactory/useStore
      // (via autoLayout) convert edges into the app's own FlowEdge objects.
      nodes,
      edges: edges.map((e) => [e.source, e.target] as [string, string]),
    }
  }
  const tpl = SYMPHONY_TEMPLATES.find((t) => t.id === symphonyTemplateId)
  if (!tpl) return delay(null)
  return delay({
    id: tpl.id,
    name: tpl.name,
    description: tpl.description,
    group: tpl.group,
    owner: tpl.owner,
    status: null,
    everRun: true,
    nodes: structuredClone(tpl.nodes),
    edges: structuredClone(tpl.edges),
  })
}

// Lightweight — just enough to tell what's new since the last sync.
// `search` is NOT a template-id filter, despite looking like one — confirmed
// live: passing a template's id (or even its exact name) as `search` returns
// zero rows, while an unfiltered call returns every job this account can
// see (its real behavior is a free-text match over job name/title). The
// response rows do carry the real template reference though — `templateId`
// (number) and `templateIdString` (same value as a string) — confirmed by
// inspecting a live row, so this pulls the account's visible jobs and
// filters by those fields client-side instead of trusting `search` to
// scope the request server-side.
// `adminUser[]`/`user_name` come off the logged-in user's own token rather
// than being hardcoded, since those are specific to whoever's token this is.
export async function listJobsForTemplate(symphonyTemplateId: string): Promise<SymphonyJobSummary[]> {
  if (SYMPHONY_BASE_URL) {
    await getSymphonyBearerToken()
    const roles = cachedTokenPayload?.roles || []
    const userName = cachedTokenPayload?.user_name || ''
    const pad = (n: number) => String(n).padStart(2, '0')
    const todayEnd = new Date()
    const toLocal = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
    const data = await symphonyGet('/jobs', {
      pageSize: 1000,
      pageNumber: 0,
      job_name: '',
      job_title: '',
      parent_job_id: '',
      runStartTime: '',
      runEndTime: '',
      status: 'All',
      user_name: userName,
      'adminUser[]': roles,
      viewAllJobsFlag: 'All Jobs',
      calendarView: false,
      search: '',
      jobstatusValue: 'All',
      // Sorted by actual run time (not job_name) so the latest run is what
      // this app ingests first — adjust the field name if the real API
      // uses a different key for a job's start/finish timestamp.
      orderBy: 'runStartTime',
      order: 'desc',
      // Unlike the templates call's group filter, this date range is NOT
      // inert even with an empty filterOperator — confirmed live: a narrow
      // range genuinely excludes jobs outside it. So this spans a wide
      // window (10 years back to today) rather than "today only", or
      // syncing would silently miss every job that didn't run today.
      'filterInfo[0][filterKey]': 'Date Filter',
      'filterInfo[0][filterStartDateTime]': `${toLocal(new Date(todayEnd.getFullYear() - 10, todayEnd.getMonth(), todayEnd.getDate()))}T00:00`,
      'filterInfo[0][filterEndDateTime]': `${toLocal(todayEnd)}T23:59`,
      'filterInfo[0][filterOperator]': '',
      'filterInfo[0][filterDateOperator]': 'Quick Filter',
    })
    // Confirmed real envelope: { flag, data: [{ totalData: [...], totalAllJobCount, ... }] } —
    // `data` is a one-element array wrapping the summary object, not the row list itself.
    const allVisible: RawApiResponse[] = data?.data?.[0]?.totalData ?? []
    // String() on both sides, not just the row's field — confirmed live
    // that a template id can arrive here as a number despite this
    // function's own `string` signature (traced back to an `any`-typed
    // Symphony field upstream), and `"20106" === 20106` is always false.
    const targetId = String(symphonyTemplateId)
    const list = allVisible.filter((j) => String(j.templateId ?? '') === targetId || String(j.templateIdString ?? '') === targetId)
    return list.map((j) => ({
      // Confirmed real fields: jobIdNumber (number) / job_name (same value, as a string).
      jobId: j.jobIdNumber ?? j.job_name ?? j.jobId ?? j.job_id ?? j.id,
      finishedAt: parseSymphonyDate(j.runEndTime) ?? parseSymphonyDate(j.runStartTime) ?? Date.now(),
      // Confirmed real value for a failed job is exactly "Failed" (matches
      // this app's own vocabulary already); the success value wasn't seen
      // in testing (only a failed job was captured), so this normalizes
      // likely variants ("Finished"/"Completed", matching the per-node
      // status wording) to "Success" rather than assuming the exact string.
      status: /^(finished|success|completed)$/i.test(j.status ?? '') ? 'Success' : (j.status ?? j.job_status ?? 'Unknown'),
    }))
  }
  return delay(structuredClone(SYMPHONY_JOBS[symphonyTemplateId] || []))
}

// Full per-node status + logs for one job, fetched by job id — mirrors
// the existing `/flexijobs/jobdetail/{id}` pattern.
// Confirmed real endpoint (captured from a live "open job" request):
// GET /jobs/{jobId} — { flag, data: { ..., process_flow: [{ nodeDetails: { nodeId, nodeName, status, ... } }], stepInfoDetails: [...] } }.
// Per-node status lives in process_flow[i].nodeDetails, NOT stepInfoDetails
// (that only has each node's config/parameters). nodeDetails.nodeId matches
// stepInfoDetails[i].id one-for-one, which is the same id getSymphonyTemplate()
// uses for each node, so these line up without any extra mapping step.
function mapSymphonyNodeStatus(status: string | undefined): 'pass' | 'fail' | null {
  const s = (status || '').toLowerCase()
  if (['finished', 'success', 'completed'].includes(s)) return 'pass'
  if (['failed', 'error'].includes(s)) return 'fail'
  return null // "Planned"/"Running"/etc. — not yet reached, left out below
}

export async function getJobDetail(jobId: string | number): Promise<SymphonyJobDetail> {
  if (SYMPHONY_BASE_URL) {
    const data = await symphonyGet(`/jobs/${jobId}`)
    const job: RawApiResponse = data?.data ?? data
    const flow: RawApiResponse[] = job?.process_flow ?? []
    const steps: SymphonyJobDetail['steps'] = {}
    const nodeStatusText: Record<string, string> = {}
    for (const n of flow) {
      const nd = n.nodeDetails
      if (!nd) continue
      const mapped = mapSymphonyNodeStatus(nd.status)
      // A node missing from `steps` still means "not counted as executed
      // yet" for progress purposes (pass/fail is all that feeds node-weighted
      // progress) — but its real Symphony status ("Running", "Planned", etc.)
      // is kept in nodeStatusText so the UI can show that instead of a
      // generic "not reached" while a job is still mid-execution.
      if (mapped) steps[nd.nodeId] = { status: mapped }
      if (nd.status) nodeStatusText[nd.nodeId] = nd.status
    }
    // Confirmed real endpoint (captured live): GET /jobs/{jobId}/node/{nodeId}/logs
    // — { flag, data: "<plain-text log, possibly spanning this node's other
    // runs too>" }. Only fetched for failed nodes (in parallel), since that's
    // the only place the UI shows a log and this is an extra request per node.
    const failedIds = Object.keys(steps).filter((id) => steps[id].status === 'fail')
    await Promise.all(
      failedIds.map(async (nodeId) => {
        try {
          const logRes = await symphonyGet(`/jobs/${jobId}/node/${nodeId}/logs`)
          const text = logRes?.data ?? logRes
          if (typeof text === 'string' && text.trim()) steps[nodeId].log = text
        } catch {
          // Leave log unset — the UI already falls back to "No log captured."
        }
      })
    )
    return { steps, nodeStatusText }
  }
  const detail = JOB_DETAILS[jobId]
  return delay(detail ? structuredClone(detail) : { steps: {} })
}
