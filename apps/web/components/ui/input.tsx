import type { ComponentProps, ReactElement } from 'react'

import { cn } from '../../lib/utils'

export function Input({ className, type, ...props }: ComponentProps<'input'>): ReactElement {
  return (
    <input
      type={type}
      className={cn(
        'border-input placeholder:text-muted-foreground h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    />
  )
}
