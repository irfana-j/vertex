import { useEffect, useState } from 'react'
import { getConnectionStatus } from '../lib/symphonyConnector'
import type { SymphonyConnectionStatus } from '../types'

export default function SymphonyStatus() {
  const [status, setStatus] = useState<SymphonyConnectionStatus | null>(null)

  useEffect(() => {
    getConnectionStatus().then(setStatus)
  }, [])

  let label = 'Connecting…'
  if (status) {
    if (status.mode === 'mock') label = 'Connected (mock)'
    else label = status.connected ? 'Connected' : `Connection failed${status.error ? ` — ${status.error}` : ''}`
  }

  return (
    <div className="symphony-status">
      <span className={`symphony-dot${status?.connected ? ' on' : ''}`} />
      <div>
        <div className="symphony-status-title">Symphony</div>
        <div className="symphony-status-sub">{label}</div>
      </div>
    </div>
  )
}
