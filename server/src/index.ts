import express from 'express'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getState, setState, type AppState } from './db.js'
import { clearSessionCookie, getSessionFromRequest, getSessionToken, login, logout, requireAdmin, requireAuth, setSessionCookie } from './auth.js'
import { proxySymphonyAuth, proxySymphonyDnd } from './symphonyProxy.js'
import { deleteIntegration, forwardCreateWorkItem, forwardGetWorkItem, forwardPostComment, listIntegrations, upsertIntegration, testConnection } from './azureDevOps.js'

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
    const session = await getSessionFromRequest(req)
    res.json({ role: session?.role ?? null })
  } catch (err) {
    next(err)
  }
})

// GET is readable by either role; PUT (replacing the whole saved state) is
// admin-only — enforced here, not just by hiding buttons in the UI.
app.get('/api/state', requireAuth, async (_req, res) => {
  res.json(await getState())
})

app.put('/api/state', requireAdmin, async (req, res) => {
  await setState(req.body as AppState)
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

// Per-ticket proxy, scoped by organization — both roles can pull a work
// item's live status (same as the read-only Symphony proxies above);
// posting a follow-up comment is a write action, gated the same way the
// UI already gates that button.
app.get('/api/azuredevops/:organization/workitems/:id', requireAuth, forwardGetWorkItem)
app.post('/api/azuredevops/:organization/workitems/:id/comment', requireAdmin, forwardPostComment)
// Raises a brand-new work item on the board — the "Raise ticket" button
// next to a failed node's log. Write action, so admin-only like the rest.
app.post('/api/azuredevops/:organization/workitems', requireAdmin, forwardCreateWorkItem)

app.use(express.static(CLIENT_DIST))
app.get('*', (_req, res) => {
  res.sendFile(path.join(CLIENT_DIST, 'index.html'))
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
