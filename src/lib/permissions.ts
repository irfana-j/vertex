import type { Role } from '../types'

// Centralizes every "can this account do X" check so it's answered the same
// way everywhere, instead of each component re-deriving it from `role` (and
// drifting as roles grow — this started as a single `role === 'admin'` check
// copy-pasted into ~10 files before team-scoped roles existed).
export interface AuthContext {
  role: Role | null
  teamIds: string[]
}

const TEAM_SCOPED: Role[] = ['team_admin', 'team_editor', 'team_reader']
export function isTeamScopedRole(role: Role | null): boolean {
  return role !== null && TEAM_SCOPED.includes(role)
}

// Sees and can act on EVERYTHING, no team restriction — the only role that
// can manage users, integrations, cycles, Regression Groups, and
// track/delete templates.
export function isGlobalAdmin(auth: AuthContext): boolean {
  return auth.role === 'admin'
}

// Sees everything, can change nothing — today's "Viewer".
export function isGlobalReader(auth: AuthContext): boolean {
  return auth.role === 'reader'
}

// Only ever sees its own assigned team(s)' templates — enforced server-side
// (GET /api/state only ever sends this slice), not just hidden client-side.
export function isTeamScoped(auth: AuthContext): boolean {
  return isTeamScopedRole(auth.role)
}

// Can raise tickets, sync, and edit regression-window settings for this
// team. Global admin can do this for any team; team_admin/team_editor only
// for their own assigned team(s); reader and team_reader never can.
export function canWriteTeam(auth: AuthContext, teamId: string | null): boolean {
  if (auth.role === 'admin') return true
  if (teamId === null) return false
  if (auth.role === 'team_admin' || auth.role === 'team_editor') return auth.teamIds.includes(teamId)
  return false
}

// Generic "is this account allowed to write ANYTHING at all" — for actions
// like "raise a ticket" or "sync" that don't carry a specific teamId to
// check, because template/ticket visibility is already scoped server-side
// (GET /api/state only ever sends a team-scoped account its own team's
// data), so anything such an account can even see is already something
// it's allowed to act on.
export function hasAnyWriteAccess(auth: AuthContext): boolean {
  return auth.role === 'admin' || auth.role === 'team_admin' || auth.role === 'team_editor'
}

// Can assign/unassign templates to this team, and delete it. A step up from
// canWriteTeam — team_editor can edit the team's settings but not its
// membership or existence.
export function canManageTeam(auth: AuthContext, teamId: string | null): boolean {
  if (auth.role === 'admin') return true
  if (teamId === null) return false
  return auth.role === 'team_admin' && auth.teamIds.includes(teamId)
}

// A friendly label for "Signed in as ___" and the user-management table —
// kept in one place so the wording stays consistent everywhere it's shown.
export function roleLabel(role: Role | null): string {
  switch (role) {
    case 'admin':
      return 'Admin'
    case 'reader':
      return 'Reader'
    case 'team_admin':
      return 'Team Admin'
    case 'team_editor':
      return 'Team Editor'
    case 'team_reader':
      return 'Team Reader'
    default:
      return 'Unknown'
  }
}

export const ALL_ROLES: Role[] = ['admin', 'reader', 'team_admin', 'team_editor', 'team_reader']
