import { env } from '../../config/env.js'

/**
 * One role vocabulary for the whole application.
 *
 * The role is read from the database on every protected request; the browser
 * never supplies it. `SUPER_ADMIN_EMAILS` is an operational bootstrap, not a
 * second role system: an email on that list simply resolves to `super_admin`
 * even before the row is updated.
 */
export const USER_ROLES = ['super_admin', 'admin', 'student', 'visitor'] as const

export type UserRole = (typeof USER_ROLES)[number]

/** Least-privileged role assigned to new registrations. Promotion is explicit. */
export const DEFAULT_USER_ROLE: UserRole = 'visitor'

export type RoleSubject = {
  id: string
  email: string
  role: string
  status?: string | null
}

export function isUserRole(value: string): value is UserRole {
  return (USER_ROLES as readonly string[]).includes(value)
}

/** The effective role of a database user, with the deployment bootstrap applied. */
export function effectiveRole(user: Pick<RoleSubject, 'email' | 'role'>): UserRole {
  if (env.SUPER_ADMIN_EMAILS.includes(user.email.trim().toLowerCase())) return 'super_admin'
  return isUserRole(user.role) ? user.role : 'visitor'
}

/** admin and super_admin may manage resources; students/visitors may not. */
export function canManageResources(role: UserRole) {
  return role === 'admin' || role === 'super_admin'
}

export function canManageAdministrators(role: UserRole) {
  return role === 'super_admin'
}

/** A deactivated account must not retain admin powers from a stale JWT. */
export function isActive(user: Pick<RoleSubject, 'status'>) {
  return user.status === null || user.status === undefined || user.status === 'active'
}
