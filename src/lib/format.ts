// Shared date/time formatting for synced job data — kept separate from each
// page's own relative "Xm ago" / "Xd ago" helpers (those answer "how
// fresh?"; this answers "exactly when did this job run?").
export function formatDateTime(ts: number | null | undefined): string | null {
  if (!ts) return null
  return new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}
