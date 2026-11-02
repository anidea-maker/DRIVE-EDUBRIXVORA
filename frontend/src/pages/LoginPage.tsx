import { useState, type FormEvent } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/drive/BrandLogo'
import { AuthShell } from '@/components/auth/AuthShell'
import { GoogleLogo } from '@/components/auth/GoogleLogo'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import { startGoogleAuth } from '@/lib/google-auth'
import { setAuthSession, type AuthUser } from '@/lib/auth'

type AuthResponse = { accessToken: string; refreshToken: string; user: AuthUser }

export function LoginPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const nextPath = searchParams.get('next')
  const sessionEnded = searchParams.get('reason') === 'session'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [googleLoading, setGoogleLoading] = useState(false)

  async function continueWithGoogle() {
    setGoogleLoading(true)
    setError('')
    try {
      await startGoogleAuth()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google login failed')
      setGoogleLoading(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch<AuthResponse>('/auth/login', { method: 'POST', skipAuth: true, body: JSON.stringify({ email, password }) })
      setAuthSession(data.accessToken, data.refreshToken, data.user)
      navigate(nextPath && nextPath.startsWith('/') ? nextPath : '/all-files', { replace: true })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed')
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthShell>
      <div className="mb-8 flex items-center gap-3 lg:hidden">
        <BrandLogo className="h-10 w-10 brand-mark" />
        <span className="text-lg font-extrabold tracking-tight">9Drive</span>
      </div>

      <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">Welcome back</h1>
      <p className="mt-1.5 text-sm text-slate-500">Sign in to your storage gateway.</p>
      {sessionEnded ? (
        <p role="status" className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs font-semibold text-amber-800 dark:border-amber-500/30">
          Your session ended. Sign in again to continue.
        </p>
      ) : null}

      <form onSubmit={submit} className="mt-7 grid gap-4">
        <label className="grid gap-1.5 text-[13px] font-semibold text-slate-600">
          Email
          <Input type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="grid gap-1.5 text-[13px] font-semibold text-slate-600">
          Password
          <Input type="password" autoComplete="current-password" placeholder="••••••••" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error ? <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/30">{error}</p> : null}
        <Button className="mt-1 h-11 w-full" disabled={loading}>{loading ? 'Signing in...' : 'Sign in'}</Button>
      </form>

      <div className="my-6 flex items-center gap-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" />
      </div>

      <Button variant="outline" className="h-11 w-full" disabled={googleLoading} onClick={continueWithGoogle}>
        <GoogleLogo />{googleLoading ? 'Redirecting...' : 'Continue with Google'}
      </Button>

      <p className="mt-7 text-center text-sm text-slate-500">
        No account? <Link className="font-bold text-[var(--accent)] hover:underline" to="/register">Create one</Link>
      </p>
    </AuthShell>
  )
}
