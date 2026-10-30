'use client'

import { ArrowLeft, SearchX, TriangleAlert } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { ApiError, AppPaths, type ConversationListItemView } from '@platform/api-client'
import { HttpStatusCodes } from '@platform/core/errors'

import { errorCodeOf } from '../../lib/error-message'
import { initialsOf } from '../../lib/inbox/customer-label'
import { useCustomerName } from '../../lib/inbox/use-customer-name'
import { useChannelDirectory, useConversation } from '../../lib/inbox/use-inbox-data'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

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
  const channels = useChannelDirectory(storeId)

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

  const { customer, channelType } = conversation.data
  const channelName =
    channels.data?.find(channel => channel.pluginId === channelType)?.pluginName ?? channelType
  return <LoadedHeader customer={customer} channelName={channelName} backLink={backLink} />
}

function LoadedHeader({
  customer,
  channelName,
  backLink
}: {
  customer: ConversationListItemView['customer']
  channelName: string
  backLink: ReactElement
}): ReactElement {
  const { label, name } = useCustomerName(customer, channelName)
  return (
    <header className="flex items-center gap-3 border-b p-3">
      {backLink}
      <CustomerAvatar avatarUrl={customer.avatarUrl} initials={initialsOf(label)} />
      <div className="flex min-w-0 flex-col">
        <h1 className="truncate text-sm font-semibold">{name}</h1>
        <p className="text-muted-foreground truncate text-xs">{channelName}</p>
      </div>
    </header>
  )
}
