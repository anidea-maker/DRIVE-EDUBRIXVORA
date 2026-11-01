import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { AlertTriangle, CheckCircle, Loader2, XCircle } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { apiFetch } from '@/lib/api'
import { explainConnectFailure, isQuotaOnlyFailure } from '@/lib/google-connect-errors'

/**
 * Landing page for the Google connect popup.
 *
 * It used to say "Connection Failed / Close this window and try again" for every
 * outcome, including the very common case where the account *was* connected and
 * only the quota read failed. Now the backend sends a reason code and this page
 * explains it, with a retry that restarts the flow.
 */
export function GoogleConnectedPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const status = params.get('status') ?? 'success'
  const reason = params.get('reason') ?? ''
  const quotaFailed = isQuotaOnlyFailure(status, params.get('quota'))
  const ok = status === 'success'
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')

  useEffect(() => {
    // Tell the Settings page what happened before closing, so it can refresh and
    // show the same explanation inline.
    window.opener?.postMessage({ type: 'GOOGLE_CONNECTED', status, reason, quota: quotaFailed ? 'failed' : 'ok' }, window.location.origin)

    // Keep the page open when something failed: auto-closing it was how the
    // reason got lost.
    if (!ok) return
    const timer = window.setTimeout(() => {
      if (window.opener) window.close()
      else navigate('/settings')
    }, 800)
    return () => window.clearTimeout(timer)
  }, [navigate, ok, quotaFailed, reason, status])

  async function retry() {
    setRetrying(true)
    setRetryError('')
    try {
      const data = await apiFetch<{ url: string }>('/connected-accounts/google/connect-url')
      window.location.href = data.url
    } catch (error) {
      setRetryError(error instanceof Error ? error.message : 'Could not restart the Google connection.')
      setRetrying(false)
    }
  }

  const Icon = !ok ? XCircle : quotaFailed ? AlertTriangle : CheckCircle
  const iconClass = !ok ? 'text-red-500' : quotaFailed ? 'text-amber-500' : 'text-emerald-500'
  const title = !ok ? 'Connection failed' : quotaFailed ? 'Drive connected - quota unavailable' : 'Google Drive connected'
  const explanation = !ok
    ? explainConnectFailure(reason)
    : quotaFailed
      ? `The account was added successfully, but its storage quota could not be read. ${explainConnectFailure(reason)} Use Sync on the account in Settings once Drive access works.`
      : 'This window will close automatically.'

  return (
    <main className="flex min-h-screen items-center justify-center p-5">
      <Card className="w-full max-w-md p-6 text-center">
        <Icon className={`mx-auto h-10 w-10 ${iconClass}`} />
        <h1 className="mt-4 text-xl font-extrabold">{title}</h1>
        <p className="mt-2 text-sm text-slate-500">{explanation}</p>

        {reason && !ok ? <p className="mt-2 text-[11px] font-mono text-slate-400">reason: {reason}</p> : null}
        {retryError ? <p className="mt-3 rounded-xl bg-red-50 p-2 text-xs font-semibold text-red-700">{retryError}</p> : null}

        {!ok || quotaFailed ? (
          <div className="mt-5 flex justify-center gap-2">
            <Button size="sm" onClick={retry} disabled={retrying}>
              {retrying ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {retrying ? 'Starting...' : ok ? 'Sync later' : 'Retry'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => { if (window.opener) window.close(); else navigate('/settings') }}>
              {ok ? 'Close' : 'Go to Settings'}
            </Button>
          </div>
        ) : null}
      </Card>
    </main>
  )
}
