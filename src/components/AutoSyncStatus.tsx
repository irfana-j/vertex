import { useEffect, useState } from 'react'
import { useStore } from '../store/useStore'

function timeAgo(ts: number | null): string | null {
  if (!ts) return null
  const mins = Math.floor((Date.now() - ts) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  return `${hours}h ago`
}

// Confirms the 10-minute background auto-sync is actually running, instead
// of it being an invisible, unverifiable assumption. Ticks its own display
// every 30s so "Xm ago" stays current between actual syncs.
export default function AutoSyncStatus() {
  const lastAutoSyncAt = useStore((s) => s.lastAutoSyncAt)
  const [, forceTick] = useState(0)

  useEffect(() => {
    const id = setInterval(() => forceTick((n) => n + 1), 30000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="cycle-control-sub" style={{ marginTop: 2 }}>
      Auto-sync: {lastAutoSyncAt ? `last ran ${timeAgo(lastAutoSyncAt)}` : 'not run yet (every 10m)'}
    </div>
  )
}
