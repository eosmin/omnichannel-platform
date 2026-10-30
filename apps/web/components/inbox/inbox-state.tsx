import type { LucideIcon } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'

// A list or a panel that has nothing to show says why and, when there is one, offers the way out
// (TDD_09 §18): never a blank area. An error is announced; the rest is just there.
export function InboxState({
  icon: Icon,
  title,
  body,
  isAlert = false,
  heading: Heading = 'h2',
  children
}: {
  icon: LucideIcon
  title: string
  body?: string
  isAlert?: boolean
  // h1 when the state is all a page has, h2 when it sits under other headings
  heading?: 'h1' | 'h2'
  children?: ReactNode
}): ReactElement {
  return (
    <div
      role={isAlert ? 'alert' : undefined}
      className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center"
    >
      <Icon aria-hidden className="text-muted-foreground size-9" />
      <Heading className="text-base font-semibold">{title}</Heading>
      {body === undefined ? null : <p className="text-muted-foreground text-sm">{body}</p>}
      {children}
    </div>
  )
}
