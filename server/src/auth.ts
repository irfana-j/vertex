import { randomBytes } from 'node:crypto'
import { parse, serialize } from 'cookie'
import type { NextFunction, Request, Response } from 'express'

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
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

// In-memory — a restart logs everyone out, which is a fine trade-off for
// two people on an internal tool. Real credentials never touch the DB;
// they're only ever compared against env vars set on the server.
const sessions = new Map<string, { role: Role; createdAt: number }>()

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

export function login(username: string, password: string): { token: string; role: Role } | null {
  let role: Role | null = null
  if (adminPassword() && username === adminUsername() && password === adminPassword()) role = 'admin'
  else if (userPassword() && username === userUsername() && password === userPassword()) role = 'user'
  if (!role) return null
  const token = randomBytes(24).toString('hex')
  sessions.set(token, { role, createdAt: Date.now() })
  return { token, role }
}

export function logout(token: string | undefined) {
  if (token) sessions.delete(token)
}

export function getSessionToken(req: Request): string | undefined {
  return parse(req.headers.cookie || '')[SESSION_COOKIE]
}

function getSession(req: Request): { role: Role } | null {
  const token = getSessionToken(req)
  if (!token) return null
  const session = sessions.get(token)
  if (!session) return null
  if (Date.now() - session.createdAt > SESSION_TTL_MS) {
    sessions.delete(token)
    return null
  }
  return { role: session.role }
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
      maxAge: SESSION_TTL_MS / 1000,
    })
  )
}

export function clearSessionCookie(res: Response) {
  res.setHeader('Set-Cookie', serialize(SESSION_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }))
}

export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const session = getSession(req)
  if (!session) return res.status(401).json({ error: 'Not logged in' })
  req.role = session.role
  next()
}

export function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const session = getSession(req)
  if (!session) return res.status(401).json({ error: 'Not logged in' })
  if (session.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
  req.role = session.role
  next()
}
