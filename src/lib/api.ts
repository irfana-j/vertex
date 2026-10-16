import type { Role } from '../types'

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

export async function fetchSession(): Promise<{ role: Role | null }> {
  const res = await fetch('/api/session', { credentials: 'include' })
  return (await asJson(res)) as { role: Role | null }
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
