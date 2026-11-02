'use client'

import { Inbox } from 'lucide-react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { ChannelConnectionStatus } from '@platform/core/domain'

import { useChannelDirectory } from '../../lib/inbox/use-inbox-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

import { InboxState } from './inbox-state'

// The inbox with nothing in it (TDD_09 §18). When no channel is connected it offers the way out: the
// page that connects one, to who may open it. Loaded on its own (lazy-dialogs): it is drawn only by an
// empty inbox, and the inbox has a script budget.
export function EmptyInbox(): ReactElement {
  const t = useTranslations('inbox.empty')
  const { storeId, can } = useStore()
  // The same cached read the inbox filters use. A directory that could not be read says nothing about
  // what is connected, so only a successful answer with no live account offers the link.
  const directory = useChannelDirectory(storeId)
  const hasNone =
    directory.isSuccess &&
    directory.data.every(channel => channel.status === String(ChannelConnectionStatus.DISCONNECTED))
  return (
    <InboxState icon={Inbox} title={t('title')} body={t('body')}>
      {hasNone && can(Permissions.SETTINGS_VIEW) ? (
        <Button asChild variant="outline" size="sm">
          <Link href={AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS)}>
            {t('connectChannel')}
          </Link>
        </Button>
      ) : null}
    </InboxState>
  )
}
