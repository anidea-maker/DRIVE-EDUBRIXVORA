import { useEffect, useRef, useState } from 'react'
import { NavLink } from 'react-router-dom'
import { LogOut, MoreVertical, Settings } from 'lucide-react'
import { getGravatarUrl } from '@/lib/gravatar'
import { cn } from '@/lib/utils'
import type { AuthUser } from '@/lib/auth'

/**
 * Account menu for the sidebar.
 *
 * Design notes (each one is a bug that made "the three dots do nothing"):
 *  - The whole row is the button. A 24 px icon alone is a tiny target, and the
 *    row was previously plain text with a decorative icon.
 *  - Closing on outside click uses a document listener instead of a full-screen
 *    `fixed` overlay: the sidebar has `backdrop-blur`, which makes it a
 *    containing block, so `position: fixed` inside it does not cover the
 *    viewport and the overlay swallowed clicks in the wrong place.
 *  - The popover is a sibling of the trigger with a high z-index and
 *    `relative` positioning, so nothing in the scrolling nav can paint over it.
 */
export function AccountMenu({
  user,
  onLogout,
  onNavigate,
  className,
}: {
  user: AuthUser | null
  onLogout: () => void
  onNavigate?: () => void
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const [profileImageUrl, setProfileImageUrl] = useState('')
  const [avatarError, setAvatarError] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    setAvatarError(false)
    getGravatarUrl(user?.email, 64)
      .then(setProfileImageUrl)
      .catch(() => setProfileImageUrl(''))
  }, [user?.email])

  useEffect(() => {
    if (!open) return

    function onPointerDown(event: MouseEvent | TouchEvent) {
      const target = event.target as Node | null
      if (target && containerRef.current?.contains(target)) return
      setOpen(false)
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setOpen(false)
        triggerRef.current?.focus()
      }
    }

    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('touchstart', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('touchstart', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [open])

  function close() {
    setOpen(false)
  }

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Account menu"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2.5 rounded-xl border border-transparent px-1.5 py-2 text-left transition-colors',
          'hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500',
          open && 'bg-slate-100',
        )}
      >
        {!profileImageUrl || avatarError ? (
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-indigo-600 text-xs font-bold text-white shadow-sm border border-blue-400/20">
            {(user?.name ?? user?.email ?? 'U').trim().charAt(0).toUpperCase()}
          </div>
        ) : (
          <img
            src={profileImageUrl}
            alt=""
            className="h-8 w-8 rounded-full border border-slate-200 object-cover"
            onError={() => setAvatarError(true)}
          />
        )}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-bold text-slate-900 leading-none">{user?.name ?? 'User'}</p>
          <p className="mt-1 truncate text-xs text-slate-500">{user?.email ?? 'Loading...'}</p>
        </div>
        <MoreVertical className="h-4 w-4 shrink-0 text-slate-400" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label="Account"
          // `bg-white` is forced transparent by the global stylesheet
          // (`div.bg-white:not(button)`), which made the menu open invisibly. Use the
          // themed card surface so it is opaque in both light and dark mode.
          className="absolute left-0 right-0 top-full z-[60] mt-1 overflow-hidden rounded-xl border border-[var(--card-border)] bg-[var(--card-bg)] py-1 shadow-xl backdrop-blur-xl"
        >
          <NavLink
            to="/settings"
            role="menuitem"
            onClick={() => {
              close()
              onNavigate?.()
            }}
            className="flex items-center gap-2 px-3 py-2 text-[13px] font-semibold text-slate-600 hover:bg-slate-100"
          >
            <Settings className="h-4 w-4" /> Settings
          </NavLink>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              close()
              onLogout()
            }}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[13px] font-semibold text-red-600 hover:bg-red-50"
          >
            <LogOut className="h-4 w-4" /> Log out
          </button>
        </div>
      ) : null}
    </div>
  )
}
