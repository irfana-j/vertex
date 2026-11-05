import pg from 'pg'
import bcrypt from 'bcryptjs'
import { randomUUID } from 'node:crypto'

const { Pool } = pg

// A managed Postgres (RDS, etc.) occasionally drops or resets a connection
// out from under a query — a failover, a maintenance blip, a connection
// recycled by the server side while idle in the pool. node-postgres doesn't
// retry these itself, and since every authenticated request runs a session
// check against this same database, a single transient blip showed up as a
// 500 on practically any page load, not just one feature. Retrying a
// couple of times on exactly these connection-level failures (never on a
// real query error like a constraint violation) turns that into a brief
// delay instead of a visible error.
const RETRYABLE_PG_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', '57P01', '08006', '08003', '08001', '08004'])
const RETRY_DELAYS_MS = [150, 500]

async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(text: string, params?: unknown[]): Promise<pg.QueryResult<T>> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await pool.query<T>(text, params)
    } catch (err) {
      const code = (err as { code?: string } | null)?.code
      if (attempt >= RETRY_DELAYS_MS.length || !code || !RETRYABLE_PG_CODES.has(code)) throw err
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]))
    }
  }
}

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
  teams: unknown[]
}

const DEFAULT_STATE: AppState = { templates: [], cycles: [], activeCycleId: null, groups: [], teams: [] }

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
    // A session used to just carry a bare role string (one shared admin
    // account, one shared reader account) — real RBAC needs to know WHICH
    // person, so a session can look up their current role/team assignment
    // on every request instead of freezing it at login time (an admin
    // changing someone's role or team mid-session takes effect on their
    // very next request, not just their next login). `role` above stays —
    // harmless, unused going forward — rather than dropping a column on a
    // table with no real migration tooling.
    await client.query('ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_id TEXT')
    // Real named accounts — replaces the old single-shared-admin /
    // single-shared-reader login. team_ids is only meaningful for a
    // team-scoped role (team_admin / team_editor / team_reader); empty for
    // the two global roles (admin, reader).
    await client.query(`
      CREATE TABLE IF NOT EXISTS app_users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL,
        team_ids JSONB NOT NULL DEFAULT '[]',
        created_at BIGINT NOT NULL
      )
    `)
    // Bootstrap: the very first deploy of real user accounts has nobody in
    // app_users yet — seed it once from the existing ADMIN_USERNAME/
    // ADMIN_PASSWORD and USER_USERNAME/USER_PASSWORD env vars (the old
    // shared-login credentials) so upgrading doesn't lock anyone out. Only
    // runs while the table is still empty — once an admin starts managing
    // real users, this never touches it again, even if the env vars stay set.
    const { rows: userCountRows } = await client.query<{ count: string }>('SELECT COUNT(*) AS count FROM app_users')
    if (Number(userCountRows[0]?.count ?? 0) === 0) {
      const decodeBase64 = (value: string) => {
        try {
          return Buffer.from(value, 'base64').toString('utf8')
        } catch {
          return value
        }
      }
      const seedAccounts: { username: string; password: string; role: string }[] = []
      const adminPasswordRaw = process.env.ADMIN_PASSWORD || ''
      if (adminPasswordRaw) {
        seedAccounts.push({ username: process.env.ADMIN_USERNAME || 'admin', password: decodeBase64(adminPasswordRaw), role: 'admin' })
      }
      const readerPasswordRaw = process.env.USER_PASSWORD || ''
      if (readerPasswordRaw) {
        seedAccounts.push({ username: process.env.USER_USERNAME || 'user', password: decodeBase64(readerPasswordRaw), role: 'reader' })
      }
      for (const account of seedAccounts) {
        const passwordHash = await bcrypt.hash(account.password, 10)
        await client.query(
          'INSERT INTO app_users (id, username, password_hash, role, team_ids, created_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (username) DO NOTHING',
          [randomUUID(), account.username, passwordHash, account.role, JSON.stringify([]), Date.now()]
        )
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727200100)')
    client.release()
  }
})()

export async function getState(): Promise<AppState> {
  await ready
  const { rows } = await query<{ data: AppState }>('SELECT data FROM app_state WHERE id = 1')
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
  await query(
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
  const { rows } = await query<{ data: { azureDevOps?: unknown } }>('SELECT data FROM integration_settings WHERE id = 1')
  if (!rows[0]) return []
  // Older builds stored a single object here instead of a list — treat
  // that shape as empty rather than crashing on a shape mismatch.
  const azureDevOps = rows[0].data.azureDevOps
  return Array.isArray(azureDevOps) ? (azureDevOps as AzureDevOpsIntegration[]) : []
}

export async function setAzureDevOpsIntegrations(configs: AzureDevOpsIntegration[]): Promise<void> {
  await ready
  await query(
    `INSERT INTO integration_settings (id, data, updated_at) VALUES (1, $1, $2)
     ON CONFLICT (id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [JSON.stringify({ azureDevOps: configs }), Date.now()]
  )
}

// A session now only has to carry which user it belongs to — role and team
// assignment are looked up fresh from app_users on every request (see
// getSession below), so an admin changing someone's role or team takes
// effect on their very next request rather than waiting for them to log in
// again.
export interface SessionRecord {
  userId: string
  lastActivityAt: number
}

export async function createSession(token: string, userId: string): Promise<void> {
  await ready
  await query('INSERT INTO sessions (token, role, user_id, last_activity_at) VALUES ($1, $2, $3, $4)', [token, '', userId, Date.now()])
}

export async function getSession(token: string): Promise<SessionRecord | null> {
  await ready
  const { rows } = await query<{ user_id: string | null; last_activity_at: string }>(
    'SELECT user_id, last_activity_at FROM sessions WHERE token = $1',
    [token]
  )
  if (!rows[0] || !rows[0].user_id) return null
  // BIGINT comes back as a string from node-postgres (it doesn't fit
  // safely in JS's default number parsing) — cast it back to a number,
  // same unit (epoch ms) it was written with.
  return { userId: rows[0].user_id, lastActivityAt: Number(rows[0].last_activity_at) }
}

export async function touchSession(token: string): Promise<void> {
  await ready
  await query('UPDATE sessions SET last_activity_at = $2 WHERE token = $1', [token, Date.now()])
}

export async function deleteSession(token: string): Promise<void> {
  await ready
  await query('DELETE FROM sessions WHERE token = $1', [token])
}

// ---- users (real named accounts — RBAC) ----
// role is one of: 'admin' | 'reader' (global) | 'team_admin' | 'team_editor'
// | 'team_reader' (scoped to teamIds). Kept as a plain string here, same as
// everywhere else in this file — the actual Role union lives in auth.ts,
// the only place that needs to reason about its specific values.
export interface AppUser {
  id: string
  username: string
  role: string
  teamIds: string[]
  createdAt: number
}
export interface AppUserWithHash extends AppUser {
  passwordHash: string
}

function rowToUser(row: { id: string; username: string; role: string; team_ids: unknown; created_at: string; password_hash: string }): AppUserWithHash {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    teamIds: Array.isArray(row.team_ids) ? (row.team_ids as string[]) : [],
    createdAt: Number(row.created_at),
    passwordHash: row.password_hash,
  }
}

export async function listUsers(): Promise<AppUser[]> {
  await ready
  const { rows } = await query<{ id: string; username: string; role: string; team_ids: unknown; created_at: string; password_hash: string }>(
    'SELECT id, username, role, team_ids, created_at, password_hash FROM app_users ORDER BY created_at ASC'
  )
  return rows.map(rowToUser).map((u) => ({ id: u.id, username: u.username, role: u.role, teamIds: u.teamIds, createdAt: u.createdAt }))
}

export async function getUserByUsername(username: string): Promise<AppUserWithHash | null> {
  await ready
  const { rows } = await query<{ id: string; username: string; role: string; team_ids: unknown; created_at: string; password_hash: string }>(
    'SELECT id, username, role, team_ids, created_at, password_hash FROM app_users WHERE username = $1',
    [username]
  )
  return rows[0] ? rowToUser(rows[0]) : null
}

export async function getUserById(id: string): Promise<AppUserWithHash | null> {
  await ready
  const { rows } = await query<{ id: string; username: string; role: string; team_ids: unknown; created_at: string; password_hash: string }>(
    'SELECT id, username, role, team_ids, created_at, password_hash FROM app_users WHERE id = $1',
    [id]
  )
  return rows[0] ? rowToUser(rows[0]) : null
}

export async function createUser(input: { username: string; passwordHash: string; role: string; teamIds: string[] }): Promise<AppUser> {
  await ready
  const id = randomUUID()
  const createdAt = Date.now()
  await query(
    'INSERT INTO app_users (id, username, password_hash, role, team_ids, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
    [id, input.username, input.passwordHash, input.role, JSON.stringify(input.teamIds), createdAt]
  )
  return { id, username: input.username, role: input.role, teamIds: input.teamIds, createdAt }
}

// `passwordHash` only present when the caller is actually resetting the
// password — omitted on a plain role/team edit so it's never overwritten
// with something stale.
export async function updateUser(id: string, patch: { role?: string; teamIds?: string[]; passwordHash?: string }): Promise<void> {
  await ready
  if (patch.role !== undefined) await query('UPDATE app_users SET role = $2 WHERE id = $1', [id, patch.role])
  if (patch.teamIds !== undefined) await query('UPDATE app_users SET team_ids = $2 WHERE id = $1', [id, JSON.stringify(patch.teamIds)])
  if (patch.passwordHash !== undefined) await query('UPDATE app_users SET password_hash = $2 WHERE id = $1', [id, patch.passwordHash])
}

export async function deleteUser(id: string): Promise<void> {
  await ready
  await query('DELETE FROM app_users WHERE id = $1', [id])
}
