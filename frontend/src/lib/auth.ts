export type AuthUser = {
  id: string
  name: string
  email: string
  status?: string
}

const ACCESS_TOKEN_KEY = '9drive.accessToken'
const REFRESH_TOKEN_KEY = '9drive.refreshToken'
const USER_KEY = '9drive.user'

export function getAccessToken() {
  return localStorage.getItem(ACCESS_TOKEN_KEY)
}

export function getRefreshToken() {
  return localStorage.getItem(REFRESH_TOKEN_KEY)
}

/**
 * A usable session needs at least one token: an access token to call with, or a
 * refresh token that `apiFetch` can exchange for one.
 */
export function hasAuthSession() {
  return Boolean(getAccessToken() || getRefreshToken())
}

export function getStoredUser(): AuthUser | null {
  const raw = localStorage.getItem(USER_KEY)
  return raw ? JSON.parse(raw) as AuthUser : null
}

export function setAuthSession(accessToken: string, refreshToken: string, user: AuthUser) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
  localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken)
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function updateStoredUser(user: AuthUser) {
  localStorage.setItem(USER_KEY, JSON.stringify(user))
}

export function setAccessToken(accessToken: string) {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken)
}

/** Removes every trace of the session from local storage. */
export function clearAuthSession() {
  try {
    localStorage.removeItem(ACCESS_TOKEN_KEY)
    localStorage.removeItem(REFRESH_TOKEN_KEY)
    localStorage.removeItem(USER_KEY)
  } catch {
    // private mode / storage disabled: nothing to clear
  }
}
