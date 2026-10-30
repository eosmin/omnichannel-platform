import type { ComponentProps, ReactElement } from 'react'

import { cn } from '../../lib/utils'

export function Textarea({ className, ...props }: ComponentProps<'textarea'>): ReactElement {
  return (
    <textarea
      className={cn(
        'border-input placeholder:text-muted-foreground min-h-16 w-full rounded-md border bg-transparent px-3 py-2 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:border-destructive aria-invalid:ring-destructive/20',
        className
      )}
      {...props}
    />
  )
}
