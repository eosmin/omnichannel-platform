import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ComponentProps, ReactElement } from 'react'

import { cn } from '../../lib/utils'

export const Sheet = DialogPrimitive.Root
export const SheetClose = DialogPrimitive.Close

// A panel that slides over the right side of the page (the customer profile of TDD_09 §6): it takes
// the full width on a phone and about 65% of the screen from `md`. Same Radix dialog as `Dialog`, so
// focus is trapped and Escape closes it.
export function SheetContent({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <DialogPrimitive.Content
        className={cn(
          'bg-background data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:animate-in data-[state=open]:slide-in-from-right fixed inset-y-0 right-0 z-50 flex w-full flex-col border-l shadow-lg md:w-[65vw] md:max-w-5xl',
          className
        )}
        {...props}
      />
    </DialogPrimitive.Portal>
  )
}

export function SheetHeader({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return <div className={cn('flex flex-col gap-1 border-b p-4', className)} {...props} />
}

export function SheetTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>): ReactElement {
  return <DialogPrimitive.Title className={cn('text-lg font-semibold', className)} {...props} />
}

export function SheetDescription({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Description>): ReactElement {
  return (
    <DialogPrimitive.Description
      className={cn('text-muted-foreground text-sm', className)}
      {...props}
    />
  )
}
