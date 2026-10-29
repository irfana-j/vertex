import { randomBytes } from 'node:crypto'
import { parse, serialize } from 'cookie'
import type { NextFunction, Request, Response } from 'express'
import * as db from './db.js'

export type Role = 'admin' | 'user'

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      role?: Role
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
// The cookie's own browser-side lifetime is separate from (and longer
// than) the idle timeout above — it's just how long the browser holds
// onto the cookie at all, not re-issued on every request. The real
// enforcement is server-side: the in-memory session entry it points at
// gets dropped after 30 idle minutes regardless of how long the cookie
// itself still has left.
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

// Sessions live in Postgres (see db.ts) rather than an in-memory Map — this
// app runs behind an ALB, and an in-process Map is only visible to the one
// instance that happens to handle a given request. Real credentials never
// touch the DB; they're only ever compared against env vars set on the server.

// ADMIN_PASSWORD / USER_PASSWORD are expected base64-encoded (e.g.
// `echo -n 'the real password' | base64`) rather than plain text — this is
// NOT encryption, just keeps the literal password from being readable at a
// glance in a docker run command, a .env file, or `docker inspect`. Anyone
// who can read the env var can decode it in one step.
function decodeBase64(value: string): string {
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return value
  }
}

function adminPassword() {
  const raw = process.env.ADMIN_PASSWORD || ''
  return raw ? decodeBase64(raw) : ''
}
function userPassword() {
  const raw = process.env.USER_PASSWORD || ''
  return raw ? decodeBase64(raw) : ''
}
// Usernames aren't secret, so these stay plain text — default to the role
// name itself so existing deployments that haven't set these yet still work.
function adminUsername() {
  return process.env.ADMIN_USERNAME || 'admin'
}
function userUsername() {
  return process.env.USER_USERNAME || 'user'
}

export async function login(username: string, password: string): Promise<{ token: string; role: Role } | null> {
  let role: Role | null = null
  if (adminPassword() && username === adminUsername() && password === adminPassword()) role = 'admin'
  else if (userPassword() && username === userUsername() && password === userPassword()) role = 'user'
  if (!role) return null
  const token = randomBytes(24).toString('hex')
  await db.createSession(token, role)
  return { token, role }
}

export async function logout(token: string | undefined) {
  if (token) await db.deleteSession(token)
}

export function getSessionToken(req: Request): string | undefined {
  return parse(req.headers.cookie || '')[SESSION_COOKIE]
}

async function getSession(req: Request): Promise<{ role: Role } | null> {
  const token = getSessionToken(req)
  if (!token) return null
  const session = await db.getSession(token)
  if (!session) return null
  if (Date.now() - session.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
    await db.deleteSession(token)
    return null
  }
  await db.touchSession(token)
  return { role: session.role as Role }
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
      maxAge: COOKIE_MAX_AGE_MS / 1000,
    })
  )
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', serialize(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }))
}

export async function requireAuth(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await getSession(req)
    if (!session) return res.status(401).json({ error: 'Not logged in' })
    req.role = session.role
    next()
  } catch (err) {
    next(err)
  }
}

export async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  try {
    const session = await getSession(req)
    if (!session) return res.status(401).json({ error: 'Not logged in' })
    if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
    req.role = session.role
    next()
  } catch (err) {
    next(err)
  }
}
