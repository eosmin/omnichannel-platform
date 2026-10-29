import type { LucideIcon } from 'lucide-react'
import type { ReactElement, ReactNode } from 'react'

// The frame of the screens that only say something and offer one way out: no access, not found,
// error
export function StatusScreen({
  icon: Icon,
  title,
  body,
  children
}: {
  icon: LucideIcon
  title: string
  body: string
  children?: ReactNode
}): ReactElement {
  return (
    <main className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-4 text-center">
      <Icon aria-hidden className="text-muted-foreground size-10" />
      <h1 className="text-2xl font-semibold">{title}</h1>
      <p className="text-muted-foreground">{body}</p>
      {children}
    </main>
  )
}
