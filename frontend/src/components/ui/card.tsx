import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * A surface: solid, one hairline border, generous radius. Elevation is only
 * allowed to appear on hover - twenty cards each casting a shadow is what made
 * the old layout look busy.
 */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        'card rounded-[var(--radius-surface)] border border-[var(--border)] bg-[var(--surface)] shadow-[var(--shadow-surface)]',
        className,
      )}
      {...props}
    />
  )
}
