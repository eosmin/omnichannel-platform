'use client'

import { Clock } from 'lucide-react'
import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths, type ConversationListItemView } from '@platform/api-client'
import { ConversationStatusColors } from '@platform/core/domain'

import { useDraftPreview } from '../../lib/inbox/composer-draft-index'
import { conversationStatusOf } from '../../lib/inbox/conversation-status'
import { initialsOf } from '../../lib/inbox/customer-label'
import { previewOf } from '../../lib/inbox/preview'
import { relativeTime } from '../../lib/inbox/relative-time'
import { useCustomerName } from '../../lib/inbox/use-customer-name'
import { useProfile } from '../../lib/use-profile'
import { cn } from '../../lib/utils'

import { CustomerAvatar } from './customer-avatar'
import { TagChips } from './tag-chips'

export const CONVERSATION_ROW_HEIGHT_PX = 84

export function ConversationItem({
  storeId,
  item,
  channelName,
  isSelected,
  search,
  now
}: {
  storeId: string
  item: ConversationListItemView
  channelName: string
  isSelected: boolean
  // The filters in the address, kept when a conversation opens so that the list does not change
  search: string
  now: Date
}): ReactElement {
  const t = useTranslations('inbox')
  const tStatus = useTranslations('conversations.status')
  const locale = useLocale()

  const { label, name } = useCustomerName(item.customer, item.anonymousCustomers)
  const preview = previewOf(item.lastMessage)
  const body = previewText(preview)

  function previewText(value: ReturnType<typeof previewOf>): string {
    if (value.kind === 'empty') return t('noMessages')
    const text = value.kind === 'text' ? value.text : t(`messageType.${value.type}`)
    if (value.kind === 'text' && value.isNote) return t('notePrefix', { text })
    return value.byAgent ? t('youPrefix', { text }) : text
  }

  // The unsent text of this conversation, kept in this tab by the composer: it takes the place of the preview,
  // but only in the rows of the conversations the agent is NOT looking at. In the open one the text is in the box,
  // in front of them: showing it twice is noise. It shows when they move to another conversation or leave the thread.
  const userId = useProfile().data?.id
  const draft = useDraftPreview(
    userId === undefined || isSelected ? null : { userId, storeId, conversationId: item.id }
  )

  const when =
    item.lastMessageAt === null ? null : relativeTime(new Date(item.lastMessageAt), now, locale)
  const status = conversationStatusOf(item.status)
  const isUnread = item.unreadCount > 0
  // A snooze that ended asks for a look until someone opens the conversation: it weighs like an unread one
  const attention = item.attention
  const asksAttention = attention !== null

  return (
    <Link
      style={{ minHeight: CONVERSATION_ROW_HEIGHT_PX }}
      href={`${AppPaths.store.conversation(storeId, item.id)}${search}`}
      aria-current={isSelected ? 'page' : undefined}
      className={cn(
        'focus-visible:ring-ring flex items-start gap-3 border-b px-3 py-2 outline-none focus-visible:ring-2 focus-visible:ring-inset',
        isSelected ? 'bg-accent' : 'hover:bg-accent/50'
      )}
    >
      <CustomerAvatar avatarUrl={item.customer.avatarUrl} initials={initialsOf(label)} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline justify-between gap-2">
          <span
            className={cn(
              'truncate text-sm',
              isUnread || asksAttention ? 'font-semibold' : 'font-medium'
            )}
          >
            {name}
          </span>
          {when === null ? null : (
            <time
              dateTime={item.lastMessageAt ?? undefined}
              className="text-muted-foreground shrink-0 text-xs"
            >
              {when}
            </time>
          )}
        </span>
        <span className="flex items-center justify-between gap-2">
          {draft === null ? (
            <span
              className={cn(
                'min-w-0 flex-1 truncate text-sm',
                isUnread || asksAttention ? 'text-foreground' : 'text-muted-foreground'
              )}
            >
              {body}
            </span>
          ) : (
            // Text typed by this person and not sent: another colour and weight, and said to a screen reader
            <span className="text-primary min-w-0 flex-1 truncate text-sm font-medium">
              <span className="sr-only">{t('draftUnsent')}. </span>
              {t(draft.isNote ? 'draftNote' : 'draft', { text: draft.text })}
            </span>
          )}
          {attention === null ? null : (
            // The reminder is text of an agent: drawn as text (React escapes it). It sits on the line of the
            // preview, which gives way to it, so that the channel and the status below keep their room
            <span
              title={
                attention.note === null || attention.note === ''
                  ? t('woke')
                  : t('wokeNote', { note: attention.note })
              }
              className="bg-primary/10 text-primary flex max-w-[45%] shrink-0 items-center gap-1 rounded px-1.5 text-xs font-medium"
            >
              <Clock aria-hidden className="size-3 shrink-0" />
              <span className="truncate">
                {attention.note === null || attention.note === ''
                  ? t('woke')
                  : t('wokeNote', { note: attention.note })}
              </span>
            </span>
          )}
          {isUnread ? (
            <span className="bg-primary text-primary-foreground min-w-5 shrink-0 rounded-full px-1.5 text-center text-xs">
              <span aria-hidden>{item.unreadCount}</span>
              <span className="sr-only">{t('unreadCount', { count: item.unreadCount })}</span>
            </span>
          ) : null}
        </span>
        <span className="text-muted-foreground flex items-center gap-2 text-xs">
          <span className="truncate">{channelName}</span>
          {status === null ? null : (
            <span className={cn('rounded px-1.5', ConversationStatusColors[status])}>
              {tStatus(status)}
            </span>
          )}
          <TagChips tags={item.tags} />
        </span>
      </span>
    </Link>
  )
}
