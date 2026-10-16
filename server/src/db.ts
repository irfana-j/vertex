import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

// A single JSON blob, not a normalized schema — the "dumb backend" design:
// the client keeps running all its existing business logic (tracking,
// syncing, groups, tickets, cycles) exactly as before, and just persists
// its whole state here instead of to localStorage. Good enough for two
// people; a real multi-writer app would need per-entity tables.
//
// Uses Node's built-in node:sqlite rather than a native addon like
// better-sqlite3 — no C++ toolchain needed to install this, on Windows or
// in the (Alpine) Docker image alike.
export interface AppState {
  templates: unknown[]
  cycles: unknown[]
  activeCycleId: string | null
  groups: unknown[]
}

const DEFAULT_STATE: AppState = { templates: [], cycles: [], activeCycleId: null, groups: [] }

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), 'data', 'app.db')
mkdirSync(path.dirname(DB_PATH), { recursive: true })

const db = new DatabaseSync(DB_PATH)
db.exec('PRAGMA journal_mode = WAL')

db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)

export function getState(): AppState {
  const row = db.prepare('SELECT data FROM app_state WHERE id = 1').get() as { data: string } | undefined
  if (!row) {
    setState(DEFAULT_STATE)
    return DEFAULT_STATE
  }
  return JSON.parse(row.data) as AppState
}

export function setState(data: AppState): void {
  db.prepare(
    `INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(JSON.stringify(data), Date.now())
}

// Kept in its own table, never the app_state one above — the PAT in here
// must never go out over GET /api/state, which both roles can read in
// full. Nothing here is encrypted at rest (consistent with how
// ADMIN_PASSWORD/USER_PASSWORD and the Symphony credentials are handled
// elsewhere in this app — plain env vars / a local .env file) — it's only
// as safe as whoever has access to this container's filesystem.
// A list, not a single config — one Vertex deployment can link several
// Azure DevOps organizations, and a ticket picks which one it belongs to.
// Keyed by organization name (unique in practice — that's the tenant id).
export interface AzureDevOpsIntegration {
  organization: string
  project: string
  personalAccessToken: string
}

db.exec(`
  CREATE TABLE IF NOT EXISTS integration_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  )
`)

export function getAzureDevOpsIntegrations(): AzureDevOpsIntegration[] {
  const row = db.prepare('SELECT data FROM integration_settings WHERE id = 1').get() as { data: string } | undefined
  if (!row) return []
  const parsed = JSON.parse(row.data) as { azureDevOps?: unknown }
  // Older builds stored a single object here instead of a list — treat
  // that shape as empty rather than crashing on a shape mismatch.
  return Array.isArray(parsed.azureDevOps) ? (parsed.azureDevOps as AzureDevOpsIntegration[]) : []
}

export function setAzureDevOpsIntegrations(configs: AzureDevOpsIntegration[]): void {
  db.prepare(
    `INSERT INTO integration_settings (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).run(JSON.stringify({ azureDevOps: configs }), Date.now())
}
