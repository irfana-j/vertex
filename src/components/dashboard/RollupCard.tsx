import { Link } from 'react-router-dom'
import Donut from './Donut'
import { getGroupColor } from '../../data/constants'
import type { GroupDashboard } from '../../types'

const DAY_MS = 86400000

function statusClass(status: string): string {
  if (status === 'Success') return 'ok'
  if (status === 'Failed') return 'fail'
  return 'none'
}

interface RollupCardProps {
  rollup: GroupDashboard
  cycleStartedAt: number
  cycleClosedAt: number | null
  expanded: boolean
  onToggleExpand: () => void
  onDelete?: () => void
  deleteNoun: string
  emptyTemplatesLabel: string
}

// Shared by the Group rollup and Team rollup sections — a card with TWO
// separate progress bars, not one, since they answer different questions:
// "Node progress" is pass/fail of tested scenario nodes (a failure here is
// a real dev-side/input-error signal), while "Templates run" is just
// coverage — did every template in this group/team get run at all this
// cycle, regardless of what it turned up. A team's regression is "done"
// once every template has run, independent of how many passed.
export default function RollupCard({
  rollup: g,
  cycleStartedAt,
  cycleClosedAt,
  expanded,
  onToggleExpand,
  onDelete,
  deleteNoun,
  emptyTemplatesLabel,
}: RollupCardProps) {
  const color = getGroupColor(g.name)
  // Finished → frozen on the day it actually finished. Still going → the
  // day it's on right now (or, for a closed past cycle being viewed as
  // history, the day the cycle itself closed — never later than that).
  const dayReferenceMs = g.finishedAt ?? cycleClosedAt ?? Date.now()
  const dayNumber = Math.floor((dayReferenceMs - cycleStartedAt) / DAY_MS) + 1

  return (
    <div className="card cloud-card">
      <div className="cc-top" style={{ justifyContent: 'space-between' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="cloud-dot" style={{ background: color, width: 10, height: 10 }} />
          {g.name}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {g.finishedAt !== null ? (
            <span className="rollup-badge finished" title={`Every template ran by day ${dayNumber} of this cycle`}>
              ✓ Finished · Day {dayNumber}
            </span>
          ) : g.isOverdue ? (
            <span className="rollup-badge overdue" title="Past the regression's time budget and still not fully run">
              ⚠ Overdue
            </span>
          ) : (
            g.templateCount > 0 && <span className="rollup-badge progress">Day {dayNumber}</span>
          )}
          {onDelete && (
            <button className="icon-btn" title={`Delete ${deleteNoun} (templates stay tracked)`} onClick={onDelete}>
              ✕
            </button>
          )}
        </span>
      </div>

      <div className="cc-progress-block">
        <div className="cc-subhead">Pass rate</div>
        <div className="cc-body">
          <Donut percent={g.pct} size={76} strokeWidth={8} color={color} />
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
      </div>

      <div className="cc-progress-block">
        <div className="cc-subhead">Templates run</div>
        <div className="cc-body">
          <Donut percent={g.templatesRunPct} size={76} strokeWidth={8} color={color} />
          <div className="cc-stats">
            <div>
              <b>{g.templatesRunCount}</b>
              <span>Run</span>
            </div>
            <div>
              <b>{g.templateCount - g.templatesRunCount}</b>
              <span>Not run yet</span>
            </div>
          </div>
        </div>
      </div>

      <button className="btn small" style={{ width: '100%' }} onClick={onToggleExpand}>
        {expanded ? 'Hide templates' : `View ${g.templateCount} template${g.templateCount === 1 ? '' : 's'}`}
      </button>
      {expanded && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {g.templates.length === 0 ? (
            <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{emptyTemplatesLabel}</div>
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
  )
}
