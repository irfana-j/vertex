import { useEffect, useState } from 'react'
import { NavLink, Navigate, Route, Routes } from 'react-router-dom'
import TemplatesListPage from './pages/TemplatesListPage'
import TemplateBuilderPage from './pages/TemplateBuilderPage'
import DashboardPage from './pages/DashboardPage'
import CycleControl from './components/CycleControl'
import SymphonyStatus from './components/SymphonyStatus'
import AutoSyncStatus from './components/AutoSyncStatus'
import LoginScreen from './components/LoginScreen'
import BrandMark from './components/BrandMark'
import SettingsPage from './pages/SettingsPage'
import { useStore } from './store/useStore'
import { useAuthStore } from './store/useAuthStore'

const AUTO_SYNC_INTERVAL_MS = 10 * 60 * 1000
// Matches the 15-minute poll the reference Azure DevOps sync logic uses —
// a ticket's board status (and the auto-close-on-terminal-state it drives)
// refreshes on its own instead of only on a manual "Sync" click.
const TICKET_SYNC_INTERVAL_MS = 15 * 60 * 1000
// A read-only viewer never writes back to the backend, so it has no other
// way to see what an admin's browser just synced — this just re-pulls the
// shared state on a shorter interval instead.
const VIEWER_REFRESH_INTERVAL_MS = 60 * 1000

function FullScreenMessage({ text }: { text: string }) {
  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
      {text}
    </div>
  )
}

export default function App() {
  const authStatus = useAuthStore((s) => s.status)
  const role = useAuthStore((s) => s.role)
  const checkSession = useAuthStore((s) => s.checkSession)
  const logout = useAuthStore((s) => s.logout)
  const syncAllTemplates = useStore((s) => s.syncAllTemplates)
  const syncAllTicketsFromBoard = useStore((s) => s.syncAllTicketsFromBoard)
  const startNewCycle = useStore((s) => s.startNewCycle)
  const cycleCount = useStore((s) => s.cycles.length)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    checkSession()
  }, [checkSession])

  // The store's backend-backed persist is deliberately not hydrated until
  // we know a session exists (an unauthenticated GET /api/state 401s) —
  // kick it off here, right after login, instead of at module load.
  useEffect(() => {
    if (authStatus !== 'authenticated') return
    setHydrated(false)
    const unsub = useStore.persist.onFinishHydration(() => setHydrated(true))
    useStore.persist.rehydrate()
    return unsub
  }, [authStatus])

  // First-ever login against a brand-new backend has no cycle yet — give it
  // one so the rest of the app (which assumes an active cycle) has
  // somewhere to attach new runs and tickets to.
  useEffect(() => {
    if (!hydrated || role !== 'admin' || cycleCount > 0) return
    startNewCycle()
  }, [hydrated, role, cycleCount, startNewCycle])

  // Background auto-sync — every tracked template's job results refresh on
  // their own every 10 minutes, not just when someone happens to open that
  // template's page and click Sync. Admin-only: a viewer's sync would just
  // get rejected when it tried to save back to the backend.
  useEffect(() => {
    if (!hydrated || role !== 'admin') return
    const id = setInterval(() => {
      syncAllTemplates()
    }, AUTO_SYNC_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hydrated, role, syncAllTemplates])

  // Same admin-only reasoning as the template auto-sync above — a viewer
  // can't write the result back anyway, and it'd just get a 403.
  useEffect(() => {
    if (!hydrated || role !== 'admin') return
    const id = setInterval(() => {
      syncAllTicketsFromBoard()
    }, TICKET_SYNC_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hydrated, role, syncAllTicketsFromBoard])

  useEffect(() => {
    if (!hydrated || role !== 'user') return
    const id = setInterval(() => {
      useStore.persist.rehydrate()
    }, VIEWER_REFRESH_INTERVAL_MS)
    return () => clearInterval(id)
  }, [hydrated, role])

  if (authStatus === 'checking') return <FullScreenMessage text="Loading…" />
  if (authStatus === 'anonymous') return <LoginScreen />
  if (!hydrated) return <FullScreenMessage text="Loading regression data…" />

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <BrandMark className="mark" />
          <span className="name">
            Vertex
            <small>Regression Studio</small>
          </span>
        </div>
        <nav className="nav">
          <NavLink to="/templates" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="dot" /> Templates
          </NavLink>
          <NavLink to="/dashboard" className={({ isActive }) => (isActive ? 'active' : '')}>
            <span className="dot" /> Regression Dashboard
          </NavLink>
          {role === 'admin' && (
            <NavLink to="/settings" className={({ isActive }) => (isActive ? 'active' : '')}>
              <span className="dot" /> Settings
            </NavLink>
          )}
        </nav>

        <SymphonyStatus />
        <AutoSyncStatus />
        <CycleControl />

        <div className="sidebar-foot">
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 6 }}>
            <span>
              Signed in as <b>{role === 'admin' ? 'Admin' : 'Viewer'}</b>
            </span>
            <button className="btn small" onClick={() => logout()}>
              Log out
            </button>
          </div>
          Tracks Symphony templates for regression. Data is shared across everyone signed in to this app.
          {role === 'user' && ' You have read-only access.'}
        </div>
      </aside>

      <Routes>
        <Route path="/" element={<Navigate to="/templates" replace />} />
        <Route path="/templates" element={<TemplatesListPage />} />
        <Route path="/templates/:id" element={<TemplateBuilderPage />} />
        <Route path="/dashboard" element={<DashboardPage />} />
        {role === 'admin' && <Route path="/settings" element={<SettingsPage />} />}
        <Route path="*" element={<Navigate to="/templates" replace />} />
      </Routes>
    </div>
  )
}
