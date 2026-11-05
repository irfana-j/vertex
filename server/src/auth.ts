import { randomBytes } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { parse, serialize } from 'cookie'
import type { NextFunction, Request, Response } from 'express'
import * as db from './db.js'

// Two global roles (see everything), three team-scoped roles (see/act only
// on the team(s) their account is assigned to). A team-scoped account with
// no teamIds assigned yet effectively sees nothing — that's a deliberate
// fail-closed default, not a bug, while an admin finishes setting them up.
export type Role = 'admin' | 'reader' | 'team_admin' | 'team_editor' | 'team_reader'
export const TEAM_SCOPED_ROLES: Role[] = ['team_admin', 'team_editor', 'team_reader']
export function isTeamScopedRole(role: Role): boolean {
  return TEAM_SCOPED_ROLES.includes(role)
}
// team_admin can manage its own team's membership/budget/delete; team_editor
// can raise tickets/sync/edit budget but not manage membership; team_reader
// is read-only. Both non-reader team roles can write within their team(s).
export function canWriteInTeam(role: Role): boolean {
  return role === 'team_admin' || role === 'team_editor'
}

export interface AuthedUser {
  id: string
  username: string
  role: Role
  teamIds: string[]
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthedUser
    }
  }
}

const SESSION_COOKIE = 'vertex_session'
// Idle timeout, not a fixed expiry from login — every authenticated
// request refreshes lastActivityAt, so someone actively using the app
// never gets logged out mid-session; thirty minutes of no requests at all
// (tab left open and unused, laptop closed, etc.) expires it. A page
// refresh after that point naturally lands back on the login screen next
// time checkSession() runs, since /api/session will no longer recognize
// the cookie; a refresh before that point just reloads normally.
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000

// Sessions live in Postgres (see db.ts) rather than an in-memory Map — this
// app runs behind an ALB, and an in-process Map is only visible to the one
// instance that happens to handle a given request. Real credentials never
// touch the DB in plaintext — every password is bcrypt-hashed in app_users
// (see db.ts's bootstrap seeding for the one exception: the legacy
// ADMIN_PASSWORD/USER_PASSWORD env vars, base64-"obscured" only, get hashed
// into app_users the first time this runs against an empty table).

export async function login(username: string, password: string): Promise<{ token: string; role: Role } | null> {
  const user = await db.getUserByUsername(username)
  if (!user) return null
  const ok = await bcrypt.compare(password, user.passwordHash)
  if (!ok) return null
  const token = randomBytes(24).toString('hex')
  await db.createSession(token, user.id)
  return { token, role: user.role as Role }
}

export async function logout(token: string | undefined) {
  if (token) await db.deleteSession(token)
}

export function getSessionToken(req: Request): string | undefined {
  return parse(req.headers.cookie || '')[SESSION_COOKIE]
}

// Role/team assignment is looked up fresh from app_users on every request
// (not frozen into the session at login time) — an admin changing someone's
// role or team takes effect on their very next request, and deleting a user
// immediately invalidates every session they're in, not just future logins.
async function getSession(req: Request): Promise<AuthedUser | null> {
  const token = getSessionToken(req)
  if (!token) return null
  const session = await db.getSession(token)
  if (!session) return null
  if (Date.now() - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
    await db.deleteSession(token)
    return null
  }
  const user = await db.getUserById(session.userId)
  if (!user) {
    await db.deleteSession(token)
    return null
  }
  await db.touchSession(token)
  return { id: user.id, username: user.username, role: user.role as Role, teamIds: user.teamIds }
}

export function getSessionFromRequest(req: Request) {
  return getSession(req)
}

export function setSessionCookie(res: Response, token: string) {
  res.setHeader(
    'Set-Cookie',
    serialize(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      // No maxAge/expires — a browser-session cookie. Closing the browser
      // (not just a tab) discards it, so the next visit always lands back
      // on the login page instead of silently resuming an old session.
      // The 30-minute idle timeout above still applies within one browser
      // session regardless.
    })
  )
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', serialize(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }))
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await getSession(req)
    if (!user) return res.status(401).json({ error: 'Not logged in' })
    req.user = user
    next()
  } catch (err) {
    next(err)
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await getSession(req)
    if (!user) return res.status(401).json({ error: 'Not logged in' })
    if (user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    req.user = user
    next()
  } catch (err) {
    next(err)
  }
}

// Gate for actions that mutate shared data but aren't admin-only — raising
// a ticket, syncing a template, posting a follow-up comment. Readers and
// team_reader are excluded; which specific templates/teams a team_admin or
// team_editor can actually touch is enforced downstream, at the /api/state
// merge (see rbac.ts) — this just keeps read-only accounts out entirely.
export async function requireWriteAccess(req: Request, res: Response, next: NextFunction) {
  try {
    const user = await getSession(req)
    if (!user) return res.status(401).json({ error: 'Not logged in' })
    if (user.role !== 'admin' && !canWriteInTeam(user.role)) {
      return res.status(403).json({ error: 'This account is read-only.' })
    }
    req.user = user
    next()
  } catch (err) {
    next(err)
  }
}
