import { useState } from 'react'
import { useStore } from '../store/useStore'
import { useAuthStore } from '../store/useAuthStore'

function daysAgo(ts: number): number {
  return Math.floor((Date.now() - ts) / 86400000)
}

export default function CycleControl() {
  const cycles = useStore((s) => s.cycles)
  const activeCycleId = useStore((s) => s.activeCycleId)
  const startNewCycle = useStore((s) => s.startNewCycle)
  const isAdmin = useAuthStore((s) => s.role === 'admin')
  const [open, setOpen] = useState(false)
  const [label, setLabel] = useState('')

  const active = cycles.find((c) => c.id === activeCycleId)
  const started = active ? daysAgo(active.startedAt) : 0

  const handleStart = () => {
    startNewCycle(label)
    setLabel('')
    setOpen(false)
  }

  return (
    <div className="cycle-control">
      <div className="cycle-control-label">Regression cycle</div>
      <div className="cycle-control-active">{active?.label}</div>
      <div className="cycle-control-sub">{started === 0 ? 'started today' : `started ${started}d ago`}</div>

      {isAdmin &&
        (open ? (
          <div className="cycle-control-form">
            <input
              className="ctrl"
              autoFocus
              placeholder="e.g. Oct 2026"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleStart()}
            />
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button className="btn small primary" onClick={handleStart}>
                Start
              </button>
              <button className="btn small" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button className="btn small" style={{ width: '100%', marginTop: 8 }} onClick={() => setOpen(true)}>
            Start new cycle
          </button>
        ))}
    </div>
  )
}
