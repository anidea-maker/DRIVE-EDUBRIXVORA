import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { BrandLogo } from '@/components/drive/BrandLogo'
import { AuthShell } from '@/components/auth/AuthShell'
import { GoogleLogo } from '@/components/auth/GoogleLogo'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import { startGoogleAuth } from '@/lib/google-auth'
import { setAuthSession, type AuthUser } from '@/lib/auth'

type AuthResponse = { accessToken: string; refreshToken: string; user: AuthUser }

export function RegisterPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
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
      setError(err instanceof Error ? err.message : 'Google register failed')
      setGoogleLoading(false)
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault()
    setLoading(true)
    setError('')
    try {
      const data = await apiFetch<AuthResponse>('/auth/register', { method: 'POST', skipAuth: true, body: JSON.stringify({ name, email, password }) })
      setAuthSession(data.accessToken, data.refreshToken, data.user)
      navigate('/all-files')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Register failed')
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

      <h1 className="text-[26px] font-extrabold leading-tight tracking-tight">Create your account</h1>
      <p className="mt-1.5 text-sm text-slate-500">One workspace for every bucket you own.</p>

      <form onSubmit={submit} className="mt-7 grid gap-4">
        <label className="grid gap-1.5 text-[13px] font-semibold text-slate-600">
          Name
          <Input autoComplete="name" placeholder="Ada Lovelace" value={name} onChange={(e) => setName(e.target.value)} required />
        </label>
        <label className="grid gap-1.5 text-[13px] font-semibold text-slate-600">
          Email
          <Input type="email" autoComplete="email" placeholder="you@company.com" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label className="grid gap-1.5 text-[13px] font-semibold text-slate-600">
          Password
          <Input type="password" autoComplete="new-password" placeholder="At least 8 characters" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required />
        </label>
        {error ? <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-500/30">{error}</p> : null}
        <Button className="mt-1 h-11 w-full" disabled={loading}>{loading ? 'Creating account...' : 'Create account'}</Button>
      </form>

      <div className="my-6 flex items-center gap-3 text-[11px] font-bold uppercase tracking-wider text-slate-400">
        <span className="h-px flex-1 bg-slate-200" />or<span className="h-px flex-1 bg-slate-200" />
      </div>

      <Button variant="outline" className="h-11 w-full" disabled={googleLoading} onClick={continueWithGoogle}>
        <GoogleLogo />{googleLoading ? 'Redirecting...' : 'Continue with Google'}
      </Button>

      <p className="mt-7 text-center text-sm text-slate-500">
        Already registered? <Link className="font-bold text-[var(--accent)] hover:underline" to="/login">Sign in</Link>
      </p>
    </AuthShell>
  )
}
