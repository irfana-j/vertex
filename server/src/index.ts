import express from 'express'
import type { NextFunction, Request, Response } from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { serialize, parse } from 'cookie'
import bcrypt from 'bcryptjs'
import { getState, setState, listUsers, createUser, updateUser, deleteUser, type AppState } from './db.js'
import {
  clearSessionCookie,
  getSessionFromRequest,
  getSessionToken,
  isTeamScopedRole,
  login,
  loginViaSso,
  logout,
  requireAdmin,
  requireAuth,
  requireWriteAccess,
  setSessionCookie,
  type Role,
} from './auth.js'
import { scopeStateForUser, mergeAuthorizedWrite } from './rbac.js'
import { isSsoConfigured, buildAuthorizationRedirect, buildCurrentUrl, completeLogin, type SsoFlowState } from './sso.js'
import { proxySymphonyAuth, proxySymphonyDnd } from './symphonyProxy.js'
import { deleteIntegration, forwardCreateWorkItem, forwardGetWorkItem, forwardPostComment, forwardUploadAttachment, listIntegrations, upsertIntegration, testConnection } from './azureDevOps.js'

const VALID_ROLES: Role[] = ['admin', 'reader', 'team_admin', 'team_editor', 'team_reader']

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const app = express()

// Run history can carry real failure logs (a few KB each) across many
// templates — default 100kb body limit is too easy to hit on a full state save.
app.use(express.json({ limit: '10mb' }))

const PORT = Number(process.env.PORT) || 4001
const CLIENT_DIST = process.env.CLIENT_DIST || path.join(__dirname, '../../dist')

app.post('/api/login', async (req, res, next) => {
  try {
    const username = String(req.body?.username ?? '')
    const password = String(req.body?.password ?? '')
    const result = await login(username, password)
    if (!result) return res.status(401).json({ error: 'Incorrect username or password' })
    setSessionCookie(res, result.token)
    res.json({ role: result.role })
  } catch (err) {
    next(err)
  }
})


app.post('/api/logout', async (req, res, next) => {
  try {
    await logout(getSessionToken(req))
    clearSessionCookie(res)
    res.json({ ok: true })
  } catch (err) {
    next(err)
  }
})

app.get('/api/session', async (req, res, next) => {
  try {
    const user = await getSessionFromRequest(req)
    res.json(user ? { role: user.role, username: user.username, teamIds: user.teamIds } : { role: null })
  } catch (err) {
    next(err)
  }
})

// Microsoft Entra ID (Azure AD) sign-in — only authenticates WHO someone is;
// their RBAC role/team is still set by an admin afterward in Settings (a
// brand new SSO account starts as team_reader with no team, i.e. no real
// access — see db.ts's upsertSsoUser). No-ops with a 400 when unconfigured,
// so this is harmless to leave registered even for a deployment not using it.
const SSO_FLOW_COOKIE = 'vertex_sso_flow'

app.get('/api/auth/sso/status', (_req, res) => {
  res.json({ enabled: isSsoConfigured() })
})

app.get('/api/auth/sso/login', async (_req, res, next) => {
  try {
    if (!isSsoConfigured()) return res.status(400).json({ error: 'Single sign-on is not configured on this server.' })
    const { url, flow } = await buildAuthorizationRedirect()
    // Short-lived and single-purpose — only carries this one sign-in
    // attempt's state/nonce/PKCE verifier between the redirect out and the
    // callback; cleared the moment the callback reads it.
    res.setHeader('Set-Cookie', serialize(SSO_FLOW_COOKIE, JSON.stringify(flow), { httpOnly: true, sameSite: 'lax', path: '/', maxAge: 600 }))
    res.redirect(url)
  } catch (err) {
    next(err)
  }
})

app.get('/api/auth/sso/callback', async (req, res, next) => {
  try {
    const raw = parse(req.headers.cookie || '')[SSO_FLOW_COOKIE]
    res.setHeader('Set-Cookie', serialize(SSO_FLOW_COOKIE, '', { httpOnly: true, path: '/', maxAge: 0 }))
    if (!raw) return res.status(400).send('Sign-in session expired or missing a required cookie — please try logging in again.')
    const flow = JSON.parse(raw) as SsoFlowState
    const currentUrl = buildCurrentUrl(req.originalUrl)
    const identity = await completeLogin(currentUrl, flow)
    const result = await loginViaSso(identity.email)
    if (!result) return res.status(401).send('Sign-in failed.')
    setSessionCookie(res, result.token)
    res.redirect('/')
  } catch (err) {
    next(err)
  }
})

// GET is readable by any logged-in account, but a team-scoped one (team_admin
// / team_editor / team_reader) only gets its own team's slice back — see
// scopeStateForUser. PUT (saving state) is open to any non-read-only role,
// but what actually lands depends on who's asking: admin's write replaces
// the whole thing (unchanged); a team-scoped writer's gets merged into the
// real full state instead of trusted as a wholesale replacement — see
// mergeAuthorizedWrite. reader and team_reader can't PUT at all.
app.get('/api/state', requireAuth, async (req, res) => {
  const full = await getState()
  res.json(scopeStateForUser(full, req.user!))
})

app.put('/api/state', requireWriteAccess, async (req, res) => {
  const user = req.user!
  if (user.role === 'admin') {
    await setState(req.body as AppState)
    return res.json({ ok: true })
  }
  // team_admin / team_editor only, by construction of requireWriteAccess
  // (readers never pass it) — merge their write into the real full state.
  const current = await getState()
  await setState(mergeAuthorizedWrite(current, req.body as AppState, user))
  res.json({ ok: true })
})

// Both roles can read through to Symphony — these endpoints only ever GET
// data from Symphony on this app's behalf, so there's nothing to restrict
// to admin here specifically (the state write above is the real gate).
app.use('/api/symphony-auth', requireAuth, proxySymphonyAuth)
app.use('/api/symphony-dnd', requireAuth, proxySymphonyDnd)

// Azure DevOps integrations — a list now, so one deployment can link
// several orgs and a ticket picks which one it belongs to. Org/project
// aren't secret (both roles can read them, e.g. to populate the ticket
// form's org picker), but the PAT itself never leaves this process; only
// admin can add, remove or test one.
app.get('/api/integrations/azuredevops', requireAuth, async (_req, res) => {
  res.json({ integrations: await listIntegrations() })
})
app.post('/api/integrations/azuredevops', requireAdmin, async (req, res) => {
  const { organization, project, personalAccessToken } = req.body ?? {}
  if (!organization || !project) return res.status(400).json({ error: 'Organization and project are required.' })
  await upsertIntegration({ organization, project, personalAccessToken })
  res.json({ ok: true })
})
app.delete('/api/integrations/azuredevops/:organization', requireAdmin, async (req, res) => {
  await deleteIntegration(req.params.organization)
  res.json({ ok: true })
})
app.post('/api/integrations/azuredevops/test', requireAdmin, async (req, res) => {
  const { organization, project, personalAccessToken } = req.body ?? {}
  if (!organization || !project) return res.status(400).json({ error: 'Organization and project are required.' })
  const result = await testConnection({ organization, project, personalAccessToken })
  res.json(result)
})

// Per-ticket proxy, scoped by organization — anyone logged in can pull a
// work item's live status (same as the read-only Symphony proxies above);
// raising a ticket, posting a follow-up, and uploading its report are write
// actions, open to admin and both team-write roles (team_admin, team_editor)
// but not a reader or team_reader. Which specific template a ticket ends up
// against is enforced where it actually matters — the /api/state merge a
// team-scoped account's local change then goes through — not here, since
// these calls don't carry a templateId at all.
app.get('/api/azuredevops/:organization/workitems/:id', requireAuth, forwardGetWorkItem)
app.post('/api/azuredevops/:organization/workitems/:id/comment', requireWriteAccess, forwardPostComment)
app.post('/api/azuredevops/:organization/workitems', requireWriteAccess, forwardCreateWorkItem)
// Uploads the generated failure-report PDF before the work item exists —
// raw binary body, not JSON, so this route gets its own body parser instead
// of the app-wide express.json() above (which skips non-JSON content types
// and leaves the stream untouched for this to read).
app.post(
  '/api/azuredevops/:organization/attachments',
  requireWriteAccess,
  express.raw({ type: '*/*', limit: '15mb' }),
  forwardUploadAttachment
)

// User management — admin-only, for assigning the RBAC roles above to real
// accounts. Password hashes never leave db.ts's row shape; listUsers()
// already strips them before this ever sees a row.
app.get('/api/users', requireAdmin, async (_req, res) => {
  res.json({ users: await listUsers() })
})
app.post('/api/users', requireAdmin, async (req, res) => {
  const username = String(req.body?.username ?? '').trim()
  const password = String(req.body?.password ?? '')
  const role = String(req.body?.role ?? '') as Role
  const teamIds = Array.isArray(req.body?.teamIds) ? req.body.teamIds.filter((id: unknown) => typeof id === 'string') : []
  if (!username || !password) return res.status(400).json({ error: 'A username and password are required.' })
  if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` })
  try {
    const passwordHash = await bcrypt.hash(password, 10)
    const user = await createUser({ username, passwordHash, role, teamIds: isTeamScopedRole(role) ? teamIds : [] })
    res.json({ user })
  } catch (err) {
    const message = String(err)
    if (/duplicate key|unique/i.test(message)) return res.status(409).json({ error: `Username "${username}" is already taken.` })
    res.status(500).json({ error: message })
  }
})
// Role/teamIds/password are each optional on an edit — only the fields
// actually sent get changed, so e.g. reassigning someone's team doesn't
// force resetting their password in the same call.
app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const patch: { role?: Role; teamIds?: string[]; passwordHash?: string } = {}
  if (req.body?.role !== undefined) {
    const role = String(req.body.role) as Role
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: `Role must be one of: ${VALID_ROLES.join(', ')}` })
    patch.role = role
    // Switching a team-scoped account to a global role (or vice versa)
    // without an explicit teamIds in the same call shouldn't leave stale
    // team assignments hanging off a now-global account.
    if (!isTeamScopedRole(role) && req.body?.teamIds === undefined) patch.teamIds = []
  }
  if (req.body?.teamIds !== undefined) {
    patch.teamIds = Array.isArray(req.body.teamIds) ? req.body.teamIds.filter((id: unknown) => typeof id === 'string') : []
  }
  if (typeof req.body?.password === 'string' && req.body.password.length > 0) {
    patch.passwordHash = await bcrypt.hash(req.body.password, 10)
  }
  await updateUser(req.params.id, patch)
  res.json({ ok: true })
})
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  if (req.user!.id === req.params.id) return res.status(400).json({ error: "You can't delete your own account." })
  await deleteUser(req.params.id)
  res.json({ ok: true })
})

app.use(express.static(CLIENT_DIST))
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
})

// Catches every error passed to next(err) above. Without this, Express's
// own default handler took over — it logs nothing (so a "500 happening
// more often" report had no server-side trail to chase) and, outside
// development, sends a bare "Internal Server Error" that isn't the JSON
// body every client fetch here expects, which turned one real failure into
// a second, confusing one client-side. Always last, after every route.
app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (res.headersSent) return next(err)
  console.error('Unhandled request error:', err)
  res.status(500).json({ error: 'Internal server error' })
})

const server = app.listen(PORT, () => {
  console.log(`Vertex Regression Studio server listening on :${PORT}`)
})

// Behind an AWS ALB (or any proxy that pools/reuses keep-alive connections):
// Node's own default keepAliveTimeout is 5s, well under the ALB's default
// 60s idle timeout. That gap means Node can close a pooled connection the
// ALB still considers live — the ALB then forwards the next request over a
// socket that's already dead on this end, which it reports back to the
// client as a 502, even while the target group itself shows healthy (health
// checks open their own fresh connection each time, so they never hit this
// race). Setting this above the ALB's idle timeout avoids the race;
// headersTimeout must stay above keepAliveTimeout or Node ignores it.
server.keepAliveTimeout = 65000
server.headersTimeout = 66000
