'use client'

import { Bell } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import type { NotificationView } from '@platform/api-client'
import { NotificationFilters, type NotificationFilter } from '@platform/core/notifications'

import { relativeTime } from '../../lib/inbox/relative-time'
import {
  badgeLabel,
  notificationTextKeys,
  safeActionPath
} from '../../lib/notifications/notification-text'
import {
  useMarkAllRead,
  useMarkRead,
  useNotificationList,
  useUnreadCount
} from '../../lib/notifications/use-notification-data'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from '../ui/sheet'
import { Tabs, TabsList, TabsTrigger } from '../ui/tabs'

const TABS: readonly NotificationFilter[] = [
  NotificationFilters.ALL,
  NotificationFilters.UNREAD,
  NotificationFilters.MENTIONS
]

// The bell of the top bar and the panel it opens (TDD_06 §8): the member's notifications of this
// store, a badge with what is unread, and a click that marks one read and goes to where it points.
export function NotificationCenter({ storeId }: { storeId: string }): ReactElement {
  const t = useTranslations('shell.notifications')
  const [open, setOpen] = useState(false)
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
        <NotificationPanel
          storeId={storeId}
          open={open}
          unreadCount={count}
          onNavigate={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  )
}

function NotificationPanel({
  storeId,
  open,
  unreadCount,
  onNavigate
}: {
  storeId: string
  open: boolean
  unreadCount: number
  onNavigate: () => void
}): ReactElement {
  const t = useTranslations('shell.notifications')
  const [filter, setFilter] = useState<NotificationFilter>(NotificationFilters.ALL)
  const list = useNotificationList(storeId, filter, open)
  const markAll = useMarkAllRead(storeId)
  const items = list.data?.pages.flatMap(page => page.data) ?? []
  return (
    <>
      <SheetHeader>
        <div className="flex items-center justify-between gap-2 pr-8">
          <SheetTitle>{t('title')}</SheetTitle>
          <Button
            variant="ghost"
            size="sm"
            disabled={markAll.isPending || unreadCount === 0}
            onClick={() =>
              markAll.mutate(undefined, { onError: () => toast.error(t('markFailed')) })
            }
          >
            {t('markAllRead')}
          </Button>
        </div>
        <SheetDescription>{t('description')}</SheetDescription>
        <Tabs value={filter} onValueChange={value => setFilter(value as NotificationFilter)}>
          <TabsList aria-label={t('tabs.label')}>
            {TABS.map(tab => (
              <TabsTrigger key={tab} value={tab}>
                {t(`tabs.${tab}`)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </SheetHeader>
      <div className="flex-1 overflow-y-auto">
        {list.isError && items.length === 0 ? (
          <p role="alert" className="text-destructive p-4 text-sm">
            {t('failed')}
          </p>
        ) : items.length === 0 && !list.isPending ? (
          <p className="text-muted-foreground p-4 text-sm">{t(`empty.${filter}`)}</p>
        ) : (
          <ul className="divide-y">
            {items.map(item => (
              <NotificationRow
                key={item.id}
                storeId={storeId}
                item={item}
                onNavigate={onNavigate}
              />
            ))}
          </ul>
        )}
        {list.isError && items.length > 0 && (
          <p role="alert" className="text-destructive px-4 pt-3 text-sm">
            {t('failed')}
          </p>
        )}
        {list.hasNextPage && (
          <div className="p-3">
            <Button
              variant="outline"
              size="sm"
              disabled={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              {t('loadMore')}
            </Button>
          </div>
        )}
      </div>
    </>
  )
}

function NotificationRow({
  storeId,
  item,
  onNavigate
}: {
  storeId: string
  item: NotificationView
  onNavigate: () => void
}): ReactElement {
  const t = useTranslations()
  const tn = useTranslations('shell.notifications')
  const locale = useLocale()
  const router = useRouter()
  const markRead = useMarkRead(storeId, () => toast.error(tn('markFailed')))
  // The key comes from the server: `has` checks it exists before it is used, so the cast to the
  // typed key narrows nothing that was not checked
  type MessageKey = Parameters<typeof t>[0]
  const keys = notificationTextKeys(item.messageKey, key => t.has(key as MessageKey))
  const unread = item.readAt === null
  const target = safeActionPath(item.actionPath)

  function open(): void {
    if (unread) markRead.mutate(item.id)
    if (target !== null) {
      onNavigate()
      router.push(target)
    }
  }

  return (
    <li>
      <button
        type="button"
        onClick={open}
        className="hover:bg-accent focus-visible:ring-ring flex w-full items-start gap-3 p-4 text-left outline-none focus-visible:ring-2"
      >
        <span
          role={unread ? 'img' : undefined}
          aria-label={unread ? tn('unreadDot') : undefined}
          aria-hidden={unread ? undefined : true}
          className={cn('mt-1.5 size-2 shrink-0 rounded-full', unread && 'bg-primary')}
        />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className={cn('text-sm', unread && 'font-semibold')}>
            {t(keys.title as MessageKey, item.params)}
          </span>
          <span className="text-muted-foreground text-sm">
            {t(keys.body as MessageKey, item.params)}
          </span>
          <span className="text-muted-foreground text-xs">
            {relativeTime(new Date(item.createdAt), new Date(), locale)}
          </span>
        </span>
      </button>
    </li>
  )
}
