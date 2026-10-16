/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SYMPHONY_BASE_URL?: string
  readonly VITE_SYMPHONY_API_TOKEN?: string
  readonly VITE_SYMPHONY_TOKEN_URL?: string
  readonly VITE_SYMPHONY_CUSTOMER_CODE?: string
  readonly VITE_SYMPHONY_USERNAME?: string
  readonly VITE_SYMPHONY_PASSWORD?: string
  // Azure DevOps has no VITE_* vars — its org/project/PAT are configured
  // through the app's own Settings page and stored server-side.
  readonly VITE_JIRA_BASE_URL?: string
  readonly VITE_JIRA_EMAIL?: string
  readonly VITE_JIRA_API_TOKEN?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
