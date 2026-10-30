import { useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'
import { computeDashboard, computeCustomGroupDashboard, computeCycleTrend, isTicketOpen, isTicketStale, daysSinceActivity } from '../lib/selectors'
import { getGroupColor, TICKET_STATUSES } from '../data/constants'
import { canSyncFromBoard } from '../lib/devopsConnector'
import Donut from '../components/dashboard/Donut'
import TicketForm from '../components/TicketForm'
import type { CycleTrendPoint, TicketStatus } from '../types'

interface TrendChartProps {
  log: CycleTrendPoint[]
  selectedCycleId: string | null
  onSelectCycle?: (cycleId: string) => void
}

function TrendChart({ log, selectedCycleId, onSelectCycle }: TrendChartProps) {
  if (log.length < 2) {
    return (
      <div style={{ color: 'var(--text-faint)', fontSize: 13, padding: '30px 0' }}>
        Start a second regression cycle to see a trend — each point is one full cycle's result.
      </div>
    )
  }
  const w = 560
  const left = 40
  const right = 20
  const top = 10
  const bottom = 170
  const innerW = w - left - right
  const step = innerW / (log.length - 1)
  const yFor = (v: number) => bottom - (v / 100) * (bottom - top)
  const points: [number, number][] = log.map((p, i) => [left + i * step, yFor(p.overallPct)])
  const linePoints = points.map((p) => p.join(',')).join(' ')
  const areaPoints = `${left},${bottom} ${linePoints} ${left + (log.length - 1) * step},${bottom}`
  const last = points[points.length - 1]
  const selected = log.find((p) => p.cycleId === selectedCycleId)
  const selectedPoint = selected ? points[log.indexOf(selected)] : null

  return (
    <svg viewBox={`0 0 ${w} 200`} width="100%" style={{ marginTop: 8, overflow: 'visible' }}>
      <line x1={left} y1={top} x2={left} y2={bottom} stroke="var(--border)" strokeWidth="1" />
      <line x1={left} y1={bottom} x2={w - right} y2={bottom} stroke="var(--border)" strokeWidth="1" />
      <g fontSize="10.5">
        {[0, 20, 40, 60, 80, 100].map((v) => (
          <text key={v} x={left - 8} y={yFor(v) + 3} textAnchor="end">
            {v}
          </text>
        ))}
      </g>
      <g stroke="var(--border)" strokeWidth="1" strokeDasharray="3 4">
        {[20, 40, 60, 80, 100].map((v) => (
          <line key={v} x1={left} y1={yFor(v)} x2={w - right} y2={yFor(v)} />
        ))}
      </g>
      <polygon points={areaPoints} fill="var(--primary)" opacity="0.1" />
      <polyline points={linePoints} fill="none" stroke="var(--primary)" strokeWidth="2.5" />
      {points.map(([x, y], i) => (
        <circle
          key={log[i].cycleId}
          cx={x}
          cy={y}
          r={i === points.length - 1 ? 5.5 : 3.5}
          fill={i === points.length - 1 ? 'var(--surface)' : 'var(--primary)'}
          stroke={i === points.length - 1 ? 'var(--primary)' : 'none'}
          strokeWidth={i === points.length - 1 ? 2.5 : 0}
          style={{ cursor: onSelectCycle ? 'pointer' : 'default' }}
          onClick={() => onSelectCycle?.(log[i].cycleId)}
        />
      ))}
      {selectedPoint && (
        <circle cx={selectedPoint[0]} cy={selectedPoint[1]} r="9" fill="none" stroke="var(--primary)" strokeWidth="1.5" opacity="0.5" />
      )}
      <text x={last[0]} y={last[1] - 12} textAnchor="end" fontSize="12.5" fontWeight="700" fill="var(--primary-dark)">
        {log[log.length - 1].overallPct}%{log[log.length - 1].open ? ' (in progress)' : ''}
      </text>
      <g fontSize="10.5">
        {log.map((p, i) => (
          <text
            key={p.cycleId}
            x={left + i * step}
            y={188}
            textAnchor="middle"
            fontWeight={p.cycleId === selectedCycleId ? 700 : 400}
            fill={p.cycleId === selectedCycleId ? 'var(--primary-dark)' : 'var(--text-muted)'}
            style={{ cursor: onSelectCycle ? 'pointer' : 'default' }}
            onClick={() => onSelectCycle?.(p.cycleId)}
          >
            {p.label}
          </text>
        ))}
      </g>
    </svg>
  )
}

function statusClass(status: string): string {
  if (status === 'Success') return 'ok'
  if (status === 'Failed') return 'fail'
  return 'none'
}
function ticketStatusClass(status: string): string {
  return status.replace(/[^a-z]/gi, '').toLowerCase()
}
function sevClass(sev: string): string {
  return sev.toLowerCase()
}

export default function DashboardPage() {
  const templates = useStore((s) => s.templates)
  const cycles = useStore((s) => s.cycles)
  const activeCycleId = useStore((s) => s.activeCycleId)
  const groups = useStore((s) => s.groups)
  const teams = useStore((s) => s.teams)
  const deleteGroup = useStore((s) => s.deleteGroup)
  const exportState = useStore((s) => s.exportState)
  const importState = useStore((s) => s.importState)
  const logTicket = useStore((s) => s.logTicket)
  const updateTicket = useStore((s) => s.updateTicket)
  const syncTicketFromBoard = useStore((s) => s.syncTicketFromBoard)
  const syncAllTicketsFromBoard = useStore((s) => s.syncAllTicketsFromBoard)
  const followUpOnTicket = useStore((s) => s.followUpOnTicket)
  const isAdmin = useAuthStore((s) => s.role === 'admin')

  const [selectedCycleId, setSelectedCycleId] = useState(activeCycleId)
  // If a new cycle starts elsewhere (sidebar), follow it back to "current"
  // rather than leaving the dashboard stuck looking at what's now history.
  useEffect(() => setSelectedCycleId(activeCycleId), [activeCycleId])

  const dash = computeDashboard(templates, cycles, selectedCycleId || '', groups, teams)
  const groupDash = computeCustomGroupDashboard(templates, groups, selectedCycleId || '')
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null)
  const cycleTrend = computeCycleTrend(templates, cycles)
  const trendStats = useMemo(() => {
    if (cycleTrend.length < 2) return null
    const current = cycleTrend[cycleTrend.length - 1]
    const prev = cycleTrend[cycleTrend.length - 2]
    const closed = cycleTrend.filter((p) => !p.open)
    const best = closed.length ? closed.reduce((a, b) => (b.overallPct > a.overallPct ? b : a)) : null
    return { current, prev, delta: current.overallPct - prev.overallPct, best }
  }, [cycleTrend])
  const selectedCycle = cycles.find((c) => c.id === selectedCycleId)
  const isViewingHistory = selectedCycleId !== activeCycleId
  const cyclesNewestFirst = useMemo(() => [...cycles].sort((a, b) => b.startedAt - a.startedAt), [cycles])

  const [search, setSearch] = useState('')
  const [groupFilter, setGroupFilter] = useState('All')
  const [teamFilter, setTeamFilter] = useState('All')
  const [statusFilter, setStatusFilter] = useState('All')
  const [syncingAllTickets, setSyncingAllTickets] = useState(false)
  const [busyTicketId, setBusyTicketId] = useState<string | null>(null)
  const [ticketActionError, setTicketActionError] = useState<string | null>(null)
  const [openTicketForm, setOpenTicketForm] = useState(false)
  const [newTicketTemplateId, setNewTicketTemplateId] = useState('')
  const ticketRollupRef = useRef<HTMLDivElement>(null)

  const handleOpenTicketFormFor = (templateId: string) => {
    setNewTicketTemplateId(templateId)
    setOpenTicketForm(true)
    ticketRollupRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return dash.rows.filter((r) => {
      if (q && !r.name.toLowerCase().includes(q)) return false
      if (groupFilter !== 'All' && !r.groupNames.includes(groupFilter)) return false
      if (teamFilter !== 'All' && r.teamName !== teamFilter) return false
      if (statusFilter !== 'All' && r.status !== statusFilter) return false
      return true
    })
  }, [dash.rows, search, groupFilter, teamFilter, statusFilter])

  const handleSyncAllTickets = async () => {
    setSyncingAllTickets(true)
    await syncAllTicketsFromBoard()
    setSyncingAllTickets(false)
  }
  const handleSyncTicket = async (templateId: string, ticketId: string) => {
    setBusyTicketId(ticketId)
    try {
      await syncTicketFromBoard(templateId, ticketId)
    } catch (err) {
      setTicketActionError(err instanceof Error ? err.message : String(err))
      setTimeout(() => setTicketActionError(null), 5000)
    } finally {
      setBusyTicketId(null)
    }
  }
  const handleFollowUp = async (templateId: string, ticketId: string) => {
    setBusyTicketId(ticketId)
    try {
      await followUpOnTicket(templateId, ticketId)
    } catch (err) {
      setTicketActionError(err instanceof Error ? err.message : String(err))
      setTimeout(() => setTicketActionError(null), 5000)
    } finally {
      setBusyTicketId(null)
    }
  }

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  const downloadJson = (obj: unknown, filename: string) => {
    const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }
  const dateStamp = () => new Date().toISOString().slice(0, 10)
  const handleExportAll = () => downloadJson(exportState(), `vertex-backup-${dateStamp()}.json`)
  const handleExportCycle = () => {
    const safeLabel = (selectedCycle?.label || 'cycle').replace(/\s+/g, '-')
    downloadJson(exportState(selectedCycleId || undefined), `vertex-${safeLabel}-${dateStamp()}.json`)
  }
  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    try {
      const payload = JSON.parse(await file.text())
      if (payload.kind === 'full' && !confirm('This replaces ALL current data (every cycle, template, group) with the imported file. Continue?')) {
        return
      }
      const result = importState(payload)
      setImportMsg(
        result.mode === 'replace'
          ? 'Imported — all data replaced.'
          : `Imported — ${result.addedTemplates} new template(s), ${result.addedRuns} new run(s) merged in.`
      )
    } catch (err) {
      setImportMsg(`Import failed: ${err instanceof Error ? err.message : String(err)}`)
    }
    setTimeout(() => setImportMsg(null), 6000)
  }

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <h1>Regression Dashboard</h1>
          <p>
            Showing the <b>{selectedCycle?.label}</b> cycle
            {isViewingHistory ? ` (closed ${selectedCycle?.closedAt ? new Date(selectedCycle.closedAt).toLocaleDateString() : ''})` : ' — current'}, across{' '}
            <b>{dash.totalTemplates}</b> template
            {dash.totalTemplates === 1 ? '' : 's'} with a Template Info node, "Enabled for regression" on, and a{' '}
            <span className="uc-tag" style={{ verticalAlign: 1 }}>
              Regression
            </span>{' '}
            label. Progress is counted by scenario node — a template with 40 nodes carries 40x the weight of one with 1 —
            not by template.
          </p>
          {dash.untrackedCount > 0 && (
            <p className="untracked-note">
              {dash.untrackedCount} more template{dash.untrackedCount === 1 ? '' : 's'} exist{dash.untrackedCount === 1 ? 's' : ''} but{' '}
              {dash.untrackedCount === 1 ? "isn't" : "aren't"} counted here.
            </p>
          )}
        </div>
        <div className="actions">
          <select className="ctrl" value={selectedCycleId ?? ''} onChange={(e) => setSelectedCycleId(e.target.value)}>
            {cyclesNewestFirst.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
                {c.id === activeCycleId ? ' (current)' : ''}
              </option>
            ))}
          </select>
          <button className="btn small" title="Export just this cycle's templates, runs and tickets" onClick={handleExportCycle}>
            ⬇ Export cycle
          </button>
          <button className="btn small" title="Export everything — every cycle, template, group" onClick={handleExportAll}>
            ⬇ Export all
          </button>
          {isAdmin && (
            <>
              <button className="btn small" onClick={() => fileInputRef.current?.click()}>
                ⬆ Import
              </button>
              <input ref={fileInputRef} type="file" accept="application/json" style={{ display: 'none' }} onChange={handleImportFile} />
            </>
          )}
        </div>
      </div>
      {importMsg && (
        <p style={{ marginTop: -6, marginBottom: 12, fontSize: 12.5, color: 'var(--primary-dark)', fontWeight: 600 }}>{importMsg}</p>
      )}

      {isViewingHistory && (
        <div className="history-banner">
          Viewing a past cycle — read-only history. Templates only run, and tickets only get logged, against the current
          cycle.
          <button className="btn small" onClick={() => setSelectedCycleId(activeCycleId)}>
            Back to current cycle
          </button>
        </div>
      )}

      <div className="overview-row">
        <div className="card overview-donut">
          <Donut percent={dash.overallPct} size={132} strokeWidth={14} />
          <div className="overview-donut-legend">
            <div className="ov-title">Overall Progress</div>
            <div className="ov-row">
              <span className="ov-dot" style={{ background: 'var(--primary)' }} />
              Nodes executed <b>{dash.executedNodesSum}</b>
            </div>
            <div className="ov-row">
              <span className="ov-dot" style={{ background: 'var(--border-strong)' }} />
              Nodes pending <b>{dash.pendingNodesSum}</b>
            </div>
            <div className="ov-row">
              <span className="ov-dot" style={{ background: 'transparent' }} />
              Across <b>{dash.totalTemplates}</b> templates, <b>{dash.totalNodesSum}</b> nodes total
            </div>
          </div>
        </div>
        <div className="overview-kpis">
          <div className="card kpi">
            <div className="label">Open tickets</div>
            <div className="value warn">{dash.openTicketsCount}</div>
            <div className="foot">
              {dash.staleTicketsCount > 0 ? `${dash.staleTicketsCount} stale, needing follow-up` : 'none stale'}
            </div>
          </div>
          <div className="card kpi">
            <div className="label">Flaky templates</div>
            <div className="value warn">{dash.flakyCount}</div>
            <div className="foot">mixed pass/fail recently</div>
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head">
          <div>
            <span className="eyebrow">Group rollup</span>
            <h2>Regression groups</h2>
            <p>
              Your own sets of tracked templates — add a template to a group from its own page. A node counts toward
              progress once it's been tested, pass or fail.
            </p>
          </div>
        </div>
        {groupDash.length === 0 ? (
          <div className="card empty-state">No groups yet — open a tracked template and use its "Groups" panel to create one.</div>
        ) : (
          <div className="cloud-row" style={{ gridTemplateColumns: `repeat(${Math.max(groupDash.length, 1)}, 1fr)` }}>
            {groupDash.map((g) => (
              <div className="card cloud-card" key={g.id}>
                <div className="cc-top" style={{ justifyContent: 'space-between' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span className="cloud-dot" style={{ background: getGroupColor(g.name), width: 10, height: 10 }} />
                    {g.name}
                  </span>
                  {isAdmin && (
                    <button
                      className="icon-btn"
                      title="Delete group (templates stay tracked)"
                      onClick={() => {
                        if (confirm(`Delete group "${g.name}"? Templates stay tracked — this only removes the grouping.`)) deleteGroup(g.id)
                      }}
                    >
                      ✕
                    </button>
                  )}
                </div>
                <div className="cc-body">
                  <Donut percent={g.pct} size={88} strokeWidth={9} color={getGroupColor(g.name)} />
                  <div className="cc-stats">
                    <div>
                      <b>{g.templateCount}</b>
                      <span>Templates</span>
                    </div>
                    <div>
                      <b style={{ color: 'var(--success)' }}>{g.passNodes}</b>
                      <span>Passed</span>
                    </div>
                    <div>
                      <b style={{ color: 'var(--critical)' }}>{g.failNodes}</b>
                      <span>Failed</span>
                    </div>
                  </div>
                </div>
                <button
                  className="btn small"
                  style={{ width: '100%', marginTop: 10 }}
                  onClick={() => setExpandedGroupId(expandedGroupId === g.id ? null : g.id)}
                >
                  {expandedGroupId === g.id ? 'Hide templates' : `View ${g.templateCount} template${g.templateCount === 1 ? '' : 's'}`}
                </button>
                {expandedGroupId === g.id && (
                  <div
                    style={{
                      marginTop: 10,
                      borderTop: '1px solid var(--border)',
                      paddingTop: 10,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 8,
                    }}
                  >
                    {g.templates.length === 0 ? (
                      <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>No templates in this group yet.</div>
                    ) : (
                      g.templates.map((t) => (
                        <Link key={t.id} to={`/templates/${t.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5 }}>
                            <span className={`status ${statusClass(t.status)}`} style={{ fontSize: 11 }}>
                              {t.status === 'Success' ? '●' : t.status === 'Failed' ? '●' : '○'}
                            </span>
                            <span style={{ flex: 1, fontWeight: 600 }}>{t.name}</span>
                            <span style={{ color: 'var(--success)' }}>{t.passNodes}✓</span>
                            <span style={{ color: 'var(--critical)' }}>{t.failNodes}✗</span>
                            <span style={{ color: 'var(--text-faint)' }}>
                              {t.testedNodes}/{t.totalNodes}
                            </span>
                          </div>
                        </Link>
                      ))
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="section">
        <div className="section-head">
          <div>
            <span className="eyebrow">Trend</span>
            <h2>Progress over time</h2>
          </div>
        </div>
        <div className="card panel">
          <h3>Completion trend</h3>
          <div className="p-sub">Share of scenario nodes executed by the end of each regression cycle — click a point to view that cycle</div>
          <div className="trend-panel-body">
            <div className="trend-chart-col">
              <TrendChart log={cycleTrend} selectedCycleId={selectedCycleId} onSelectCycle={setSelectedCycleId} />
            </div>
            {trendStats && (
              <div className="trend-stats-col">
                <div className="trend-stat">
                  <div className="label">Current cycle</div>
                  <div className="trend-stat-donut">
                    <Donut percent={trendStats.current.overallPct} size={86} strokeWidth={9} />
                  </div>
                  <div className="foot">
                    {trendStats.current.label}
                    {trendStats.current.open ? ' · in progress' : ''}
                  </div>
                </div>

                <div className="trend-stat">
                  <div className="label">Vs previous cycle</div>
                  <div className="mini-bars">
                    <div className="mini-bar-row">
                      <span className="mini-bar-tag" title={trendStats.prev.label}>
                        Prev
                      </span>
                      <span className="bar-track">
                        <span className="bar-fill dim" style={{ width: `${trendStats.prev.overallPct}%` }} />
                      </span>
                      <span className="mini-bar-val">{trendStats.prev.overallPct}%</span>
                    </div>
                    <div className="mini-bar-row">
                      <span className="mini-bar-tag" title={trendStats.current.label}>
                        Now
                      </span>
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${trendStats.current.overallPct}%` }} />
                      </span>
                      <span className="mini-bar-val">{trendStats.current.overallPct}%</span>
                    </div>
                  </div>
                  <div className={`foot delta ${trendStats.delta > 0 ? 'ok' : trendStats.delta < 0 ? 'warn' : ''}`}>
                    {trendStats.delta > 0 ? `▲ +${trendStats.delta}%` : trendStats.delta < 0 ? `▼ ${trendStats.delta}%` : '– no change'}
                  </div>
                </div>

                {trendStats.best && (
                  <div className="trend-stat">
                    <div className="label">
                      Best cycle <b>{trendStats.best.overallPct}%</b>
                    </div>
                    <span className="bar-track">
                      <span className="bar-fill" style={{ width: `${trendStats.best.overallPct}%` }} />
                    </span>
                    <div className="foot">{trendStats.best.label}</div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="section">
        <div className="section-head" style={{ alignItems: 'center' }}>
          <div>
            <span className="eyebrow">Template rollup</span>
            <h2>All templates</h2>
          </div>
          <div className="table-toolbar">
            <input
              className="ctrl"
              style={{ width: 200 }}
              placeholder="Search templates…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="ctrl" value={groupFilter} onChange={(e) => setGroupFilter(e.target.value)}>
              <option>All</option>
              {dash.groups.map((g) => (
                <option key={g}>{g}</option>
              ))}
            </select>
            <select className="ctrl" value={teamFilter} onChange={(e) => setTeamFilter(e.target.value)}>
              <option>All</option>
              {dash.teams.map((tm) => (
                <option key={tm}>{tm}</option>
              ))}
            </select>
            <select className="ctrl" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
              <option>All</option>
              <option>Success</option>
              <option>Failed</option>
              <option>Not Run</option>
            </select>
          </div>
        </div>
        <div className="card table-wrap">
          <table>
            <thead>
              <tr>
                <th>Template</th>
                <th>Group</th>
                <th>Team</th>
                <th>Labels</th>
                <th>Status</th>
                <th>Nodes</th>
                <th>Tickets</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0' }}>
                    No templates match your filters.
                  </td>
                </tr>
              )}
              {filteredRows.map((r) => (
                <tr key={r.id}>
                  <td className="tname">
                    <Link to={`/templates/${r.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                      {r.name}
                    </Link>
                    {r.flaky && <span className="flaky-tag">⚠ flaky</span>}
                  </td>
                  <td>
                    <div className="uc-tags">
                      {r.groupNames.length ? (
                        r.groupNames.map((name) => (
                          <span className="cloud-chip" key={name}>
                            <span className="cloud-dot" style={{ background: getGroupColor(name) }} />
                            {name}
                          </span>
                        ))
                      ) : (
                        <span className="uc-tag">Ungrouped</span>
                      )}
                    </div>
                  </td>
                  <td>
                    {r.teamName ? (
                      <span className="cloud-chip">
                        <span className="cloud-dot" style={{ background: getGroupColor(r.teamName) }} />
                        {r.teamName}
                      </span>
                    ) : (
                      <span className="uc-tag">Unassigned</span>
                    )}
                  </td>
                  <td>
                    <div className="uc-tags">
                      {r.labels.length ? (
                        r.labels.map((l) => (
                          <span className="uc-tag" key={l}>
                            {l}
                          </span>
                        ))
                      ) : (
                        <span className="uc-tag">—</span>
                      )}
                    </div>
                  </td>
                  <td>
                    <span className={`status ${statusClass(r.status)}`}>
                      {r.status === 'Success' ? '● Success' : r.status === 'Failed' ? '● Failed' : '○ Not run'}
                    </span>
                  </td>
                  <td>
                    <div className="prog-cell">
                      <span className="bar-track">
                        <span className="bar-fill" style={{ width: `${r.nodePct}%` }} />
                      </span>
                      <span className="pct">
                        {r.executedNodes}/{r.totalNodes}
                      </span>
                    </div>
                  </td>
                  <td>
                    {r.ticketCount > 0 ? (
                      <Link
                        to={`/templates/${r.id}`}
                        className="ticket-count-badge"
                        style={r.openTicketCount > 0 ? { color: 'var(--critical)', background: 'var(--critical-soft)' } : undefined}
                      >
                        {r.ticketCount} total{r.openTicketCount > 0 ? ` · ${r.openTicketCount} open` : ''}
                      </Link>
                    ) : r.status === 'Failed' && isAdmin ? (
                      <button
                        className="ticket-link"
                        style={{ background: 'var(--critical-soft)', color: 'var(--critical)', border: 'none', cursor: 'pointer' }}
                        onClick={() => handleOpenTicketFormFor(r.id)}
                      >
                        + Log ticket
                      </button>
                    ) : (
                      <span className="reason none">—</span>
                    )}
                  </td>
                  <td className="comment-cell">{r.comment}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="section" ref={ticketRollupRef}>
        <div className="section-head" style={{ alignItems: 'center' }}>
          <div>
            <span className="eyebrow">Ticket rollup</span>
            <h2>Open tickets across templates</h2>
            <p>Status syncs live from the board — stays open across cycles until resolved there.</p>
          </div>
          {isAdmin && (
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn small" onClick={() => setOpenTicketForm((v) => !v)}>
                + Add ticket
              </button>
              <button className="btn small" onClick={handleSyncAllTickets} disabled={syncingAllTickets}>
                {syncingAllTickets ? 'Syncing…' : '⟳ Sync all from board'}
              </button>
            </div>
          )}
        </div>
        {ticketActionError && (
          <p style={{ fontSize: 12.5, color: 'var(--critical)', marginBottom: 10 }}>{ticketActionError}</p>
        )}
        {openTicketForm && isAdmin && (
          <div className="card" style={{ padding: 16, marginBottom: 14 }}>
            <div className="field" style={{ maxWidth: 320, marginBottom: 10 }}>
              <label>Template</label>
              <select className="ctrl" value={newTicketTemplateId} onChange={(e) => setNewTicketTemplateId(e.target.value)}>
                <option value="">Select a template…</option>
                {dash.rows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </div>
            {newTicketTemplateId ? (
              <TicketForm
                onCancel={() => {
                  setOpenTicketForm(false)
                  setNewTicketTemplateId('')
                }}
                onSubmit={(data) => {
                  logTicket(newTicketTemplateId, { ...data, runId: null })
                  setOpenTicketForm(false)
                  setNewTicketTemplateId('')
                }}
              />
            ) : (
              <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>Pick which template this ticket belongs to first.</p>
            )}
          </div>
        )}
        {dash.allTickets.filter(isTicketOpen).length === 0 ? (
          <div className="card empty-state">No open tickets.</div>
        ) : (
          <div className="ticket-grid">
            {dash.allTickets.filter(isTicketOpen).map((t) => {
              const stale = isTicketStale(t)
              const days = daysSinceActivity(t)
              const busy = busyTicketId === t.id
              return (
                <div className="tcard" key={t.id}>
                  <div className="tcard-top">
                    <a className="tcard-id" href={t.url} target="_blank" rel="noreferrer">
                      {t.ticketId || 'Unlinked'} ↗
                    </a>
                    <span className={`sev ${sevClass(t.severity)}`}>{t.severity}</span>
                  </div>
                  <div className="ttitle">
                    <Link to={`/templates/${t.templateId}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                      {t.templateName}
                    </Link>
                    <span style={{ fontWeight: 400, color: 'var(--text-faint)', fontSize: 11.5 }}> · {t.scenario || 'whole template'}</span>
                  </div>
                  <div className="tmeta">
                    {t.summary || 'No summary yet'}
                    <br />
                    {t.system} · {t.assignee || 'Unassigned'} · {days === null ? 'no activity yet' : `updated ${days}d ago`}
                  </div>
                  <div className="tcard-bottom">
                    {canSyncFromBoard(t) ? (
                      <span
                        className={`tstatus ${ticketStatusClass(t.status)}`}
                        title={`Synced from the board — use Sync to refresh it, not editable here${t.boardState ? ` (board state: ${t.boardState})` : ''}`}
                      >
                        {t.boardState || t.status}
                      </span>
                    ) : (
                      <select
                        className={`tstatus-select ${ticketStatusClass(t.status)}`}
                        value={t.status}
                        disabled={!isAdmin}
                        title="No linked board for this ticket — set its status by hand"
                        onChange={(e) => updateTicket(t.templateId, t.id, { status: e.target.value as TicketStatus })}
                      >
                        {TICKET_STATUSES.map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    )}
                    {isAdmin && canSyncFromBoard(t) && (
                      <div style={{ display: 'flex', gap: 6 }}>
                        <button className="icon-btn" title="Sync status from board" disabled={busy} onClick={() => handleSyncTicket(t.templateId, t.id)}>
                          ⟳
                        </button>
                        <button
                          className={`btn small followup${stale ? ' stale' : ''}`}
                          title={stale ? 'No board activity in 5+ days' : 'Post a status-check comment on the board'}
                          disabled={busy}
                          onClick={() => handleFollowUp(t.templateId, t.id)}
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
