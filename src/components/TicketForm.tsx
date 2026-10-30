import { useEffect, useState } from 'react'
import { listAzureDevOpsIntegrations } from '../lib/devopsConnector'
import type { AzureDevOpsIntegrationEntry, NewTicketInput } from '../types'

export type TicketFormSubmit = Omit<NewTicketInput, 'runId'>

interface TicketFormProps {
  onCancel: () => void
  onSubmit: (data: TicketFormSubmit) => void
}

// Just the ticket id and which Azure DevOps org it's linked to — the board
// is already the source of truth for everything else (severity, assignee,
// summary), and "Sync from board" pulls status/assignee in once this is
// saved, so re-typing those here was just duplicate busywork.
const ORG_LOAD_RETRY_DELAYS_MS = [400, 1000]

export default function TicketForm({ onCancel, onSubmit }: TicketFormProps) {
  const [ticketId, setTicketId] = useState('')
  const [organization, setOrganization] = useState('')
  const [orgs, setOrgs] = useState<AzureDevOpsIntegrationEntry[] | null>(null)
  const [orgsError, setOrgsError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    // A 401 racing right after login (or any other transient blip) used to
    // just throw inside an unhandled `.then()` here — the org list silently
    // never loaded, with nothing to retry it short of leaving this form and
    // reopening it later once the race had resolved itself. Retrying a
    // couple of times, with a visible error (and a retry button) only if
    // every attempt fails, means this self-heals instead.
    const load = async (attempt: number): Promise<void> => {
      try {
        const list = await listAzureDevOpsIntegrations()
        if (cancelled) return
        setOrgs(list)
        setOrgsError(null)
        if (list.length) setOrganization((current) => current || list[0].organization)
      } catch (err) {
        if (cancelled) return
        if (attempt < ORG_LOAD_RETRY_DELAYS_MS.length) {
          await new Promise((resolve) => setTimeout(resolve, ORG_LOAD_RETRY_DELAYS_MS[attempt]))
          if (!cancelled) await load(attempt + 1)
          return
        }
        setOrgsError(err instanceof Error ? err.message : String(err))
      }
    }
    load(0)
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="ticket-form">
      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <div className="field">
          <label>Ticket ID</label>
          <input className="ctrl" autoFocus placeholder="e.g. TCKT-4901" value={ticketId} onChange={(e) => setTicketId(e.target.value)} />
        </div>
        <div className="field">
          <label>Org</label>
          <select className="ctrl" value={organization} onChange={(e) => setOrganization(e.target.value)}>
            <option value="">No board link (manual)</option>
            {orgs?.map((o) => (
              <option key={o.organization} value={o.organization}>
                {o.organization} ({o.project})
              </option>
            ))}
          </select>
          {orgs && orgs.length === 0 && (
            <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
              No Azure DevOps org linked yet — add one in Settings to sync this ticket.
            </p>
          )}
          {orgsError && (
            <p style={{ fontSize: 11, color: 'var(--critical)', marginTop: 4 }}>
              Couldn't load linked orgs: {orgsError}{' '}
              <button
                className="btn small"
                style={{ marginLeft: 4, padding: '1px 8px' }}
                onClick={() => {
                  setOrgsError(null)
                  setOrgs(null)
                  listAzureDevOpsIntegrations()
                    .then((list) => {
                      setOrgs(list)
                      if (list.length) setOrganization((current) => current || list[0].organization)
                    })
                    .catch((err) => setOrgsError(err instanceof Error ? err.message : String(err)))
                }}
              >
                Retry
              </button>
            </p>
          )}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
        <button
          className="btn small primary"
          disabled={!ticketId.trim()}
          onClick={() =>
            onSubmit({
              ticketId: ticketId.trim(),
              system: 'Azure DevOps',
              organization: organization || null,
              severity: 'Medium',
              status: 'Open',
              assignee: '',
              summary: '',
              scenario: null,
            })
          }
        >
          Save ticket
        </button>
        <button className="btn small" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  )
}
