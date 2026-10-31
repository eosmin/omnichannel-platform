'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { CustomerLimits } from '@platform/core/domain'

import { handleOwnerOf } from '../../lib/customers/merge-form'
import { useCustomerIdentityEdits } from '../../lib/customers/use-customer-data'
import { useChannelDirectory } from '../../lib/inbox/use-inbox-data'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { MutationError } from './mutation-error'

// Link a handle to the customer (TDD_09 §6): a channel of the store and the handle on it. The api
// normalizes the handle and judges it. When it belongs to another customer, the answer names whose it
// is and the form offers "Merge instead" with that customer.
export function IdentityLinkForm({
  customerId,
  onDone,
  onMergeInstead
}: {
  customerId: string
  onDone: () => void
  // Only for who may merge: without it the form says the handle is taken and stops there
  onMergeInstead?: (ownerId: string) => void
}): ReactElement {
  const t = useTranslations('customers.identity')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const { link } = useCustomerIdentityEdits(storeId, customerId)
  const directory = useChannelDirectory(storeId)
  // One option per channel type: a store can hold two connections of the same plugin
  const channels = [
    ...new Map((directory.data ?? []).map(entry => [entry.pluginId, entry.pluginName])).entries()
  ]
  const [channelType, setChannelType] = useState('')
  const [handle, setHandle] = useState('')
  const selected = channelType === '' ? (channels[0]?.[0] ?? '') : channelType
  const ownerId = handleOwnerOf(link.error)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (selected === '' || handle.trim() === '') return
    link.mutate({ channelType: selected, channelIdentity: handle.trim() }, { onSuccess: onDone })
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <div className="flex flex-col gap-1">
        <Label htmlFor="identity-channel">{t('channel')}</Label>
        <select
          id="identity-channel"
          className={SELECT_CLASS}
          value={selected}
          onChange={event => setChannelType(event.target.value)}
        >
          {channels.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="identity-handle">{t('handle')}</Label>
        <Input
          id="identity-handle"
          maxLength={CustomerLimits.CHANNEL_IDENTITY_MAX_LENGTH}
          autoComplete="off"
          value={handle}
          onChange={event => setHandle(event.target.value)}
        />
      </div>
      {ownerId === null ? (
        <MutationError error={link.error} />
      ) : (
        <div role="alert" className="flex flex-col items-start gap-1 text-sm">
          <p className="text-destructive">{t('taken')}</p>
          {onMergeInstead === undefined ? null : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => onMergeInstead(ownerId)}
            >
              {t('mergeInstead')}
            </Button>
          )}
        </div>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          size="sm"
          disabled={link.isPending || selected === '' || handle.trim() === ''}
        >
          {t('link')}
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          {tAll('common.cancel')}
        </Button>
      </div>
    </form>
  )
}
