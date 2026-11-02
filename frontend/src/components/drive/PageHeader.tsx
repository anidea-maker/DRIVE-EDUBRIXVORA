import type { ReactNode } from 'react'

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-[20px] font-extrabold leading-tight tracking-tight sm:text-[24px] lg:text-[27px]">{title}</h1>
        {description ? <p className="mt-1 text-[13px] leading-relaxed text-slate-500">{description}</p> : null}
      </div>
      {actions ? (
        <div className="flex flex-wrap gap-2 sm:shrink-0 sm:flex-nowrap sm:justify-end">
          {actions}
        </div>
      ) : null}
    </div>
  )
}
