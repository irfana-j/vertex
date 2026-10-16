import { useState, type FormEvent } from 'react'
import { useAuthStore } from '../store/useAuthStore'
import NetworkBackground from './NetworkBackground'
import BrandMark from './BrandMark'

function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
      <path d="M1 12s4-7 11-7 11 7 11 7-4 7-11 7-11-7-11-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
function EyeOffIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" width={18} height={18}>
      <path d="M17.94 17.94A10.94 10.94 0 0 1 12 19c-7 0-11-7-11-7a21.6 21.6 0 0 1 5.06-5.94M9.9 4.24A10.4 10.4 0 0 1 12 4c7 0 11 7 11 7a21.6 21.6 0 0 1-2.16 3.19M14.12 14.12a3 3 0 1 1-4.24-4.24" />
      <path d="M1 1l22 22" />
    </svg>
  )
}

export default function LoginScreen() {
  const login = useAuthStore((s) => s.login)
  const error = useAuthStore((s) => s.error)
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (!username || !password || submitting) return
    setSubmitting(true)
    await login(username, password)
    setSubmitting(false)
  }

  return (
    <div className="login-page">
      <NetworkBackground />
      <div className="login-content">
        <div className="login-brand-side">
          <div className="login-brand-row">
            <BrandMark className="login-brand-mark" />
            <span className="login-brand-word">Vertex</span>
          </div>
          <div className="login-eyebrow">Regression Studio</div>
          <h1 className="login-headline">
            Every node,
            <br />
            <span>tracked.</span>
          </h1>
        </div>

        <div className="login-card">
          <h2>Log in</h2>
          <form onSubmit={handleSubmit}>
            <label>Username</label>
            <input className="ctrl" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} />

            <label>Password</label>
            <div className="login-password-field">
              <input
                className="ctrl"
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="login-password-toggle"
                onClick={() => setShowPassword((v) => !v)}
                aria-label={showPassword ? 'Hide password' : 'Show password'}
              >
                {showPassword ? <EyeOffIcon /> : <EyeIcon />}
              </button>
            </div>

            {error && <p className="login-error">{error}</p>}

            <button className="btn primary login-submit" disabled={submitting || !username || !password}>
              {submitting ? 'Signing in…' : 'Log in'}
            </button>
          </form>
        </div>
      </div>
    </div>
  )
}
