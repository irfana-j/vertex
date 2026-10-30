import { Fragment, useEffect, useState } from 'react'
import { useAuthStore } from '../store/useAuthStore'
import { TICKET_STATUSES } from '../data/constants'
import { listAzureDevOpsIntegrations, canSyncFromBoard } from '../lib/devopsConnector'
import { getTicketForRun, getTicketsForTemplateInCycle, getScenarioNodes, isTicketStale, daysSinceActivity } from '../lib/selectors'
import type { AzureDevOpsIntegrationEntry, Cycle, NewTicketInput, Run, Template, TicketStatus } from '../types'

function cycleLabel(cycles: Cycle[], cycleId: string): string {
  return cycles.find((c) => c.id === cycleId)?.label || 'Unknown cycle'
}

type TicketFormSubmit = Omit<NewTicketInput, 'runId'>

interface TicketFormProps {
  onCancel: () => void
  onSubmit: (data: TicketFormSubmit) => void
}

// Just the ticket id and which Azure DevOps org it's linked to — the board
// is already the source of truth for everything else (severity, assignee,
// summary), and "Sync from board" pulls status/assignee in once this is
// saved, so re-typing those here was just duplicate busywork.
const ORG_LOAD_RETRY_DELAYS_MS = [400, 1000]

function TicketForm({ onCancel, onSubmit }: TicketFormProps) {
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

function NodeResultsBreakdown({ template, run }: { template: Template; run: Run }) {
  const scenarioNodes = getScenarioNodes(template)
  const passCount = scenarioNodes.filter((n) => run.results[n.id]?.status === 'pass').length
  return (
    <div className="node-breakdown">
      <div className="node-breakdown-sub">
        {passCount}/{scenarioNodes.length} nodes passed in this job
      </div>
      {scenarioNodes.map((n) => {
        const result = run.results[n.id]
        return (
          <div className="node-breakdown-row" key={n.id}>
            <span className={`node-status-dot ${result ? (result.status === 'pass' ? 'pass' : 'fail') : 'none'}`} />
            <span className="node-breakdown-label">{n.data.label}</span>
            {!result && <span className="node-breakdown-note">{run.liveStatus?.[n.id] || 'not reached'}</span>}
            {result?.status === 'fail' && <pre className="node-result-log">{result.log || 'No log captured.'}</pre>}
          </div>
        )
      })}
    </div>
  )
}

interface RunHistoryPanelProps {
  template: Template
  cycles: Cycle[]
  activeCycleId: string | null
  onLogTicket: (templateId: string, data: NewTicketInput) => void
  onUpdateTicket: (templateId: string, ticketId: string, patch: Partial<{ status: TicketStatus }>) => void
  onSyncTicket: (templateId: string, ticketId: string) => Promise<void>
  onFollowUp: (templateId: string, ticketId: string) => Promise<unknown>
}

export default function RunHistoryPanel({ template, cycles, activeCycleId, onLogTicket, onUpdateTicket, onSyncTicket, onFollowUp }: RunHistoryPanelProps) {
  const isAdmin = useAuthStore((s) => s.role === 'admin')
  const [openRunForm, setOpenRunForm] = useState<string | number | null>(null)
  const [expandedRun, setExpandedRun] = useState<string | number | null>(null)
  const [openGeneralForm, setOpenGeneralForm] = useState(false)
  const [busyTicketId, setBusyTicketId] = useState<string | null>(null)
  const [syncingAll, setSyncingAll] = useState(false)
  const [ticketActionError, setTicketActionError] = useState<string | null>(null)

  const runs = [...(template.runHistory || [])].sort((a, b) => b.timestamp - a.timestamp)
  const tickets = getTicketsForTemplateInCycle(template, activeCycleId || '')

  const handleSync = async (ticketId: string) => {
    setBusyTicketId(ticketId)
    try {
      await onSyncTicket(template.id, ticketId)
    } catch (err) {
      setTicketActionError(err instanceof Error ? err.message : String(err))
      setTimeout(() => setTicketActionError(null), 5000)
    } finally {
      setBusyTicketId(null)
    }
  }
  const handleSyncAll = async () => {
    setSyncingAll(true)
    setTicketActionError(null)
    const failures: string[] = []
    for (const t of tickets.filter((t) => canSyncFromBoard(t))) {
      try {
        await onSyncTicket(template.id, t.id)
      } catch (err) {
        // One ticket's board call failing (a transient Azure DevOps blip,
        // a renamed/deleted work item) shouldn't stop the rest from
        // syncing — same reasoning as the dashboard's "Sync all" action.
        failures.push(`${t.ticketId}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
    setSyncingAll(false)
    if (failures.length) {
      setTicketActionError(`${failures.length} ticket(s) failed to sync — ${failures.join('; ')}`)
      setTimeout(() => setTicketActionError(null), 7000)
    }
  }
  const handleFollowUp = async (ticketId: string) => {
    setBusyTicketId(ticketId)
    try {
      await onFollowUp(template.id, ticketId)
    } catch (err) {
      setTicketActionError(err instanceof Error ? err.message : String(err))
      setTimeout(() => setTicketActionError(null), 5000)
    } finally {
      setBusyTicketId(null)
    }
  }

  return (
    <div className="run-history">
      <div className="card panel">
        <div className="section-head" style={{ marginBottom: 10 }}>
          <div>
            <h3>Run history</h3>
            <p className="p-sub">Every dated regression job for this template, across every cycle it's been synced in.</p>
          </div>
        </div>
        {runs.length === 0 ? (
          <div className="empty" style={{ marginTop: 0 }}>
            No jobs synced yet — click "Sync job results" above.
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Job</th>
                  <th>Cycle</th>
                  <th>Status</th>
                  <th>Reason</th>
                  <th>Ticket</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
                  const ticket = getTicketForRun(template, r.id)
                  const isActiveCycle = r.cycleId === activeCycleId
                  const isExpanded = expandedRun === r.id
                  return (
                    <Fragment key={r.id}>
                      <tr>
                        <td>
                          <div style={{ fontWeight: 700 }}>{r.id}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>
                            {new Date(r.timestamp).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </div>
                        </td>
                        <td>
                          <span className="uc-tag" style={isActiveCycle ? { borderColor: 'var(--primary)', color: 'var(--primary-dark)' } : undefined}>
                            {cycleLabel(cycles, r.cycleId)}
                          </span>
                        </td>
                        <td>
                          <span className={`status ${r.overallStatus === 'Success' ? 'ok' : r.overallStatus === 'Failed' ? 'fail' : 'none'}`}>
                            {r.overallStatus === 'Success'
                              ? '● Success'
                              : r.overallStatus === 'Failed'
                                ? '● Failed'
                                : `○ ${r.overallStatus || 'Not run'}`}
                          </span>
                        </td>
                        <td>
                          <span className={`reason ${r.failureReason ? r.failureReason.toLowerCase() : 'none'}`}>{r.failureReason || '—'}</span>
                        </td>
                        <td>
                          {ticket ? (
                            <span className="ticket-link">
                              {ticket.ticketId} · {ticket.status}
                            </span>
                          ) : r.overallStatus === 'Failed' && isAdmin ? (
                            <button className="btn small" onClick={() => setOpenRunForm(openRunForm === r.id ? null : r.id)}>
                              + Log ticket
                            </button>
                          ) : (
                            <span className="reason none">—</span>
                          )}
                        </td>
                        <td>
                          <button className="btn small" onClick={() => setExpandedRun(isExpanded ? null : r.id)}>
                            {isExpanded ? 'Hide nodes' : 'View nodes'}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                            <NodeResultsBreakdown template={template} run={r} />
                          </td>
                        </tr>
                      )}
                      {openRunForm === r.id && (
                        <tr>
                          <td colSpan={6} style={{ background: 'var(--surface-2)' }}>
                            <TicketForm
                              onCancel={() => setOpenRunForm(null)}
                              onSubmit={(data) => {
                                onLogTicket(template.id, { ...data, runId: r.id })
                                setOpenRunForm(null)
                              }}
                            />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card panel" style={{ marginTop: 16 }}>
        <div className="section-head" style={{ marginBottom: 10 }}>
          <div>
            <h3>Tickets</h3>
            <p className="p-sub">Raised against a specific failed node, or as a general backlog item. Status syncs live from the board.</p>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8 }}>
              {tickets.some((t) => canSyncFromBoard(t)) && (
                <button className="btn small" onClick={handleSyncAll} disabled={syncingAll}>
                  {syncingAll ? 'Syncing…' : '⟳ Sync all'}
                </button>
              )}
              <button className="btn small" onClick={() => setOpenGeneralForm((v) => !v)}>
                + Add general ticket
              </button>
            </div>
          )}
        </div>
        {ticketActionError && (
          <p style={{ fontSize: 12.5, color: 'var(--critical)', marginBottom: 10 }}>{ticketActionError}</p>
        )}
        {openGeneralForm && isAdmin && (
          <div style={{ marginBottom: 12 }}>
            <TicketForm
              onCancel={() => setOpenGeneralForm(false)}
              onSubmit={(data) => {
                onLogTicket(template.id, { ...data, runId: null })
                setOpenGeneralForm(false)
              }}
            />
          </div>
        )}
        {tickets.length === 0 ? (
          <div className="empty" style={{ marginTop: 0 }}>
            No tickets logged for this template yet.
          </div>
        ) : (
          <div className="ticket-grid">
            {tickets
              .slice()
              .sort((a, b) => b.createdAt - a.createdAt)
              .map((t) => {
                const stale = isTicketStale(t)
                const days = daysSinceActivity(t)
                const busy = busyTicketId === t.id
                return (
                  <div className="tcard" key={t.id}>
                    <div className="tcard-top">
                      <a className="tcard-id" href={t.url} target="_blank" rel="noreferrer">
                        {t.ticketId} ↗
                      </a>
                      <span className={`sev ${t.severity.toLowerCase()}`}>{t.severity}</span>
                    </div>
                    <div className="ttitle">{t.scenario || 'Whole template'}</div>
                    <div className="tmeta">
                      {t.summary || 'No summary'}
                      <br />
                      {t.runId ? `From a failed run · ${new Date(t.createdAt).toLocaleDateString()}` : 'General / backlog'} · {cycleLabel(cycles, t.cycleId)}
                      <br />
                      {t.system} · {t.assignee || 'Unassigned'} · {days === null ? 'no activity yet' : `updated ${days}d ago`}
                    </div>
                    <div className="tcard-bottom">
                      {canSyncFromBoard(t) ? (
                        <span
                          className={`tstatus ${t.status.replace(/[^a-z]/gi, '').toLowerCase()}`}
                          title={`Synced from the board — use Sync to refresh it, not editable here${t.boardState ? ` (board state: ${t.boardState})` : ''}`}
                        >
                          {t.boardState || t.status}
                        </span>
                      ) : (
                        <select
                          className={`tstatus-select ${t.status.replace(/[^a-z]/gi, '').toLowerCase()}`}
                          value={t.status}
                          disabled={!isAdmin}
                          title="No linked board for this ticket — set its status by hand"
                          onChange={(e) => onUpdateTicket(template.id, t.id, { status: e.target.value as TicketStatus })}
                        >
                          {TICKET_STATUSES.map((s) => (
                            <option key={s}>{s}</option>
                          ))}
                        </select>
                      )}
                      {isAdmin && canSyncFromBoard(t) && (
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button className="icon-btn" title="Sync status from board" disabled={busy} onClick={() => handleSync(t.id)}>
                            ⟳
                          </button>
                          <button
                            className={`btn small followup${stale ? ' stale' : ''}`}
                            title={stale ? 'No board activity in 5+ days' : 'Post a status-check comment on the board'}
                            disabled={busy}
                            onClick={() => handleFollowUp(t.id)}
                          >
                            {busy ? '…' : stale ? '! Follow up' : 'Follow up'}
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                )
              })}
          </div>
        )}
      </div>
    </div>
  )
}
