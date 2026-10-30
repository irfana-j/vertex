import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'
import { formatDateTime } from '../lib/format'
import { getGroupColor } from '../data/constants'
import { listSymphonyTemplates, getSymphonyTemplate } from '../lib/symphonyConnector'
import {
  getTemplateGroup,
  getTemplateMeta,
  getStatus,
  isFlaky,
  getTicketsForTemplate,
  isTicketOpen,
  isRegressionTemplate,
  getLatestRunOverall,
} from '../lib/selectors'
import type { FlowNode, SymphonyTemplateSummary } from '../types'

const PAGE_SIZE = 25
const day = 86400000

function StatusPill({ status, flaky }: { status: string; flaky: boolean }) {
  return (
    <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
      {status === 'Success' && <span className="status ok">● Success</span>}
      {status === 'Failed' && <span className="status fail">● Failed</span>}
      {status === 'Not Run' && <span className="status none">○ Not run</span>}
      {flaky && <span className="status flaky">⚠ Flaky</span>}
    </span>
  )
}

function timeAgo(ts: number | null | undefined): string | null {
  if (!ts) return null
  const days = Math.floor((Date.now() - ts) / day)
  if (days <= 0) return 'today'
  if (days === 1) return '1d ago'
  return `${days}d ago`
}

function PickerNodePreview({ symphonyTemplateId }: { symphonyTemplateId: string }) {
  const [nodes, setNodes] = useState<FlowNode[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setNodes(null)
    setError(null)
    getSymphonyTemplate(symphonyTemplateId)
      .then((tpl) => {
        if (!cancelled) setNodes(tpl?.nodes || [])
      })
      .catch((err) => {
        if (!cancelled) setError(err.message || String(err))
      })
    return () => {
      cancelled = true
    }
  }, [symphonyTemplateId])

  if (error) return <div className="node-preview-loading">Couldn't load nodes: {error}</div>
  if (!nodes) return <div className="node-preview-loading">Loading nodes…</div>
  if (nodes.length === 0) return <div className="node-preview-loading">No nodes returned for this template.</div>
  return (
    <div className="node-preview">
      <div className="node-breakdown-note" style={{ marginBottom: 6 }}>
        {nodes.length} node{nodes.length === 1 ? '' : 's'}
      </div>
      {nodes.map((n) => (
        <div className="node-preview-row" key={n.id}>
          <span className={`node-status-dot ${n.data.isScenario ? 'pass' : 'none'}`} />
          <span>{n.data.label}</span>
          {!n.data.isScenario && <span className="node-breakdown-note">config</span>}
        </div>
      ))}
    </div>
  )
}

interface TrackTemplatePickerProps {
  trackedSymphonyIds: string[]
  onCancel: () => void
  onTracked: (localId: string) => void
}

function TrackTemplatePicker({ trackedSymphonyIds, onCancel, onTracked }: TrackTemplatePickerProps) {
  const trackSymphonyTemplate = useStore((s) => s.trackSymphonyTemplate)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [all, setAll] = useState<SymphonyTemplateSummary[]>([])
  const [totalCount, setTotalCount] = useState<number | null>(null)
  const [allTemplateCount, setAllTemplateCount] = useState<number | null>(null)
  const [trackingId, setTrackingId] = useState<string | null>(null)
  const [trackError, setTrackError] = useState<string | null>(null)
  const [previewId, setPreviewId] = useState<string | null>(null)

  const [search, setSearch] = useState('')
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE)

  const load = () => {
    setLoading(true)
    setLoadError(null)
    listSymphonyTemplates()
      .then((templates) => {
        setAll(templates.filter((t) => !trackedSymphonyIds.includes(t.id)))
        setTotalCount(templates.totalCount ?? null)
        setAllTemplateCount(templates.allTemplateCount ?? null)
        setLoading(false)
      })
      .catch((err) => {
        setLoadError(err.message || String(err))
        setLoading(false)
      })
  }

  useEffect(load, []) // eslint-disable-line react-hooks/exhaustive-deps

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return all.filter((t) => {
      if (q && !t.id.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [all, search])

  const handleTrack = async (symphonyTemplateId: string) => {
    setTrackingId(symphonyTemplateId)
    setTrackError(null)
    try {
      const localId = await trackSymphonyTemplate(symphonyTemplateId)
      if (localId) onTracked(localId)
    } catch (err) {
      // trackSymphonyTemplate can throw partway through (e.g. the Symphony
      // call that pulls in the first job result) — without this, the thrown
      // rejection skipped setTrackingId(null) below entirely, leaving the
      // button stuck on "Tracking…" forever even though the template itself
      // was already added (that part commits to local state first).
      setTrackError(err instanceof Error ? err.message : String(err))
    } finally {
      setTrackingId(null)
    }
  }

  return (
    <div className="card" style={{ padding: 18, marginBottom: 18, maxWidth: 720 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
        <h3 style={{ fontSize: 14.5, fontWeight: 800, marginBottom: 4 }}>Track a Symphony template</h3>
        <button className="btn small" onClick={load} disabled={loading}>
          {loading ? 'Refreshing…' : '⟳ Refresh'}
        </button>
      </div>
      <p style={{ fontSize: 12.5, color: 'var(--text-muted)', marginBottom: 4 }}>
        Pulled live from Symphony's template list — {all.length}
        {totalCount !== null && totalCount !== all.length ? ` of ${totalCount}` : ''} available. Search by id or name to
        find the one you want.
      </p>
      {trackError && (
        <div className="not-tracked-note" style={{ marginBottom: 14 }}>
          Couldn't finish tracking that template: <b>{trackError}</b> It may already be partially tracked — check the
          templates list, or try again.
        </div>
      )}

      {allTemplateCount !== null && totalCount !== null && allTemplateCount > totalCount && (
        <p className="not-tracked-note" style={{ marginBottom: 14 }}>
          This account can see {totalCount} of {allTemplateCount} templates in the tenant — the rest aren't visible to
          it (likely a sharing/permission scope, not a bug here). Ask your Symphony admin to share them with this
          account, or track templates using a different account, if you need the full set.
        </p>
      )}

      <div className="table-toolbar" style={{ marginBottom: 14 }}>
        <input
          className="ctrl"
          style={{ flex: 1, minWidth: 160 }}
          placeholder="Search by template id or name…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value)
            setVisibleCount(PAGE_SIZE)
          }}
        />
      </div>

      {loading ? (
        <div className="empty" style={{ marginTop: 0 }}>
          Loading templates from Symphony…
        </div>
      ) : loadError ? (
        <div className="not-tracked-note" style={{ marginTop: 0 }}>
          Couldn't load templates from Symphony: <b>{loadError}</b>
          <br />
          Check the browser console / Network tab for the full response — this is usually an auth, CORS, or response-shape
          mismatch.
        </div>
      ) : filtered.length === 0 ? (
        <div className="empty" style={{ marginTop: 0 }}>
          {all.length === 0 ? 'Every Symphony template is already tracked here.' : 'No templates match your filters.'}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 420, overflowY: 'auto' }}>
          {filtered.slice(0, visibleCount).map((t) => (
            <div key={t.id} className="symphony-pick-card">
              <div className="symphony-pick-row">
                <div>
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    {t.name} <span className="symphony-pick-id">{t.id}</span>
                    {t.status === 'Draft' && (
                      <span className="uc-tag" title="Draft in Symphony — likely hasn't been run yet" style={{ marginLeft: 6, verticalAlign: 1 }}>
                        Draft
                      </span>
                    )}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>{t.description}</div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 6, alignItems: 'center' }}>
                    {t.group !== 'Unknown' && (
                      <span className="cloud-chip">
                        <span className="cloud-dot" style={{ background: getGroupColor(t.group) }} />
                        {t.group}
                      </span>
                    )}
                    {t.nodeCount > 0 && <span className="symphony-pick-meta">{t.nodeCount} nodes</span>}
                    <span className="symphony-pick-meta">created {timeAgo(t.createdAt)}</span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
                  <button className="btn small" onClick={() => setPreviewId(previewId === t.id ? null : t.id)}>
                    {previewId === t.id ? 'Hide nodes' : 'View nodes'}
                  </button>
                  <button className="btn small primary" disabled={trackingId === t.id} onClick={() => handleTrack(t.id)}>
                    {trackingId === t.id ? 'Tracking…' : 'Track'}
                  </button>
                </div>
              </div>
              {previewId === t.id && <PickerNodePreview symphonyTemplateId={t.id} />}
            </div>
          ))}
          {filtered.length > visibleCount && (
            <button className="btn small" onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
              Show more ({filtered.length - visibleCount} remaining)
            </button>
          )}
        </div>
      )}
      <button className="btn small" style={{ marginTop: 14 }} onClick={onCancel}>
        Close
      </button>
    </div>
  )
}

export default function TemplatesListPage() {
  const templates = useStore((s) => s.templates)
  const teams = useStore((s) => s.teams)
  const cycles = useStore((s) => s.cycles)
  const activeCycleId = useStore((s) => s.activeCycleId)
  const syncJobResults = useStore((s) => s.syncJobResults)
  const syncAllTemplates = useStore((s) => s.syncAllTemplates)
  const isAdmin = useAuthStore((s) => s.role === 'admin')
  const navigate = useNavigate()
  const activeCycle = cycles.find((c) => c.id === activeCycleId)

  const [picking, setPicking] = useState(false)
  const [syncingId, setSyncingId] = useState<string | null>(null)
  const [syncError, setSyncError] = useState<string | null>(null)
  const [syncingAll, setSyncingAll] = useState(false)
  const [syncAllFlash, setSyncAllFlash] = useState<string | null>(null)

  const handleSync = async (id: string) => {
    setSyncingId(id)
    setSyncError(null)
    try {
      await syncJobResults(id)
    } catch (err) {
      // Same reasoning as handleTrack above — without this, a thrown sync
      // error (e.g. a Symphony 401) left this card's Sync button stuck
      // disabled on "Syncing…" forever since setSyncingId(null) never ran.
      setSyncError(err instanceof Error ? err.message : String(err))
    } finally {
      setSyncingId(null)
    }
  }

  const handleSyncAll = async () => {
    setSyncingAll(true)
    const { added, updated } = await syncAllTemplates()
    setSyncingAll(false)
    const parts: string[] = []
    if (added > 0) parts.push(`+${added} new`)
    if (updated > 0) parts.push(`${updated} updated`)
    setSyncAllFlash(parts.length ? parts.join(', ') : 'No new job results')
    setTimeout(() => setSyncAllFlash(null), 4000)
  }

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <h1>Templates</h1>
          <p>
            Built and run in Symphony — this app tracks their regression metadata and job history. <b>{templates.length}</b>{' '}
            template{templates.length === 1 ? '' : 's'} tracked. Status below is for the <b>{activeCycle?.label}</b> cycle
            only.
          </p>
        </div>
        <div className="actions">
          {syncError && <span style={{ fontSize: 12, color: '#c0392b', fontWeight: 600 }}>Sync failed: {syncError}</span>}
          {syncAllFlash && <span style={{ fontSize: 12, color: 'var(--primary-dark)', fontWeight: 600 }}>{syncAllFlash}</span>}
          {isAdmin && templates.length > 0 && (
            <button className="btn small" onClick={handleSyncAll} disabled={syncingAll}>
              {syncingAll ? 'Syncing all…' : '⟳ Sync all'}
            </button>
          )}
          {isAdmin && (
            <button className="btn primary" onClick={() => setPicking(true)}>
              + Track Symphony template
            </button>
          )}
        </div>
      </div>

      {picking && isAdmin && (
        <TrackTemplatePicker
          trackedSymphonyIds={templates.map((t) => t.symphonyTemplateId)}
          onCancel={() => setPicking(false)}
          onTracked={(localId) => navigate(`/templates/${localId}`)}
        />
      )}

      {templates.length === 0 ? (
        <div className="card empty-state">
          <h3>No templates tracked yet</h3>
          <p>Track a Symphony template to start following its regression progress.</p>
        </div>
      ) : (
        <div className="tpl-grid">
          {templates.map((t) => {
            const group = getTemplateGroup(t)
            const teamName = t.teamId ? teams.find((tm) => tm.id === t.teamId)?.name ?? null : null
            const meta = getTemplateMeta(t)
            const status = getStatus(t, activeCycleId || '')
            const flaky = isFlaky(t)
            const tracked = isRegressionTemplate(t)
            const openTickets = getTicketsForTemplate(t).filter(isTicketOpen)
            const latestRun = getLatestRunOverall(t)

            return (
              <div className="card tpl-card" key={t.id}>
                <div className="tpl-card-top">
                  <div>
                    <h3>
                      <Link to={`/templates/${t.id}`} className="tpl-card-title-link">
                        {t.symphonyTemplateName}
                      </Link>
                    </h3>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      {group !== 'Unknown' && (
                        <span className="cloud-chip">
                          <span className="cloud-dot" style={{ background: getGroupColor(group) }} />
                          {group}
                        </span>
                      )}
                      {teamName && (
                        <span className="cloud-chip" title="Team">
                          <span className="cloud-dot" style={{ background: getGroupColor(teamName) }} />
                          {teamName}
                        </span>
                      )}
                      <span className="symphony-pick-id">{t.symphonyTemplateId}</span>
                    </div>
                  </div>
                  <StatusPill status={status} flaky={flaky} />
                </div>

                {!tracked && (
                  <div className="not-tracked-note">
                    Not counted in the dashboard — {meta.enabled === false ? 'turn on' : 'add'} "Enabled for regression" on its
                    Template Info node.
                  </div>
                )}

                <div className="desc">{t.description}</div>

                {latestRun && (
                  <div className="latest-job-line">
                    <span className={`status ${latestRun.overallStatus === 'Success' ? 'ok' : 'fail'}`}>
                      {latestRun.overallStatus === 'Success' ? '●' : '●'}
                    </span>
                    <span className="latest-job-id">{latestRun.id}</span>
                    <span className="latest-job-sub">
                      {latestRun.overallStatus} · {formatDateTime(latestRun.timestamp)}
                    </span>
                  </div>
                )}

                {openTickets.length > 0 && (
                  <div className="uc-tags">
                    <span className="uc-tag" style={{ color: 'var(--primary-dark)', background: 'var(--primary-soft)', borderColor: 'transparent' }}>
                      {openTickets.length} open ticket{openTickets.length > 1 ? 's' : ''}
                    </span>
                  </div>
                )}

                {isAdmin && (
                  <div className="tpl-card-foot">
                    <button className="btn small primary" disabled={syncingId === t.id} onClick={() => handleSync(t.id)}>
                      {syncingId === t.id ? 'Syncing…' : '⟳ Sync'}
                    </button>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
