import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'
import { listAzureDevOpsIntegrations } from '../lib/devopsConnector'
import type { AzureDevOpsIntegrationEntry, Ticket } from '../types'

function ticketStatusClass(status: string): string {
  return status.replace(/[^a-z]/gi, '').toLowerCase()
}

type Phase = 'idle' | 'loading-orgs' | 'no-org' | 'picking-org' | 'raising' | 'syncing'

interface RaiseTicketButtonProps {
  templateId: string
  templateName: string
  runId: string | number | null
  nodeId: string
  scenario: string
  reason?: string | null
  log?: string
  existingTicket: Ticket | null
}

// Sits right next to a failed node's error log, wherever one's shown
// (the template's latest node details, and a past run's own node
// breakdown) — raises a real work item on whichever Azure DevOps board is
// already connected, using the node's own log as the description, rather
// than asking for a ticket id that doesn't exist yet.
export default function RaiseTicketButton({ templateId, templateName, runId, nodeId, scenario, reason, log, existingTicket }: RaiseTicketButtonProps) {
  const isAdmin = useAuthStore((s) => s.role === 'admin')
  const raiseTicketForNode = useStore((s) => s.raiseTicketForNode)
  const syncTicketFromBoard = useStore((s) => s.syncTicketFromBoard)

  const [phase, setPhase] = useState<Phase>('idle')
  const [orgs, setOrgs] = useState<AzureDevOpsIntegrationEntry[]>([])
  const [selectedOrg, setSelectedOrg] = useState('')
  const [error, setError] = useState<string | null>(null)

  if (existingTicket) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        <a className="ticket-link" href={existingTicket.url} target="_blank" rel="noreferrer">
          {existingTicket.ticketId} ↗
        </a>
        <span
          className={`tstatus ${ticketStatusClass(existingTicket.status)}`}
          title={existingTicket.boardState ? `Board state: ${existingTicket.boardState}` : undefined}
        >
          {existingTicket.boardState || existingTicket.status}
        </span>
        {isAdmin && (
          <button
            className="icon-btn"
            title="Sync status from board"
            disabled={phase === 'syncing'}
            onClick={async () => {
              setPhase('syncing')
              try {
                await syncTicketFromBoard(templateId, existingTicket.id)
              } catch (err) {
                setError(err instanceof Error ? err.message : String(err))
                setTimeout(() => setError(null), 5000)
              } finally {
                setPhase('idle')
              }
            }}
          >
            ⟳
          </button>
        )}
        {error && <span style={{ fontSize: 11, color: 'var(--critical)' }}>{error}</span>}
      </div>
    )
  }

  if (!isAdmin) return null

  const raiseAgainst = async (organization: string) => {
    setPhase('raising')
    setError(null)
    try {
      await raiseTicketForNode(
        templateId,
        {
          runId,
          nodeId,
          scenario,
          title: `${scenario} failed — ${templateName}`,
          description: log || reason || 'No log captured for this failure.',
        },
        organization
      )
      setPhase('idle')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setPhase('idle')
      setTimeout(() => setError(null), 7000)
    }
  }

  const handleClick = async () => {
    setPhase('loading-orgs')
    setError(null)
    try {
      const list = (await listAzureDevOpsIntegrations()).filter((o) => o.configured)
      if (list.length === 0) {
        setPhase('no-org')
        return
      }
      if (list.length === 1) {
        await raiseAgainst(list[0].organization)
        return
      }
      setOrgs(list)
      setPhase('picking-org')
    } catch (err) {
      setPhase('idle')
      setError(err instanceof Error ? err.message : String(err))
      setTimeout(() => setError(null), 5000)
    }
  }

  if (phase === 'no-org') {
    return (
      <p style={{ fontSize: 11.5, color: 'var(--text-muted)', marginTop: 6 }}>
        No Azure DevOps organization linked — <Link to="/settings">add one in Settings</Link> to raise tickets.
      </p>
    )
  }

  if (phase === 'picking-org') {
    return (
      <div style={{ display: 'flex', gap: 6, marginTop: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <select className="ctrl" style={{ fontSize: 12 }} value={selectedOrg} onChange={(e) => setSelectedOrg(e.target.value)}>
          <option value="">Choose org…</option>
          {orgs.map((o) => (
            <option key={o.organization} value={o.organization}>
              {o.organization} ({o.project})
            </option>
          ))}
        </select>
        <button className="btn small primary" disabled={!selectedOrg} onClick={() => raiseAgainst(selectedOrg)}>
          Raise
        </button>
        <button className="btn small" onClick={() => setPhase('idle')}>
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div style={{ marginTop: 6 }}>
      <button className="btn small" disabled={phase === 'loading-orgs' || phase === 'raising'} onClick={handleClick}>
        {phase === 'raising' ? 'Raising ticket…' : phase === 'loading-orgs' ? 'Loading…' : '+ Raise ticket'}
      </button>
      {error && <p style={{ fontSize: 11, color: 'var(--critical)', marginTop: 4 }}>{error}</p>}
    </div>
  )
}
