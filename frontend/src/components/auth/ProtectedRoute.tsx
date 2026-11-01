import { Navigate, Outlet, useLocation } from 'react-router-dom'
import { hasAuthSession } from '@/lib/auth'

/**
 * Guards the app shell.
 *
 * This used to check only the access token, so an expired/cleared token still
 * rendered the whole UI (cached user from local storage) and every action failed
 * with "Bearer token required." Instead, send the user to /login and remember
 * where they were going.
 */
export function ProtectedRoute() {
  const location = useLocation()

  if (!hasAuthSession()) {
    const next = `${location.pathname}${location.search}`
    return <Navigate to={next === '/' ? '/login' : `/login?reason=session&next=${encodeURIComponent(next)}`} replace />
  }

  return <Outlet />
}
