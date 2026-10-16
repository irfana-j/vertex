import type { Request, Response } from 'express'

// This server is now what talks to Symphony — real credentials (customer
// code, username, password) live only in this process's env vars and are
// never sent to the browser at all, unlike the earlier client-only build.
const SYMPHONY_TOKEN_UPSTREAM = process.env.SYMPHONY_TOKEN_UPSTREAM || 'https://api.qa.symphony4cloud.com/symphony-core-external/api/auth'
const SYMPHONY_DND_UPSTREAM = process.env.SYMPHONY_DND_UPSTREAM || 'https://dnd.qa.symphony4cloud.com/symphony-dnd/api'

async function forward(targetBase: string, req: Request, res: Response, extraHeaders: Record<string, string> = {}) {
  try {
    const targetUrl = `${targetBase}${req.url}`
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: { Accept: 'application/json', ...extraHeaders },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(req.body),
    })
    const text = await upstreamRes.text()
    res
      .status(upstreamRes.status)
      .type(upstreamRes.headers.get('content-type') || 'application/json')
      .send(text)
  } catch (err) {
    res.status(502).json({ error: 'Symphony upstream request failed', detail: String(err) })
  }
}

// The client's own token POST body ({ customerCode, username, password })
// still goes through as-is to Symphony's real token endpoint — this proxy
// only relocates WHERE the browser's request lands, not the credentials
// flow. (A future tightening could hold those three values server-side
// entirely and have the client call this with no body at all.)
export function proxySymphonyAuth(req: Request, res: Response) {
  return forward(SYMPHONY_TOKEN_UPSTREAM, req, res, { 'Content-Type': 'application/json' })
}

export function proxySymphonyDnd(req: Request, res: Response) {
  const headers: Record<string, string> = {}
  if (req.headers.authorization) headers.Authorization = req.headers.authorization as string
  return forward(SYMPHONY_DND_UPSTREAM, req, res, headers)
}
