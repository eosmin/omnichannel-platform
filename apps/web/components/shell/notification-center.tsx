'use client'

import { Bell } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { badgeLabel } from '../../lib/notifications/notification-text'
import { useUnreadCount } from '../../lib/notifications/use-notification-data'
import { useMountedOnce } from '../../lib/use-mounted-once'
import { Button } from '../ui/button'
import { Sheet, SheetContent, SheetTrigger } from '../ui/sheet'

const NotificationPanel = dynamic(
  () => import('./notification-panel').then(module => module.NotificationPanel),
  { ssr: false }
)

// The bell of the top bar and the panel it opens (TDD_06 §8): the member's notifications of this
// store, a badge with what is unread, and a click that marks one read and goes to where it points.
export function NotificationCenter({ storeId }: { storeId: string }): ReactElement {
  const t = useTranslations('shell.notifications')
  const [open, setOpen] = useState(false)
  const panelMounted = useMountedOnce(open)
  const unread = useUnreadCount(storeId)
  const count = unread.data ?? 0
  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={count > 0 ? t('openWithCount', { count }) : t('open')}
        >
          <Bell aria-hidden />
          {count > 0 && (
            <span
              aria-hidden
              className="bg-primary text-primary-foreground absolute -top-0.5 -right-0.5 min-w-4 rounded-full px-1 text-[10px] leading-4 font-medium"
            >
              {badgeLabel(count)}
            </span>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent className="md:w-[28rem]">
        {panelMounted ? (
          <NotificationPanel
            storeId={storeId}
            open={open}
            unreadCount={count}
            onNavigate={() => setOpen(false)}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  )
}
