'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useMemo } from 'react'

import type {
  ChannelConnectionView,
  PluginCatalogEntryView
} from '../../lib/settings/channels-requests'
import { useUpdateToken } from '../../lib/settings/use-channels'
import { toast } from '../../lib/toast'
import { useStore } from '../providers/store-context'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

import { ConnectForm } from './connect-dialog'

// Replaces the token of a connection that exists, in its own card. Only the secret fields are asked: the
// api checks that the new token is of the account the connection already has, and then the connection, its
// name and its conversations stay as they were.
export function UpdateTokenDialog({
  connection,
  plugin,
  onClose
}: {
  connection: ChannelConnectionView
  plugin: PluginCatalogEntryView
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.channels.updateToken')
  const { storeId } = useStore()
  const update = useUpdateToken(storeId, connection.id)
  const fields = useMemo(
    () => (plugin.channel?.connectFields ?? []).filter(field => field.secret),
    [plugin]
  )
  // The request is not abandoned half way: its answer (the toast, the error) needs this dialog open
  return (
    <Dialog open onOpenChange={open => (open || update.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name: connection.displayName })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <ConnectForm
          fields={fields}
          callbackUrl={null}
          connect={update}
          texts={{ submit: t('submit'), pending: t('submitting') }}
          onDone={updated => {
            toast.success(t('done', { name: updated.displayName }))
            onClose()
          }}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}
