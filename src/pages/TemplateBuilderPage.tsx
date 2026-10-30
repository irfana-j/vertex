import { useState } from 'react'
import { useNavigate, useParams, Link } from 'react-router-dom'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'
import TemplateGroupPicker from '../components/TemplateGroupPicker'
import TemplateTeamPicker from '../components/TemplateTeamPicker'
import NodeList from '../components/NodeList'
import RunHistoryPanel from '../components/RunHistoryPanel'
import { getRegressionNode, getScenarioNodes, getExecutedScenarioNodeIds, getLatestRunOverall } from '../lib/selectors'
import { formatDateTime } from '../lib/format'
import type { NodeData } from '../types'

function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never'
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

export default function TemplateBuilderPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const template = useStore((s) => s.templates.find((t) => t.id === id))
  const cycles = useStore((s) => s.cycles)
  const activeCycleId = useStore((s) => s.activeCycleId)
  const updateTemplateFlow = useStore((s) => s.updateTemplateFlow)
  const refreshTemplateStructure = useStore((s) => s.refreshTemplateStructure)
  const syncJobResults = useStore((s) => s.syncJobResults)
  const deleteTemplate = useStore((s) => s.deleteTemplate)
  const isAdmin = useAuthStore((s) => s.role === 'admin')

  const [syncing, setSyncing] = useState(false)
  const [syncFlash, setSyncFlash] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  const handleSync = async () => {
    if (!id) return
    setSyncing(true)
    try {
      const { added, updated } = await syncJobResults(id)
      const parts: string[] = []
      if (added > 0) parts.push(`+${added} new result${added > 1 ? 's' : ''}`)
      if (updated > 0) parts.push(`${updated} updated`)
      setSyncFlash(parts.length ? parts.join(', ') : 'No new job results')
    } catch (err) {
      setSyncFlash(`Sync failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSyncing(false)
      setTimeout(() => setSyncFlash(null), 4000)
    }
  }

  const handleRefreshStructure = async () => {
    if (!id) return
    setRefreshing(true)
    await refreshTemplateStructure(id)
    setRefreshing(false)
  }

  const handleDelete = () => {
    if (!id || !template) return
    if (confirm(`Stop tracking "${template.symphonyTemplateName}" for regression? This only removes it from this app — nothing changes in Symphony.`)) {
      deleteTemplate(id)
      navigate('/templates')
    }
  }

  if (!template || !id) {
    return (
      <div className="main">
        <div className="empty-state">
          <h3>Template not found</h3>
          <Link to="/templates" className="btn primary">
            Back to templates
          </Link>
        </div>
      </div>
    )
  }

  const infoNode = getRegressionNode(template)
  const infoData = infoNode?.data

  // Every edit here writes straight through — no separate save step, same
  // as a ticket's status select elsewhere in the app.
  const updateInfo = (patch: Partial<NodeData>) => {
    if (!infoData) return
    const newData = { ...infoData, ...patch }
    const newNodes = template.nodes.map((n) => (n.type === 'regressionInfo' ? { ...n, data: newData } : n))
    updateTemplateFlow(id, newNodes, template.edges)
  }

  const scenarioCount = getScenarioNodes(template).length
  const executedScenarioCount = getExecutedScenarioNodeIds(template, activeCycleId || '').size
  const latestRun = getLatestRunOverall(template)

  return (
    <div className="main">
      <Link to="/templates" className="back-link">
        ← Back to templates
      </Link>

      <div className="builder-topbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          <h2 style={{ fontSize: 18, fontWeight: 800 }}>{template.symphonyTemplateName}</h2>
          <span className="symphony-badge">Symphony · {template.symphonyTemplateId}</span>
          <span className="cycle-badge">{cycles.find((c) => c.id === activeCycleId)?.label} cycle</span>
          <span className="symphony-badge">
            {executedScenarioCount}/{scenarioCount} nodes this cycle
          </span>
          {infoData && (
            <>
              <button
                className={`symphony-badge toggle-badge${infoData.enabled ? ' on' : ''}`}
                onClick={() => isAdmin && updateInfo({ enabled: !infoData.enabled })}
                disabled={!isAdmin}
                title="Required (with the Regression label) for this template to count on the dashboard"
              >
                {infoData.enabled ? '✓ Tracked for regression' : 'Not tracked'}
              </button>
            </>
          )}
        </div>
        {isAdmin && (
          <div className="page-head actions" style={{ marginBottom: 0 }}>
            {syncFlash && <span style={{ fontSize: 12, color: 'var(--primary-dark)', fontWeight: 600 }}>{syncFlash}</span>}
            <button className="btn danger" onClick={handleDelete}>
              Stop tracking
            </button>
            <button className="btn primary" onClick={handleSync} disabled={syncing}>
              {syncing ? 'Syncing…' : '⟳ Sync job results'}
            </button>
          </div>
        )}
      </div>

      <div className="sync-strip">
        <span>
          Structure last synced from Symphony <b>{timeAgo(template.lastSyncedAt)}</b>
          {latestRun && (
            <>
              {' · '}Latest job <b className="latest-job-id">{latestRun.id}</b> —{' '}
              <span className={latestRun.overallStatus === 'Success' ? 'sync-strip-ok' : 'sync-strip-fail'}>{latestRun.overallStatus}</span>,{' '}
              {formatDateTime(latestRun.timestamp)}
            </>
          )}
        </span>
        {isAdmin && (
          <button className="btn small" onClick={handleRefreshStructure} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh structure'}
          </button>
        )}
      </div>

      {!latestRun && template.symphonyEverRun === false && (
        <div className="not-tracked-note" style={{ marginBottom: 18 }}>
          This template hasn't been run in Symphony yet{template.symphonyStatus ? ` (status: ${template.symphonyStatus})` : ''} —
          there's no job data to sync until it's executed there at least once.
        </div>
      )}

      <div className="builder-stack">
        <TemplateTeamPicker templateId={template.id} />
        <TemplateGroupPicker templateId={template.id} />
        <NodeList template={template} />
      </div>

      <RunHistoryPanel template={template} cycles={cycles} activeCycleId={activeCycleId} />
    </div>
  )
}
