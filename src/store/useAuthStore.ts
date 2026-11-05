import { create } from 'zustand'
import * as api from '../lib/api'
import type { Role } from '../types'

export type AuthStatus = 'checking' | 'anonymous' | 'authenticated'

interface AuthState {
  status: AuthStatus
  role: Role | null
  username: string | null
  // Only meaningful for a team-scoped role (team_admin/team_editor/team_reader)
  // — empty for the two global roles. See lib/permissions.ts for how this
  // combines with `role` into actual permission checks.
  teamIds: string[]
  error: string | null
  // /api/session itself never 401s — it always returns 200 with role:null
  // when there's no valid session, so a thrown error from fetchSession()
  // means the REQUEST failed (an ALB 502/504 during a brief backend
  // restart, a dropped connection, etc.), not that the session is invalid.
  // Set only once retries are exhausted, so App.tsx can show a "couldn't
  // reach the server" retry screen instead of silently falling back to the
  // login screen and making an idle-timeout-valid session look expired.
  sessionCheckFailed: boolean
  checkSession: () => Promise<void>
  login: (username: string, password: string) => Promise<boolean>
  logout: () => Promise<void>
}

// Separate from useStore (the app's data) on purpose — this is just "who is
// signed in," never persisted itself (the httpOnly session cookie is what
// actually survives a reload; this store just reflects it after asking the
// backend on boot).
export const useAuthStore = create<AuthState>((set) => ({
  status: 'checking',
  role: null,
  username: null,
  teamIds: [],
  error: null,
  sessionCheckFailed: false,

  checkSession: async () => {
    set({ sessionCheckFailed: false })
    const attempt = async (retriesLeft: number): Promise<void> => {
      try {
        const { role, username, teamIds } = await api.fetchSession()
        set({ status: role ? 'authenticated' : 'anonymous', role, username: username ?? null, teamIds: teamIds ?? [], sessionCheckFailed: false })
      } catch {
        if (retriesLeft > 0) {
          await new Promise((resolve) => setTimeout(resolve, 600))
          return attempt(retriesLeft - 1)
        }
        set({ sessionCheckFailed: true })
      }
    }
    await attempt(2)
  },

  login: async (username, password) => {
    set({ error: null })
    try {
      const { role } = await api.login(username, password)
      // The login response only confirms the role — team assignment comes
      // from the same /api/session the boot check uses, so there's one
      // source of truth for "what can this account see" rather than two
      // endpoints that could drift.
      const session = await api.fetchSession()
      set({ status: 'authenticated', role, username: session.username ?? username, teamIds: session.teamIds ?? [] })
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Login failed' })
      return false
    }
  },

  logout: async () => {
    await api.logout()
    set({ status: 'anonymous', role: null, username: null, teamIds: [] })
  },
}))
