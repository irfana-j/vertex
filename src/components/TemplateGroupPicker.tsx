import { useState } from 'react'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'

// User-defined sets of tracked templates (e.g. "Azure rollout") for
// cumulative progress on the dashboard — this app's own concept, separate
// from Symphony's own group field. A template can belong to any number of
// groups, same toggle-chip pattern as the use cases this replaced.
export default function TemplateGroupPicker({ templateId }: { templateId: string }) {
  const groups = useStore((s) => s.groups)
  const createGroup = useStore((s) => s.createGroup)
  const toggleTemplateInGroup = useStore((s) => s.toggleTemplateInGroup)
  const deleteGroup = useStore((s) => s.deleteGroup)
  const isAdmin = useAuthStore((s) => s.role === 'admin')

  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')

  const handleCreate = () => {
    const name = newName.trim()
    if (!name) return
    const groupId = createGroup(name)
    toggleTemplateInGroup(groupId, templateId)
    setNewName('')
    setCreating(false)
  }

  return (
    <div className="card panel">
      <h3>Groups</h3>
      <p className="p-sub">
        Your own sets of tracked templates for cumulative progress — e.g. "Azure rollout". Separate from Symphony's own
        group field.
      </p>
      <div className="use-case-chips">
        {groups.map((g) => (
          <span key={g.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
            <button
              className={`uc-chip${g.templateIds.includes(templateId) ? ' on' : ''}`}
              disabled={!isAdmin}
              onClick={() => toggleTemplateInGroup(g.id, templateId)}
            >
              {g.name}
            </button>
            {isAdmin && (
              <button
                className="icon-btn"
                style={{ width: 22, height: 22, fontSize: 11 }}
                title={`Delete group "${g.name}" (templates stay tracked)`}
                onClick={() => {
                  if (confirm(`Delete group "${g.name}"? Templates stay tracked — this only removes the grouping.`)) deleteGroup(g.id)
                }}
              >
                ✕
              </button>
            )}
          </span>
        ))}
        {isAdmin && creating ? (
          <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
            <input
              className="ctrl"
              style={{ width: 160 }}
              autoFocus
              placeholder="Group name…"
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
              + New group
            </button>
          )
        )}
      </div>
    </div>
  )
}
