import { Tabs as TabsPrimitive } from 'radix-ui'
import type { ComponentProps, ReactElement } from 'react'

import { cn } from '../../lib/utils'

export const Tabs = TabsPrimitive.Root

export function TabsList({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.List>): ReactElement {
  return (
    <TabsPrimitive.List
      className={cn('bg-muted inline-flex h-9 items-center rounded-lg p-[3px]', className)}
      {...props}
    />
  )
}

export function TabsTrigger({
  className,
  ...props
}: ComponentProps<typeof TabsPrimitive.Trigger>): ReactElement {
  return (
    <TabsPrimitive.Trigger
      // The tabs here switch a mode of one field, not a panel: no content id exists to point at
      aria-controls={undefined}
      className={cn(
        'text-muted-foreground data-[state=active]:bg-background data-[state=active]:text-foreground focus-visible:ring-ring inline-flex h-full items-center justify-center rounded-md px-3 text-sm font-medium whitespace-nowrap outline-none focus-visible:ring-2 disabled:pointer-events-none disabled:opacity-50',
        className
      )}
      {...props}
    />
  )
}
