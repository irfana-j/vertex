import type { AuthedUser } from './auth.js'
import type { AppState } from './db.js'

// The server only knows these three fields' shapes loosely (the real
// Template/Team/RegressionGroup types live client-side) — just enough to
// filter and merge safely without importing the client's whole type tree.
interface MinimalTemplate {
  id: string
  teamId?: string | null
  [key: string]: unknown
}
interface MinimalTeam {
  id: string
  [key: string]: unknown
}
interface MinimalGroup {
  id: string
  templateIds?: string[]
  [key: string]: unknown
}

function templatesOf(state: AppState): MinimalTemplate[] {
  return (state.templates || []) as MinimalTemplate[]
}
function teamsOf(state: AppState): MinimalTeam[] {
  return (state.teams || []) as MinimalTeam[]
}
function groupsOf(state: AppState): MinimalGroup[] {
  return (state.groups || []) as MinimalGroup[]
}

// What GET /api/state hands back — global roles (admin, reader) see
// everything, unchanged. A team-scoped account only ever receives its own
// team(s)' templates and team record(s); Regression Groups (which can span
// several teams) keep their shape but only list the member templates this
// account can actually see. Cycles stay shared/unfiltered for everyone —
// they carry no team-specific data, just the regression calendar.
export function scopeStateForUser(state: AppState, user: AuthedUser): AppState {
  if (user.role === 'admin' || user.role === 'reader') return state
  const allowed = new Set(user.teamIds)
  const templates = templatesOf(state).filter((t) => t.teamId != null && allowed.has(t.teamId as string))
  const visibleTemplateIds = new Set(templates.map((t) => t.id))
  const teams = teamsOf(state).filter((tm) => allowed.has(tm.id))
  const groups = groupsOf(state)
    .map((g) => ({ ...g, templateIds: (g.templateIds || []).filter((id) => visibleTemplateIds.has(id)) }))
    .filter((g) => g.templateIds!.length > 0)
  return { ...state, templates, teams, groups }
}

// What PUT /api/state actually applies for a team-scoped writer (team_admin
// or team_editor — team_reader and reader never reach here, see index.ts).
// The client still treats this like a normal "save my whole local store"
// call — same as admin's — but since GET above only ever handed it its own
// slice, "its whole local store" naturally IS just that slice. This merges
// that slice back into the server's REAL full state rather than trusting it
// as a wholesale replacement, so one team's save can never drop another
// team's data, and a tampered request can't touch what it was never shown.
//
//   - templates: only ones whose CURRENT teamId is already one of this
//     user's teams get updated at all (ticket/run/log changes merge in
//     freely); only team_admin may move one of those into another of their
//     own teams or clear it to no-team; a template id with no current entry
//     here is a "new template" attempt and is dropped — tracking a new
//     template is admin-only, enforced by omission here, not a separate check.
//   - teams: only this user's own team record(s) can change at all. A
//     record present in `current` but missing from `incoming` is a delete
//     attempt — applied only for team_admin, since team_editor has no
//     delete permission.
//   - cycles / activeCycleId / groups: never touched by a team-scoped
//     write — starting/closing cycles and editing Regression Groups stay
//     admin-only, enforced the same way (by omission).
export function mergeAuthorizedWrite(current: AppState, incoming: AppState, user: AuthedUser): AppState {
  const allowed = new Set(user.teamIds)
  // team_admin can reassign/release templates within its own team(s) and
  // delete its own team; team_editor can update (but not move/delete) both.
  const isTeamAdmin = user.role === 'team_admin'

  const incomingTemplatesById = new Map(templatesOf(incoming).map((t) => [t.id, t]))
  const templates = templatesOf(current).map((t) => {
    if (t.teamId == null || !allowed.has(t.teamId as string)) return t
    const inc = incomingTemplatesById.get(t.id)
    if (!inc) return t
    const requestedTeamId = (inc.teamId ?? null) as string | null
    const teamChangeAllowed = isTeamAdmin && (requestedTeamId === null || allowed.has(requestedTeamId))
    return { ...inc, teamId: teamChangeAllowed ? requestedTeamId : t.teamId }
  })

  const incomingTeamsById = new Map(teamsOf(incoming).filter((tm) => allowed.has(tm.id)).map((tm) => [tm.id, tm]))
  const teams = teamsOf(current)
    .filter((tm) => !allowed.has(tm.id) || incomingTeamsById.has(tm.id) || !isTeamAdmin)
    .map((tm) => (allowed.has(tm.id) && incomingTeamsById.has(tm.id) ? incomingTeamsById.get(tm.id)! : tm))

  return { ...current, templates, teams }
}
