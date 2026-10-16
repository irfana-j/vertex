import { useEffect, useState } from 'react'
import { deleteAzureDevOpsIntegration, listAzureDevOpsIntegrations, testAzureDevOpsIntegration, upsertAzureDevOpsIntegration } from '../lib/devopsConnector'
import type { AzureDevOpsIntegrationEntry } from '../types'

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
    </div>
  )
}
