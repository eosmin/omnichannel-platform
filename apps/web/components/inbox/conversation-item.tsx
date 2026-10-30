'use client'

import Link from 'next/link'
import { useLocale, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths, type ConversationListItemView } from '@platform/api-client'
import { ConversationStatus, ConversationStatusColors } from '@platform/core/domain'

import { initialsOf } from '../../lib/inbox/customer-label'
import { previewOf } from '../../lib/inbox/preview'
import { relativeTime } from '../../lib/inbox/relative-time'
import { useCustomerName } from '../../lib/inbox/use-customer-name'
import { cn } from '../../lib/utils'

import { CustomerAvatar } from './customer-avatar'

export const CONVERSATION_ROW_HEIGHT_PX = 84

const isStatus = (value: string): value is ConversationStatus =>
  Object.values<string>(ConversationStatus).includes(value)

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

  const { label, name } = useCustomerName(item.customer, channelName)
  const preview = previewOf(item.lastMessage)
  const body = previewText(preview)

  function previewText(value: ReturnType<typeof previewOf>): string {
    if (value.kind === 'empty') return t('noMessages')
    const text = value.kind === 'text' ? value.text : t(`messageType.${value.type}`)
    if (value.kind === 'text' && value.isNote) return t('notePrefix', { text })
    return value.byAgent ? t('youPrefix', { text }) : text
  }

  const when =
    item.lastMessageAt === null ? null : relativeTime(new Date(item.lastMessageAt), now, locale)
  const status = isStatus(item.status) ? item.status : null
  const isUnread = item.unreadCount > 0

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
          <span className={cn('truncate text-sm', isUnread ? 'font-semibold' : 'font-medium')}>
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
          <span
            className={cn(
              'truncate text-sm',
              isUnread ? 'text-foreground' : 'text-muted-foreground'
            )}
          >
            {body}
          </span>
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
        </span>
      </span>
    </Link>
  )
}
