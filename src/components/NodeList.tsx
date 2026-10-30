import { CLOUD_COLOR } from '../data/constants'
import { getLatestRunOverall, getTicketForNode } from '../lib/selectors'
import RaiseTicketButton from './RaiseTicketButton'
import type { Template } from '../types'

// A plain list of this template's actual Symphony structure — every node,
// read-only, with its latest pass/fail and log inline. Replaces a
// drag-and-drop canvas with something you can just scan.
export default function NodeList({ template }: { template: Template }) {
  const latestRun = getLatestRunOverall(template)
  const latest = latestRun?.results || {}
  const structuralNodes = template.nodes.filter((n) => n.type !== 'regressionInfo')

  return (
    <div className="card panel">
      <h3>Nodes</h3>
      <p className="p-sub">Every node in this template, mirrored from Symphony — config nodes plus each scenario.</p>
      <div className="node-list" style={{ marginTop: 12 }}>
        {structuralNodes.map((n) => {
          const result = n.data.isScenario ? latest[n.id] : null
          return (
            <div className="node-list-row" key={n.id}>
              <span
                className={`node-status-dot ${n.data.isScenario ? (result ? (result.status === 'pass' ? 'pass' : 'fail') : 'none') : 'none'}`}
              />
              <div className="node-list-main">
                <div className="node-list-label">
                  {n.data.operation || n.data.label}
                  {n.data.service && (
                    <span className="node-list-service" style={{ color: CLOUD_COLOR[n.data.service] || 'var(--text-muted)' }}>
                      {n.data.service}
                    </span>
                  )}
                  <span className="node-list-type">{n.data.isScenario ? 'scenario' : 'config'}</span>
                </div>
                {n.data.text && <div className="node-list-desc">{n.data.text}</div>}
                {result?.status === 'fail' && (
                  <>
                    {result.reason && <div className="node-result-reason">{result.reason}</div>}
                    <pre className="node-result-log">{result.log || 'No log captured for this failure.'}</pre>
                    <RaiseTicketButton
                      templateId={template.id}
                      templateName={template.symphonyTemplateName}
                      runId={latestRun?.id ?? null}
                      nodeId={n.id}
                      scenario={n.data.operation || n.data.label}
                      reason={result.reason}
                      log={result.log}
                      existingTicket={getTicketForNode(template, latestRun?.id ?? null, n.id)}
                    />
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
