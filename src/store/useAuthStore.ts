import { create } from 'zustand'
import * as api from '../lib/api'
import type { Role } from '../types'

export type AuthStatus = 'checking' | 'anonymous' | 'authenticated'

interface AuthState {
  status: AuthStatus
  role: Role | null
  error: string | null
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
  error: null,

  checkSession: async () => {
    try {
      const { role } = await api.fetchSession()
      set({ status: role ? 'authenticated' : 'anonymous', role })
    } catch {
      set({ status: 'anonymous', role: null })
    }
  },

  login: async (username, password) => {
    set({ error: null })
    try {
      const { role } = await api.login(username, password)
      set({ status: 'authenticated', role })
      return true
    } catch (err) {
      set({ error: err instanceof Error ? err.message : 'Login failed' })
      return false
    }
  },

  logout: async () => {
    await api.logout()
    set({ status: 'anonymous', role: null })
  },
}))
