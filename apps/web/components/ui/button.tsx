import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { Slot } from 'radix-ui'
import type { ComponentProps, ReactElement } from 'react'

import { cn } from '../../lib/utils'

import { AnnounceBusy } from './announce-busy'

export const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 pointer-coarse:min-h-10 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/90',
        destructive: 'bg-destructive text-white hover:bg-destructive/90',
        outline: 'border bg-background hover:bg-accent hover:text-accent-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        ghost: 'hover:bg-accent hover:text-accent-foreground'
      },
      size: {
        default: 'h-9 px-4 py-2',
        sm: 'h-8 gap-1.5 px-3',
        lg: 'h-10 px-6',
        icon: 'size-9 pointer-coarse:min-w-10'
      }
    },
    defaultVariants: {
      variant: 'default',
      size: 'default'
    }
  }
)

export function Button({
  className,
  variant,
  size,
  asChild = false,
  type = 'button',
  busy = false,
  children,
  ...props
}: ComponentProps<'button'> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
    // The action waits for the server: the button is off, and after 400 ms a spinner takes the place of the
    // label (an answer that comes sooner never flashes one; the delay is in the CSS, `busy-spinner`). The
    // spinner is laid over the button, never beside the label, so the button keeps its size
    busy?: boolean
  }): ReactElement {
  const Comp = asChild ? Slot.Root : 'button'
  // A button is type="button" unless told otherwise, so that it never submits a form by accident
  const typeProps = asChild ? {} : { type }
  // `busy` is for a plain button: it turns the button off while it waits (a button that is a link, `asChild`,
  // has no such state)
  const isBusy = busy && !asChild
  return (
    <Comp
      className={cn(buttonVariants({ variant, size, className }))}
      {...typeProps}
      {...props}
      {...(isBusy ? { disabled: true, 'aria-busy': true } : {})}
    >
      {isBusy ? (
        <>
          <span aria-hidden className="busy-spinner">
            <Loader2 className="animate-spin" />
          </span>
          <span className="busy-label">{children}</span>
          <AnnounceBusy />
        </>
      ) : (
        // One child, as it came: `Slot` (asChild) accepts exactly one element and throws on a list
        children
      )}
    </Comp>
  )
}
