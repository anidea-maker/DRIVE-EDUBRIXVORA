import type { ReactNode } from 'react'
import { ShieldCheck, Cloud, Gauge } from 'lucide-react'
import { BrandLogo } from '@/components/drive/BrandLogo'

/**
 * The frame both auth screens sit in.
 *
 * Login used to be a single card floating on a grey page - fine, but it is the
 * first thing anyone sees. This is a two-panel layout: the form on paper, and a
 * dark stage on the left that states what the product does. Below `lg` the stage
 * is dropped rather than stacked, because a tall marketing block above a login
 * form pushes the form off the first screen.
 */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="auth-shell bg-[var(--bg-gradient)]">
      <aside className="auth-aside">
        <div className="auth-grid-lines" aria-hidden="true" />
        <div className="relative flex items-center gap-3">
          <BrandLogo className="h-10 w-10 brand-mark" />
          <span className="text-lg font-extrabold tracking-tight">9Drive</span>
          <span className="auth-chip ml-auto">
            <ShieldCheck className="h-3.5 w-3.5" /> Encrypted tokens
          </span>
        </div>

        <div className="relative max-w-md">
          <h2 className="text-[2.1rem] font-extrabold leading-[1.15] tracking-tight">
            Every bucket, one workspace.
          </h2>
          <p className="auth-muted mt-4 text-[15px] leading-relaxed">
            Google Drive, Backblaze B2, IDrive E2, Dbrij and any S3-compatible cloud behind a single drive -
            with quotas, sharing and activity in one place.
          </p>
          <ul className="mt-8 grid gap-3 text-sm">
            <li className="flex items-start gap-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/10"><Cloud className="h-4 w-4" /></span>
              <span><b className="font-bold">Bring your own storage.</b> {''}
                <span className="auth-muted">Connect a bucket with environment variables - the secrets never reach the browser.</span>
              </span>
            </li>
            <li className="flex items-start gap-3">
              <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/10"><Gauge className="h-4 w-4" /></span>
              <span><b className="font-bold">Know where the space went.</b> {''}
                <span className="auth-muted">Per-account quotas, usage and free space, refreshed on every sync.</span>
              </span>
            </li>
          </ul>
        </div>

        <p className="auth-muted relative text-xs">
          Drive credentials are encrypted at rest with AES-256-GCM.
        </p>
      </aside>

      <div className="flex items-center justify-center px-5 py-10 sm:px-8">
        <div className="w-full max-w-[26rem]">{children}</div>
      </div>
    </main>
  )
}
