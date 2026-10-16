import type { Request, Response } from 'express'

// This server is now what talks to Symphony — real credentials (customer
// code, username, password) live only in this process's env vars and are
// never sent to the browser at all, unlike the earlier client-only build.
const SYMPHONY_TOKEN_UPSTREAM = process.env.SYMPHONY_TOKEN_UPSTREAM || 'https://api.qa.symphony4cloud.com/symphony-core-external/api/auth'
const SYMPHONY_DND_UPSTREAM = process.env.SYMPHONY_DND_UPSTREAM || 'https://dnd.qa.symphony4cloud.com/symphony-dnd/api'

// Same reasoning as ADMIN_PASSWORD/USER_PASSWORD: base64, not plain text,
// not encryption — just not readable at a glance in an env file.
function decodeBase64(value: string | undefined): string {
  if (!value) return ''
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return value
  }
}
const SYMPHONY_CUSTOMER_CODE = process.env.SYMPHONY_CUSTOMER_CODE || ''
const SYMPHONY_USERNAME = process.env.SYMPHONY_USERNAME || ''
const SYMPHONY_PASSWORD = decodeBase64(process.env.SYMPHONY_PASSWORD)

async function forward(targetBase: string, req: Request, res: Response, extraHeaders: Record<string, string> = {}, body?: unknown) {
  try {
    const targetUrl = `${targetBase}${req.url}`
    const upstreamRes = await fetch(targetUrl, {
      method: req.method,
      headers: { Accept: 'application/json', ...extraHeaders },
      body: req.method === 'GET' || req.method === 'HEAD' ? undefined : JSON.stringify(body ?? req.body),
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

// The browser no longer sends any credentials here at all — whatever body
// it posts is ignored in favor of this process's own env vars, so there's
// nothing Symphony-specific left to bake into the client bundle at build
// time. Customer code/username/password live only here now.
export function proxySymphonyAuth(req: Request, res: Response) {
  return forward(SYMPHONY_TOKEN_UPSTREAM, req, res, { 'Content-Type': 'application/json' }, {
    customerCode: SYMPHONY_CUSTOMER_CODE,
    username: SYMPHONY_USERNAME,
    password: SYMPHONY_PASSWORD,
  })
}

export function proxySymphonyDnd(req: Request, res: Response) {
  const headers: Record<string, string> = {}
  if (req.headers.authorization) headers.Authorization = req.headers.authorization as string
  return forward(SYMPHONY_DND_UPSTREAM, req, res, headers)
}
