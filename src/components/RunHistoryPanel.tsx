import { Fragment, useState } from 'react'
import { getScenarioNodes, getTicketForNode } from '../lib/selectors'
import RaiseTicketButton from './RaiseTicketButton'
import type { Cycle, Run, Template } from '../types'

function cycleLabel(cycles: Cycle[], cycleId: string): string {
  return cycles.find((c) => c.id === cycleId)?.label || 'Unknown cycle'
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
            {result?.status === 'fail' && (
              <>
                <pre className="node-result-log">{result.log || 'No log captured.'}</pre>
                <RaiseTicketButton
                  templateId={template.id}
                  templateName={template.symphonyTemplateName}
                  runId={run.id}
                  nodeId={n.id}
                  scenario={n.data.label}
                  reason={result.reason}
                  log={result.log}
                  existingTicket={getTicketForNode(template, run.id, n.id)}
                />
              </>
            )}
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
}

export default function RunHistoryPanel({ template, cycles, activeCycleId }: RunHistoryPanelProps) {
  const [expandedRun, setExpandedRun] = useState<string | number | null>(null)

  const runs = [...(template.runHistory || [])].sort((a, b) => b.timestamp - a.timestamp)

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
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => {
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
                          <button className="btn small" onClick={() => setExpandedRun(isExpanded ? null : r.id)}>
                            {isExpanded ? 'Hide nodes' : 'View nodes'}
                          </button>
                        </td>
                      </tr>
                      {isExpanded && (
                        <tr>
                          <td colSpan={5} style={{ background: 'var(--surface-2)' }}>
                            <NodeResultsBreakdown template={template} run={r} />
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
    </div>
  )
}
