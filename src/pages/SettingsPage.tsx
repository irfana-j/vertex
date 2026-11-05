import { useEffect, useState } from 'react'
import { deleteAzureDevOpsIntegration, listAzureDevOpsIntegrations, testAzureDevOpsIntegration, upsertAzureDevOpsIntegration } from '../lib/devopsConnector'
import * as api from '../lib/api'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'
import { ALL_ROLES, isTeamScopedRole, roleLabel } from '../lib/permissions'
import type { AppUser, AzureDevOpsIntegrationEntry, Role } from '../types'

function UsersPanel() {
  const teams = useStore((s) => s.teams)
  const currentUserId = useAuthStore((s) => s.username) // just for the "can't delete yourself" hint below
  const [users, setUsers] = useState<AppUser[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [role, setRole] = useState<Role>('team_editor')
  const [teamIds, setTeamIds] = useState<string[]>([])
  const [creating, setCreating] = useState(false)

  const [resetId, setResetId] = useState<string | null>(null)
  const [resetPassword, setResetPassword] = useState('')

  const refresh = () => api.listUsers().then(setUsers).catch((err) => setError(err instanceof Error ? err.message : String(err)))

  useEffect(() => {
    refresh()
  }, [])

  const handleCreate = async () => {
    setError(null)
    if (!username.trim() || !password) {
      setError('Username and password are required.')
      return
    }
    setCreating(true)
    try {
      await api.createUser({ username: username.trim(), password, role, teamIds: isTeamScopedRole(role) ? teamIds : [] })
      setUsername('')
      setPassword('')
      setRole('team_editor')
      setTeamIds([])
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setCreating(false)
    }
  }

  const handleRoleChange = async (user: AppUser, newRole: Role) => {
    await api.updateUser(user.id, { role: newRole, teamIds: isTeamScopedRole(newRole) ? user.teamIds : [] })
    await refresh()
  }

  const handleToggleTeam = async (user: AppUser, teamId: string) => {
    const next = user.teamIds.includes(teamId) ? user.teamIds.filter((id) => id !== teamId) : [...user.teamIds, teamId]
    await api.updateUser(user.id, { teamIds: next })
    await refresh()
  }

  const handleResetPassword = async (userId: string) => {
    if (!resetPassword) return
    await api.updateUser(userId, { password: resetPassword })
    setResetId(null)
    setResetPassword('')
  }

  const handleDelete = async (user: AppUser) => {
    if (!confirm(`Delete user "${user.username}"? They'll be signed out immediately.`)) return
    try {
      await api.deleteUser(user.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <div className="card panel" style={{ maxWidth: 680, marginTop: 16 }}>
      <h3>Users</h3>
      <p className="p-sub">
        Real named accounts. Admin and Reader see everything; Team Admin/Editor/Reader only ever see the team(s) they're
        assigned to below — enforced on the server, not just hidden in this UI.
      </p>

      <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr 1fr', marginTop: 10, alignItems: 'end' }}>
        <div className="field">
          <label>Username</label>
          <input className="ctrl" value={username} onChange={(e) => setUsername(e.target.value)} placeholder="e.g. priya.cloud" />
        </div>
        <div className="field">
          <label>Password</label>
          <input className="ctrl" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="field">
          <label>Role</label>
          <select className="ctrl" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ALL_ROLES.map((r) => (
              <option key={r} value={r}>
                {roleLabel(r)}
              </option>
            ))}
          </select>
        </div>
        {isTeamScopedRole(role) && (
          <div className="field full" style={{ gridColumn: '1 / -1' }}>
            <label>Team(s)</label>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {teams.length === 0 && <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>No teams exist yet — create one from a template's page first.</span>}
              {teams.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  className={`uc-chip${teamIds.includes(t.id) ? ' on' : ''}`}
                  onClick={() => setTeamIds((ids) => (ids.includes(t.id) ? ids.filter((id) => id !== t.id) : [...ids, t.id]))}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {error && <p style={{ fontSize: 12.5, marginTop: 10, color: 'var(--critical)' }}>{error}</p>}

      <div style={{ marginTop: 16 }}>
        <button className="btn small primary" onClick={handleCreate} disabled={creating}>
          {creating ? 'Creating…' : '+ Add user'}
        </button>
      </div>

      {users && users.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 20 }}>
          <table>
            <thead>
              <tr>
                <th>Username</th>
                <th>Role</th>
                <th>Team(s)</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td style={{ fontWeight: 700 }}>{u.username}</td>
                  <td>
                    <select className="ctrl" style={{ fontSize: 12.5 }} value={u.role} onChange={(e) => handleRoleChange(u, e.target.value as Role)}>
                      {ALL_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {roleLabel(r)}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    {isTeamScopedRole(u.role) ? (
                      <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                        {teams.map((t) => (
                          <button
                            key={t.id}
                            type="button"
                            className={`uc-chip${u.teamIds.includes(t.id) ? ' on' : ''}`}
                            style={{ fontSize: 11 }}
                            onClick={() => handleToggleTeam(u, t.id)}
                          >
                            {t.name}
                          </button>
                        ))}
                        {u.teamIds.length === 0 && <span style={{ fontSize: 11.5, color: 'var(--critical)' }}>No team assigned — sees nothing yet</span>}
                      </div>
                    ) : (
                      <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>— (global)</span>
                    )}
                  </td>
                  <td>
                    <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                      {resetId === u.id ? (
                        <>
                          <input
                            className="ctrl"
                            type="password"
                            placeholder="New password"
                            style={{ width: 130, fontSize: 12 }}
                            value={resetPassword}
                            onChange={(e) => setResetPassword(e.target.value)}
                          />
                          <button className="btn small primary" onClick={() => handleResetPassword(u.id)}>
                            Save
                          </button>
                          <button
                            className="btn small"
                            onClick={() => {
                              setResetId(null)
                              setResetPassword('')
                            }}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button className="btn small" onClick={() => setResetId(u.id)}>
                          Reset password
                        </button>
                      )}
                      <button
                        className="icon-btn"
                        title={u.username === currentUserId ? "You can't delete your own account" : `Delete ${u.username}`}
                        disabled={u.username === currentUserId}
                        onClick={() => handleDelete(u)}
                      >
                        ✕
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

export default function SettingsPage() {
  const [integrations, setIntegrations] = useState<AzureDevOpsIntegrationEntry[] | null>(null)
  const [organization, setOrganization] = useState('')
  const [project, setProject] = useState('')
  const [personalAccessToken, setPersonalAccessToken] = useState('')
  const [testResult, setTestResult] = useState<{ ok: boolean; error?: string } | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)

  const refresh = () => listAzureDevOpsIntegrations().then(setIntegrations)

  useEffect(() => {
    refresh()
  }, [])

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const result = await testAzureDevOpsIntegration({ organization, project, personalAccessToken: personalAccessToken || undefined })
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      await upsertAzureDevOpsIntegration({ organization, project, personalAccessToken: personalAccessToken || undefined })
      setOrganization('')
      setProject('')
      setPersonalAccessToken('')
      setTestResult(null)
      await refresh()
      setSaveMsg('Saved.')
    } catch (err) {
      setSaveMsg(`Save failed: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setSaving(false)
      setTimeout(() => setSaveMsg(null), 5000)
    }
  }

  const handleRemove = async (org: string) => {
    if (!confirm(`Remove "${org}"? Tickets already linked to it will stop syncing until it's added back.`)) return
    await deleteAzureDevOpsIntegration(org)
    await refresh()
  }

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Link one or more Azure DevOps organizations so "Sync from board" and "Follow up" talk to real work items.</p>
        </div>
      </div>

      <div className="card panel" style={{ maxWidth: 520 }}>
        <h3>Add an organization</h3>
        <p className="p-sub">The personal access token is stored on the server only; it's never sent to the browser.</p>

        <div className="form-grid" style={{ gridTemplateColumns: '1fr 1fr', marginTop: 10 }}>
          <div className="field">
            <label>Organization</label>
            <input className="ctrl" value={organization} onChange={(e) => setOrganization(e.target.value)} placeholder="e.g. my-org" />
          </div>
          <div className="field">
            <label>Project</label>
            <input className="ctrl" value={project} onChange={(e) => setProject(e.target.value)} placeholder="e.g. Regression" />
          </div>
          <div className="field full">
            <label>Personal access token</label>
            <input
              className="ctrl"
              type="password"
              value={personalAccessToken}
              onChange={(e) => setPersonalAccessToken(e.target.value)}
              placeholder="Needs work item read & write scope"
            />
          </div>
        </div>

        {testResult && (
          <p style={{ fontSize: 12.5, marginTop: 10, color: testResult.ok ? 'var(--success)' : 'var(--critical)' }}>
            {testResult.ok ? 'Connection OK.' : testResult.error}
          </p>
        )}
        {saveMsg && <p style={{ fontSize: 12.5, marginTop: 10, color: 'var(--primary-dark)' }}>{saveMsg}</p>}

        <div style={{ display: 'flex', gap: 8, marginTop: 16 }}>
          <button className="btn small" onClick={handleTest} disabled={testing || !organization || !project}>
            {testing ? 'Testing…' : 'Test connection'}
          </button>
          <button className="btn small primary" onClick={handleSave} disabled={saving || !organization || !project}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {integrations && integrations.length > 0 && (
        <div className="card panel" style={{ maxWidth: 520, marginTop: 16 }}>
          <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span className="symphony-dot on" />
            Linked boards
          </h3>
          <p className="p-sub">A ticket picks which of these it belongs to when it's logged.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
            {integrations.map((i) => (
              <div className="symphony-pick-card" key={i.organization}>
                <div className="symphony-pick-row">
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 13.5 }}>{i.organization}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>Project: {i.project}</div>
                  </div>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                    <span className="uc-tag">Azure DevOps</span>
                    <button className="icon-btn" title={`Remove ${i.organization}`} onClick={() => handleRemove(i.organization)}>
                      ✕
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      <UsersPanel />
    </div>
  )
}
