import pg from 'pg'

const { Pool } = pg

// A single JSON blob per table, not a normalized schema — the "dumb
// backend" design: the client keeps running all its existing business
// logic (tracking, syncing, groups, tickets, cycles) exactly as before,
// and just persists its whole state here instead of to localStorage. Good
// enough for two people; a real multi-writer app would need per-entity
// tables regardless of which database sits underneath.
export interface AppState {
  templates: unknown[]
  cycles: unknown[]
  activeCycleId: string | null
  groups: unknown[]
}

const DEFAULT_STATE: AppState = { templates: [], cycles: [], activeCycleId: null, groups: [] }

// DATABASE_URL is a standard Postgres connection string:
// postgres://user:password@host:port/dbname
const pool = new Pool({ connectionString: process.env.DATABASE_URL })

// Both tables' schemas are created on first use rather than requiring a
// separate migration step — there's nothing to migrate between versions
// since each table is just one row holding a JSON blob.
//
// Running behind an ALB means more than one instance of this process can
// start at nearly the same moment (a deploy, or just desiredCount > 1) and
// race each other into this block. `CREATE TABLE IF NOT EXISTS` is NOT
// actually safe under that race in Postgres — two instances can both pass
// the "does it exist" check before either commits, and the loser crashes
// on a duplicate-key error against the system catalog (pg_type), taking
// the whole process down with an unhandled rejection. A session-level
// advisory lock serializes this block across every instance hitting the
// same database, so only one of them runs the DDL at a time and the rest
// just wait their turn instead of racing it.
const ready = (async () => {
  const client = await pool.connect()
  try {
    await client.query('SELECT pg_advisory_lock(727200100)')
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `)
    await client.query(`
      CREATE TABLE IF NOT EXISTS integration_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data JSONB NOT NULL,
        updated_at BIGINT NOT NULL
      )
    `)
    // Sessions used to live in an in-memory Map in auth.ts — fine for a
    // single process, but this app runs behind an ALB, and as soon as more
    // than one backend instance is up (or ECS replaces the running task
    // during a deploy), a session created by the instance that handled
    // /api/login is invisible to whichever instance handles the very next
    // request. That's exactly what showed up as "401 right after login" and
    // "every refresh goes back to the login page" — not a timeout problem,
    // a session store that wasn't actually shared. Postgres already is the
    // shared store every instance talks to (same as app_state), so sessions
    // belong here too.
    await client.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        role TEXT NOT NULL,
        last_activity_at BIGINT NOT NULL
      )
    `)
  } finally {
    await client.query('SELECT pg_advisory_unlock(727200100)')
    client.release()
  }
})()

export async function getState(): Promise<AppState> {
  await ready
  const { rows } = await pool.query<{ data: AppState }>('SELECT data FROM app_state WHERE id = 1')
  if (!rows[0]) {
    await setState(DEFAULT_STATE)
    return DEFAULT_STATE
  }
  // node-postgres parses a jsonb column back into a JS value already —
  // no JSON.parse needed, unlike the TEXT column the SQLite version used.
  return rows[0].data
}

export async function setState(data: AppState): Promise<void> {
  await ready
  await pool.query(
    `INSERT INTO app_state (id, data, updated_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [JSON.stringify(data), Date.now()]
  )
}

// Kept in its own table, never the app_state one above — the PAT in here
// must never go out over GET /api/state, which both roles can read in
// full. Nothing here is encrypted at rest (consistent with how
// ADMIN_PASSWORD/USER_PASSWORD and the Symphony credentials are handled
// elsewhere in this app — plain env vars / a local .env file) — it's only
// as safe as whoever has database access.
// A list, not a single config — one Vertex deployment can link several
// Azure DevOps organizations, and a ticket picks which one it belongs to.
// Keyed by organization name (unique in practice — that's the tenant id).
export interface AzureDevOpsIntegration {
  organization: string
  project: string
  personalAccessToken: string
}

export async function getAzureDevOpsIntegrations(): Promise<AzureDevOpsIntegration[]> {
  await ready
  const { rows } = await pool.query<{ data: { azureDevOps?: unknown } }>('SELECT data FROM integration_settings WHERE id = 1')
  if (!rows[0]) return []
  // Older builds stored a single object here instead of a list — treat
  // that shape as empty rather than crashing on a shape mismatch.
  const azureDevOps = rows[0].data.azureDevOps
  return Array.isArray(azureDevOps) ? (azureDevOps as AzureDevOpsIntegration[]) : []
}

export async function setAzureDevOpsIntegrations(configs: AzureDevOpsIntegration[]): Promise<void> {
  await ready
  await pool.query(
    `INSERT INTO integration_settings (id, data, updated_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [JSON.stringify({ azureDevOps: configs }), Date.now()]
  )
}

export interface SessionRecord {
  role: string
  lastActivityAt: number
}

export async function createSession(token: string, role: string): Promise<void> {
  await ready
  await pool.query('INSERT INTO sessions (token, role, last_activity_at) VALUES ($1, $2, $3)', [token, role, Date.now()])
}

export async function getSession(token: string): Promise<SessionRecord | null> {
  await ready
  const { rows } = await pool.query<{ role: string; last_activity_at: string }>(
    'SELECT role, last_activity_at FROM sessions WHERE token = $1',
    [token]
  )
  if (!rows[0]) return null
  // BIGINT comes back as a string from node-postgres (it doesn't fit
  // safely in JS's default number parsing) — cast it back to a number,
  // same unit (epoch ms) it was written with.
  return { role: rows[0].role, lastActivityAt: Number(rows[0].last_activity_at) }
}

export async function touchSession(token: string): Promise<void> {
  await ready
  await pool.query('UPDATE sessions SET last_activity_at = $2 WHERE token = $1', [token, Date.now()])
}

export async function deleteSession(token: string): Promise<void> {
  await ready
  await pool.query('DELETE FROM sessions WHERE token = $1', [token])
}
