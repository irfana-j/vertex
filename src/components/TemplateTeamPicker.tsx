import { useState } from 'react'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'

// Which team owns this template — a separate, single-pick dimension from
// Regression Groups (TemplateGroupPicker), which are ad hoc many-to-many
// sets. A template belongs to at most one team. Purely organizational: a
// filter, not an access boundary — every team's templates stay visible to
// everyone with login access.
export default function TemplateTeamPicker({ templateId }: { templateId: string }) {
  const teams = useStore((s) => s.teams)
  const template = useStore((s) => s.templates.find((t) => t.id === templateId))
  const createTeam = useStore((s) => s.createTeam)
  const setTemplateTeam = useStore((s) => s.setTemplateTeam)
  const deleteTeam = useStore((s) => s.deleteTeam)
  const isAdmin = useAuthStore((s) => s.role === 'admin')

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) return
    const teamId = createTeam(name)
    setTemplateTeam(templateId, teamId)
    setNewName('')
    setCreating(false)
  }

  return (
    <div className="card panel">
      <h3>Team</h3>
      <p className="p-sub">Which team owns this template — a high-level filter across the Dashboard, separate from Groups.</p>
      <div className="use-case-chips">
        {teams.map((tm) => {
          const on = template?.teamId === tm.id
          return (
            <span key={tm.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
              <button
                className={`uc-chip${on ? ' on' : ''}`}
                disabled={!isAdmin}
                onClick={() => setTemplateTeam(templateId, on ? null : tm.id)}
              >
                {tm.name}
              </button>
              {isAdmin && (
                <button
                  className="icon-btn"
                  style={{ width: 22, height: 22, fontSize: 11 }}
                  title={`Delete team "${tm.name}" (templates stay tracked)`}
                  onClick={() => {
                    if (confirm(`Delete team "${tm.name}"? Templates stay tracked — this only clears their team.`)) deleteTeam(tm.id)
                  }}
                >
                  ✕
                </button>
              )}
            </span>
          )
        })}
        {isAdmin && creating ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              className="ctrl"
              style={{ width: 160 }}
              autoFocus
              placeholder="Team name…"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleCreate()
                if (e.key === 'Escape') {
                  setCreating(false)
                  setNewName('')
                }
              }}
            />
            <button className="btn small primary" onClick={handleCreate}>
              Add
            </button>
            <button
              className="btn small"
              onClick={() => {
                setCreating(false)
                setNewName('')
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          isAdmin && (
            <button className="uc-chip" onClick={() => setCreating(true)}>
              + New team
            </button>
          )
        )}
      </div>
    </div>
  )
}
