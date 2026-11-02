'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { Permissions } from '@platform/core/auth'
import { ChannelConnectionStatus } from '@platform/core/domain'

import { useChannelDirectory } from '../../lib/inbox/use-inbox-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'

// The way out of an empty inbox when nothing is connected (TDD_09 §18): the page that connects a
// channel. Offered only to who may open it. Loaded on its own (lazy-dialogs): only an empty inbox
// draws it, and the inbox has a script budget.
export function ConnectChannelLink(): ReactElement | null {
  const t = useTranslations('inbox.empty')
  const { storeId, can } = useStore()
  // The same cached read the inbox filters use. A directory that could not be read says nothing about
  // what is connected, so only a successful, empty-of-live-accounts answer offers the link.
  const directory = useChannelDirectory(storeId)
  const hasNone =
    directory.isSuccess &&
    directory.data.every(channel => channel.status === String(ChannelConnectionStatus.DISCONNECTED))
  if (!hasNone || !can(Permissions.SETTINGS_VIEW)) return null
  return (
    <Button asChild variant="outline" size="sm">
      <Link href={AppPaths.store.settings(storeId, StoreSettingsSections.CHANNELS)}>
        {t('connectChannel')}
      </Link>
    </Button>
  )
}
