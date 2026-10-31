'use client'

import { ArrowLeft, SearchX, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef } from 'react'

import { ApiError, AppPaths, type ConversationListItemView } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

import { errorCodeOf } from '../../lib/error-message'
import { initialsOf } from '../../lib/inbox/customer-label'
import { isListHiddenByConversation } from '../../lib/inbox/layout'
import { useCustomerName } from '../../lib/inbox/use-customer-name'
import { useChannelName, useConversation } from '../../lib/inbox/use-inbox-data'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { ConversationActions } from './conversation-actions'
import { CustomerAvatar } from './customer-avatar'
import { InboxState } from './inbox-state'

// The top of the conversation: who it is with and through which channel. The thread and the composer
// go under it (Step 3.2, PR B2 and B3).
export function ConversationHeader({ conversationId }: { conversationId: string }): ReactElement {
  const t = useTranslations('inbox')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const { search } = useInboxFilters()
  const conversation = useConversation(storeId, conversationId)

  const backLink = (
    <Link
      href={`${AppPaths.store.inbox(storeId)}${search}`}
      aria-label={t('backToList')}
      className="hover:bg-accent focus-visible:ring-ring flex size-9 shrink-0 items-center justify-center rounded-md outline-none focus-visible:ring-2 md:hidden"
    >
      <ArrowLeft aria-hidden className="size-4" />
    </Link>
  )

  // A failed refetch keeps the header that is loaded, as the list does
  if (conversation.isError && conversation.data === undefined) {
    const isMissing =
      conversation.error instanceof ApiError &&
      conversation.error.status === HttpStatusCodes.NOT_FOUND
    return (
      <>
        <div className="border-b p-3 md:hidden">{backLink}</div>
        {isMissing ? (
          <InboxState
            icon={SearchX}
            heading="h1"
            title={t('notFound.title')}
            body={t('notFound.body')}
          />
        ) : (
          <InboxState
            icon={TriangleAlert}
            heading="h1"
            title={t('error.title')}
            body={tAll(`errors.${errorCodeOf(conversation.error)}`)}
            isAlert
          >
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void conversation.refetch()}
            >
              {tAll('common.tryAgain')}
            </Button>
          </InboxState>
        )}
      </>
    )
  }
  if (conversation.data === undefined) {
    return (
      <>
        <div className="border-b p-3 md:hidden">{backLink}</div>
        <p role="status" className="text-muted-foreground p-6 text-sm">
          {tAll('common.loading')}
        </p>
      </>
    )
  }

  const { customer, channelType, status } = conversation.data
  return (
    <LoadedHeader
      conversationId={conversationId}
      customer={customer}
      channelType={channelType}
      status={status}
      backLink={backLink}
    />
  )
}

function LoadedHeader({
  conversationId,
  customer,
  channelType,
  status,
  backLink
}: {
  conversationId: string
  customer: ConversationListItemView['customer']
  channelType: string
  status: string
  backLink: ReactElement
}): ReactElement {
  const { storeId } = useStore()
  const channelName = useChannelName(storeId, channelType)
  const { label, name } = useCustomerName(customer, channelName)
  // On a phone the list the agent tapped is gone and the focus with it: it goes to the heading of the
  // conversation. On a desktop the list stays and keeps the focus.
  const heading = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (isListHiddenByConversation()) heading.current?.focus()
  }, [])
  return (
    <header className="flex items-center gap-3 border-b p-3">
      {backLink}
      <CustomerAvatar avatarUrl={customer.avatarUrl} initials={initialsOf(label)} />
      <div className="flex min-w-0 flex-col">
        <h1 ref={heading} tabIndex={-1} className="truncate text-sm font-semibold outline-none">
          {name}
        </h1>
        <p className="text-muted-foreground truncate text-xs">{channelName}</p>
      </div>
      <div className="ml-auto shrink-0">
        <ConversationActions conversationId={conversationId} status={status} />
      </div>
    </header>
  )
}
