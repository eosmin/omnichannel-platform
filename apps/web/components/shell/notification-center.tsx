'use client'

import { Bell } from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import { badgeLabel } from '../../lib/notifications/notification-text'
import { useUnreadCount } from '../../lib/notifications/use-notification-data'
import { useMountedOnce } from '../../lib/use-mounted-once'
import { Button } from '../ui/button'

// The sheet (a Radix dialog, its focus trap and the panel) is downloaded when the bell is pointed at, focused or
// pressed: the bell itself is a plain button until then, with what Radix gives a trigger of a dialog
const loadSheet = () => import('./notification-sheet')
const NotificationSheet = dynamic(loadSheet, { ssr: false })

// The bell of the top bar and the panel it opens (TDD_06 §8): the member's notifications of this
// store, a badge with what is unread, and a click that marks one read and goes to where it points.
export function NotificationCenter({ storeId }: { storeId: string }): ReactElement {
  const t = useTranslations('shell.notifications')
  const [open, setOpen] = useState(false)
  const sheetMounted = useMountedOnce(open)
  // A download that fails while pointing at the bell is ignored: the press asks again
  const warm = (): void => {
    loadSheet().catch(() => undefined)
  }
  const unread = useUnreadCount(storeId)
  const count = unread.data ?? 0
  return (
    <>
      <Button
        variant="ghost"
        size="icon"
        className="relative"
        aria-label={count > 0 ? t('openWithCount', { count }) : t('open')}
        aria-haspopup="dialog"
        aria-expanded={open}
        data-state={open ? 'open' : 'closed'}
        onPointerEnter={warm}
        onFocus={warm}
        onClick={event => {
          // Some browsers do not focus a button that is pressed: the sheet gives the focus back to this one
          event.currentTarget.focus()
          setOpen(true)
        }}
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
      {sheetMounted ? (
        <NotificationSheet
          storeId={storeId}
          open={open}
          onOpenChange={setOpen}
          unreadCount={count}
        />
      ) : null}
    </>
  )
}
