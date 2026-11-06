import type { AppUser, Role } from '../types'

// Talks to this app's own backend (server/) — session login/logout, and the
// single shared state blob the Zustand store persists to instead of
// localStorage. Every call sends cookies so the httpOnly session cookie the
// backend sets on login rides along automatically.

async function asJson(res: Response): Promise<unknown> {
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error || `Request failed (${res.status})`)
  }
  return res.json()
}

export async function fetchSession(): Promise<{ role: Role | null; username?: string; teamIds?: string[] }> {
  const res = await fetch('/api/session', { credentials: 'include' })
  return (await asJson(res)) as { role: Role | null; username?: string; teamIds?: string[] }
}

export async function login(username: string, password: string): Promise<{ role: Role }> {
  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify({ username, password }),
  })
  return (await asJson(res)) as { role: Role }
}

export async function logout(): Promise<void> {
  await fetch('/api/logout', { method: 'POST', credentials: 'include' })
}

// Whether this deployment has Microsoft Entra ID SSO configured — the login
// screen only shows the "Sign in with Microsoft" button when this is true,
// so an unconfigured deployment looks exactly like it did before SSO existed.
export async function fetchSsoStatus(): Promise<{ enabled: boolean }> {
  const res = await fetch('/api/auth/sso/status', { credentials: 'include' })
  return (await asJson(res)) as { enabled: boolean }
}

// User management — admin-only (enforced server-side too). Used by
// Settings' "Users" panel to assign the RBAC roles to real accounts.
export async function listUsers(): Promise<AppUser[]> {
  const res = await fetch('/api/users', { credentials: 'include' })
  const data = (await asJson(res)) as { users: AppUser[] }
  return data.users
}

export async function createUser(input: { username: string; password: string; role: Role; teamIds: string[] }): Promise<AppUser> {
  const res = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(input),
  })
  const data = (await asJson(res)) as { user: AppUser }
  return data.user
}

export async function updateUser(id: string, patch: { role?: Role; teamIds?: string[]; password?: string }): Promise<void> {
  await fetch(`/api/users/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include',
    body: JSON.stringify(patch),
  }).then(asJson)
}

export async function deleteUser(id: string): Promise<void> {
  await fetch(`/api/users/${encodeURIComponent(id)}`, { method: 'DELETE', credentials: 'include' }).then(asJson)
}
