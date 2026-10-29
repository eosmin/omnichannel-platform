import { Label as LabelPrimitive } from 'radix-ui'
import type { ComponentProps, ReactElement } from 'react'

import { cn } from '../../lib/utils'

export function Label({
  className,
  ...props
}: ComponentProps<typeof LabelPrimitive.Root>): ReactElement {
  return (
    <LabelPrimitive.Root
      className={cn(
        'flex items-center gap-2 text-sm leading-none font-medium select-none',
        className
      )}
      {...props}
    />
  )
}
