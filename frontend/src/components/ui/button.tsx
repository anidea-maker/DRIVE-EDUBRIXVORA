import * as React from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '@/lib/utils'

/**
 * Buttons: one solid accent for the primary action, everything else is a quiet
 * surface. The previous primary was a gradient with a coloured glow, which put
 * three primaries on a screen in competition; a single accent keeps hierarchy
 * legible.
 */
const buttonVariants = cva(
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-xl text-sm font-semibold transition-all duration-150 outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:pointer-events-none disabled:opacity-50 [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default:
          'bg-[var(--accent)] text-white shadow-[0_1px_2px_rgba(16,24,40,0.08),0_8px_20px_-8px_var(--button-shadow)] hover:bg-[var(--accent-strong)] hover:shadow-[0_1px_2px_rgba(16,24,40,0.1),0_12px_26px_-10px_var(--button-hover-shadow)] focus-visible:ring-[var(--accent)]',
        outline:
          'border border-[var(--border)] bg-[var(--surface)] text-[var(--text-primary)] hover:bg-[var(--surface-inset)] hover:border-[var(--border-strong)] focus-visible:ring-[var(--accent)]',
        ghost:
          'text-[var(--text-secondary)] hover:bg-[var(--slate-100-override)] hover:text-[var(--text-primary)] focus-visible:ring-[var(--accent)]',
        soft:
          'bg-[var(--slate-100-override)] text-[var(--text-primary)] hover:bg-[var(--slate-200-override)] focus-visible:ring-[var(--accent)]',
        danger:
          'border border-transparent text-[var(--danger)] hover:border-[color-mix(in_srgb,var(--danger)_35%,transparent)] hover:bg-[color-mix(in_srgb,var(--danger)_10%,transparent)] focus-visible:ring-[var(--danger)]',
      },
      size: {
        default: 'h-11 px-4 py-2',
        sm: 'h-9 px-3 text-[13px]',
        icon: 'h-10 w-10',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

export function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />
}
