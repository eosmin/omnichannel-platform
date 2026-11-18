import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ComponentProps, ReactElement } from 'react'

import { useCloseOnBack } from '../../lib/use-close-on-back'
import { useFocusReturn } from '../../lib/use-focus-return'
import { cn } from '../../lib/utils'

// Controlled (`open`), because that is what the Back listener reads. Closes on the browser's Back, so it is never left open over a page it does not belong to
export function Dialog({
  open,
  onOpenChange,
  ...props
}: ComponentProps<typeof DialogPrimitive.Root>): ReactElement {
  useCloseOnBack(open === true, onOpenChange)
  return <DialogPrimitive.Root open={open} onOpenChange={onOpenChange} {...props} />
}
export const DialogTrigger = DialogPrimitive.Trigger
export const DialogClose = DialogPrimitive.Close

export function DialogContent(props: ComponentProps<typeof DialogPrimitive.Content>): ReactElement {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0 fixed inset-0 z-50 bg-black/50" />
      <DialogContentBody {...props} />
    </DialogPrimitive.Portal>
  )
}

// Apart from the content, because the focus to give back is read while this renders: it must render once
// per opening, and `DialogContent` renders also while the dialog is closed (the palette stays mounted)
function DialogContentBody({
  className,
  onOpenAutoFocus,
  onCloseAutoFocus,
  ...props
}: ComponentProps<typeof DialogPrimitive.Content>): ReactElement {
  const focus = useFocusReturn({ onOpenAutoFocus, onCloseAutoFocus })
  return (
    <DialogPrimitive.Content
      className={cn(
        'bg-background data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 fixed top-1/2 left-1/2 z-50 grid max-h-[calc(100dvh-2rem)] w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 grid-cols-1 gap-4 overflow-y-auto rounded-lg border p-6 wrap-anywhere shadow-lg *:min-w-0 sm:max-w-lg [&_table]:wrap-normal',
        className
      )}
      {...props}
      onOpenAutoFocus={focus.onOpenAutoFocus}
      onCloseAutoFocus={focus.onCloseAutoFocus}
    />
  )
}

export function DialogHeader({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return <div className={cn('flex flex-col gap-2 text-left', className)} {...props} />
}

// The classes of the row of buttons at the bottom of a long dialog: it stays at the foot of the visible dialog while the content
// scrolls, so the actions are never a scroll away (N-BR1-64), and is used by the long dialogs that write their own row. It cancels the padding of the content so it reaches the edges.
export const stickyDialogActionsClass =
  'bg-background sticky bottom-0 z-10 -mx-6 -mb-6 border-t px-6 pt-3 pb-6'

export function DialogFooter({ className, ...props }: ComponentProps<'div'>): ReactElement {
  return (
    <div
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

export function DialogTitle({
  className,
  ...props
}: ComponentProps<typeof DialogPrimitive.Title>): ReactElement {
  return <DialogPrimitive.Title className={cn('text-lg font-semibold', className)} {...props} />
}

export function DialogDescription({
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
