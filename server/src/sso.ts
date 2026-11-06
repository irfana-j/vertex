import * as client from 'openid-client'

// Microsoft Entra ID (Azure AD) sign-in via standard OpenID Connect —
// Authorization Code flow with PKCE. This module only handles
// AUTHENTICATION (proving who someone is); authorization (which RBAC role
// they get) is a separate, deliberate step an admin takes afterward in
// Settings — see db.ts's upsertSsoUser, which provisions a brand new SSO
// account as team_reader with no team assigned (no real access) rather than
// granting anything automatically.

function tenantId(): string {
  return process.env.AZURE_AD_TENANT_ID || ''
}
function clientId(): string {
  return process.env.AZURE_AD_CLIENT_ID || ''
}
function clientSecret(): string {
  return process.env.AZURE_AD_CLIENT_SECRET || ''
}
// The exact URL registered as this app's redirect URI in the Entra app
// registration — e.g. https://vertex.yourcompany.com/api/auth/sso/callback.
function redirectUri(): string {
  return process.env.AZURE_AD_REDIRECT_URI || ''
}

export function isSsoConfigured(): boolean {
  return Boolean(tenantId() && clientId() && clientSecret() && redirectUri())
}

// Discovery fetches Microsoft's own OIDC metadata document — do that once
// per process and reuse it, instead of on every single login attempt.
let configPromise: Promise<client.Configuration> | null = null
async function getConfig(): Promise<client.Configuration> {
  if (!configPromise) {
    const issuer = new URL(`https://login.microsoftonline.com/${tenantId()}/v2.0`)
    configPromise = client.discovery(issuer, clientId(), clientSecret())
  }
  return configPromise
}

// Everything the callback needs to verify the response actually belongs to
// the redirect this server itself sent the browser on — stashed in a
// short-lived cookie between the two requests (see index.ts), since this
// app has no per-visitor server-side session yet at this point in the flow.
export interface SsoFlowState {
  state: string
  nonce: string
  codeVerifier: string
}

export async function buildAuthorizationRedirect(): Promise<{ url: string; flow: SsoFlowState }> {
  const config = await getConfig()
  const codeVerifier = client.randomPKCECodeVerifier()
  const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier)
  const state = client.randomState()
  const nonce = client.randomNonce()
  const url = client.buildAuthorizationUrl(config, {
    redirect_uri: redirectUri(),
    scope: 'openid profile email',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state,
    nonce,
  })
  return { url: url.href, flow: { state, nonce, codeVerifier } }
}

// Rebuilds the externally-visible callback URL (scheme+host from the
// configured redirect URI, path+query from the actual request) instead of
// trusting req.protocol/req.get('host') directly — this app typically runs
// behind an ALB that terminates TLS and forwards plain HTTP, so Express's
// own idea of the request's scheme/host can't be trusted without extra
// `trust proxy` configuration this doesn't otherwise need.
export function buildCurrentUrl(pathAndQuery: string): URL {
  const base = new URL(redirectUri())
  return new URL(pathAndQuery, `${base.protocol}//${base.host}`)
}

export interface SsoIdentity {
  email: string
  name: string
}

export async function completeLogin(currentUrl: URL, flow: SsoFlowState): Promise<SsoIdentity> {
  const config = await getConfig()
  const tokens = await client.authorizationCodeGrant(config, currentUrl, {
    pkceCodeVerifier: flow.codeVerifier,
    expectedState: flow.state,
    expectedNonce: flow.nonce,
  })
  const claims = tokens.claims()
  if (!claims) throw new Error('Azure AD did not return an ID token.')
  // Azure AD's sign-in identity lives in `preferred_username` (the UPN,
  // normally the work email) — `email` isn't always populated depending on
  // how the tenant's directory is configured, so this is the reliable one.
  const email = String(claims.preferred_username || claims.email || '')
  const name = String(claims.name || email)
  if (!email) throw new Error('Azure AD did not return a usable identity (no preferred_username/email claim).')
  return { email, name }
}
