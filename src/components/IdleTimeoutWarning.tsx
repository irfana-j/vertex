import { useEffect, useRef, useState } from 'react'
import { useAuthStore } from '../store/useAuthStore'

// Mirrors server/src/auth.ts's SESSION_IDLE_TIMEOUT_MS — this is purely a
// client-side heads-up so the user isn't dropped with no warning; the
// server enforces the real cutoff itself regardless of what this shows.
const IDLE_LOGOUT_MS = 30 * 60 * 1000
const IDLE_WARNING_MS = 25 * 60 * 1000
const CHECK_INTERVAL_MS = 5000
const ACTIVITY_EVENTS = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart'] as const

export default function IdleTimeoutWarning() {
  const status = useAuthStore((s) => s.status)
  const checkSession = useAuthStore((s) => s.checkSession)
  const logout = useAuthStore((s) => s.logout)
  const lastActivityRef = useRef(Date.now())
  // Once the warning is up, further mouse/keyboard activity no longer
  // resets the clock on its own — only an explicit "Stay logged in" click
  // does, so this can't silently diverge from the server (which only ever
  // refreshes on an actual authenticated request, not raw DOM events).
  const warningActiveRef = useRef(false)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)

  useEffect(() => {
    if (status !== 'authenticated') return
    lastActivityRef.current = Date.now()
    warningActiveRef.current = false
    setSecondsLeft(null)

    const markActive = () => {
      if (warningActiveRef.current) return
      lastActivityRef.current = Date.now()
    }
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, markActive, { passive: true }))

    const id = setInterval(() => {
      const idleFor = Date.now() - lastActivityRef.current
      if (idleFor >= IDLE_LOGOUT_MS) {
        warningActiveRef.current = false
        setSecondsLeft(null)
        logout()
      } else if (idleFor >= IDLE_WARNING_MS) {
        warningActiveRef.current = true
        setSecondsLeft(Math.ceil((IDLE_LOGOUT_MS - idleFor) / 1000))
      }
    }, CHECK_INTERVAL_MS)

    return () => {
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, markActive))
      clearInterval(id)
    }
  }, [status, logout])

  if (status !== 'authenticated' || secondsLeft === null) return null

  const stayLoggedIn = () => {
    warningActiveRef.current = false
    lastActivityRef.current = Date.now()
    setSecondsLeft(null)
    // Pings the backend so the server's own idle clock (independent of
    // this client-side one) gets refreshed too, not just dismissed locally.
    checkSession()
  }

  const minutes = Math.floor(secondsLeft / 60)
  const seconds = secondsLeft % 60

  return (
    <div className="idle-warning-overlay">
      <div className="idle-warning-card">
        <h3>Still there?</h3>
        <p>
          You've been inactive for a while — you'll be signed out in{' '}
          <b>
            {minutes}:{seconds.toString().padStart(2, '0')}
          </b>{' '}
          unless you stay logged in.
        </p>
        <button className="btn" onClick={stayLoggedIn}>
          Stay logged in
        </button>
      </div>
    </div>
  )
}
