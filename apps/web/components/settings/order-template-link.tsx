'use client'

import { Plus, X } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { OrderMessageLimits, TemplateStatuses } from '@platform/core/domain'

import { useChannelTemplates } from '../../lib/inbox/use-inbox-data'
import type { LinkableChannel } from '../../lib/settings/order-template-channels'
import {
  type ChannelLinkDraft,
  KNOWN_VARIABLES,
  numberedPlaceholdersOf,
  variablesForPlaceholders
} from '../../lib/settings/order-template-form'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { SELECT_CLASS } from '../ui/field-classes'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

import { LoadFailed } from './states'

// The template the channel approved, which the customer reads when the messaging window is closed (TDD_17 §4.7): its name
// and language as the owner has them in the channel, and which variable of ours fills each numbered placeholder. Offered
// only for a channel whose plugin declares templates and a window that asks for one; the list of the approved ones is read
// from an account of that channel by whoever may send templates, and everyone else types the name and language.
export function OrderTemplateLink({
  link,
  channels,
  channelsKnown,
  onChange,
  disabled
}: {
  link: ChannelLinkDraft | null
  channels: LinkableChannel[]
  channelsKnown: boolean
  onChange: (next: ChannelLinkDraft | null) => void
  disabled: boolean
}): ReactElement | null {
  const t = useTranslations('settings.orderMessages.link')
  const idPrefix = useId()
  const first = channels[0]
  // A link to a channel that is no longer offered stays visible, so that it can be seen and removed
  if (first === undefined && link === null) return null
  const channel = channels.find(item => item.pluginId === link?.pluginId)
  const toggle = (on: boolean): void => {
    if (!on) onChange(null)
    else if (first !== undefined) {
      onChange({ pluginId: first.pluginId, name: '', language: '', variables: [] })
    }
  }
  return (
    <fieldset className="flex flex-col gap-3 rounded-lg border p-4">
      <legend className="px-1 text-sm font-medium">{t('legend')}</legend>
      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={link !== null}
          onChange={event => toggle(event.target.checked)}
          disabled={disabled || (first === undefined && link === null)}
          className="mt-1"
        />
        <span>
          {t('use')}
          <span className="text-muted-foreground block text-xs">{t('useHint')}</span>
        </span>
      </label>
      {link === null ? null : (
        <div className="flex flex-col gap-3">
          {channel === undefined ? (
            channelsKnown ? (
              <p role="note" className="text-muted-foreground text-xs">
                {t('channelGone')}
              </p>
            ) : null
          ) : (
            <div className="grid max-w-md gap-1.5">
              <Label htmlFor={`${idPrefix}-channel`}>{t('channel')}</Label>
              <select
                id={`${idPrefix}-channel`}
                value={link.pluginId}
                onChange={event =>
                  onChange({
                    ...link,
                    pluginId: event.target.value,
                    name: '',
                    language: '',
                    variables: []
                  })
                }
                disabled={disabled}
                className={SELECT_CLASS}
              >
                {channels.map(item => (
                  <option key={item.pluginId} value={item.pluginId}>
                    {item.pluginName}
                  </option>
                ))}
              </select>
            </div>
          )}
          {channel === undefined || channel.connections.length === 0 ? null : (
            <ApprovedTemplates
              key={link.pluginId}
              channel={channel}
              link={link}
              onChange={onChange}
              disabled={disabled}
            />
          )}
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor={`${idPrefix}-name`}>{t('name')}</Label>
            <Input
              id={`${idPrefix}-name`}
              value={link.name}
              onChange={event => onChange({ ...link, name: event.target.value })}
              disabled={disabled}
            />
          </div>
          <div className="grid max-w-md gap-1.5">
            <Label htmlFor={`${idPrefix}-language`}>{t('language')}</Label>
            <Input
              id={`${idPrefix}-language`}
              value={link.language}
              onChange={event => onChange({ ...link, language: event.target.value })}
              disabled={disabled}
              className="max-w-40"
            />
            <p className="text-muted-foreground text-xs">{t('languageHint')}</p>
          </div>
          <Placeholders link={link} onChange={onChange} disabled={disabled} />
        </div>
      )}
    </fieldset>
  )
}

// The approved templates of one account of the channel, to pick one instead of typing it
function ApprovedTemplates({
  channel,
  link,
  onChange,
  disabled
}: {
  channel: LinkableChannel
  link: ChannelLinkDraft
  onChange: (next: ChannelLinkDraft) => void
  disabled: boolean
}): ReactElement | null {
  const { can } = useStore()
  const allowed =
    can(ClientPermissions.CONVERSATIONS_VIEW) && can(ClientPermissions.MESSAGES_SEND_TEMPLATE)
  if (!allowed) return null
  return (
    <ApprovedTemplatesPicker
      channel={channel}
      link={link}
      onChange={onChange}
      disabled={disabled}
    />
  )
}

function ApprovedTemplatesPicker({
  channel,
  link,
  onChange,
  disabled
}: {
  channel: LinkableChannel
  link: ChannelLinkDraft
  onChange: (next: ChannelLinkDraft) => void
  disabled: boolean
}): ReactElement {
  const t = useTranslations('settings.orderMessages.link')
  const { storeId } = useStore()
  const idPrefix = useId()
  const [connectionId, setConnectionId] = useState(channel.connections[0]?.id ?? '')
  const templates = useChannelTemplates(storeId, channel.pluginId, connectionId)
  const approved = (templates.data ?? []).filter(item => item.status === TemplateStatuses.APPROVED)
  const chosen = approved.find(
    item => item.name === link.name.trim() && item.language === link.language.trim()
  )
  const pick = (key: string): void => {
    const template = approved.find(item => `${item.name}/${item.language}` === key)
    if (template === undefined) return
    onChange({
      ...link,
      name: template.name,
      language: template.language,
      variables: variablesForPlaceholders(link.variables, numberedPlaceholdersOf(template.body))
    })
  }
  return (
    <div className="flex flex-col gap-3">
      {channel.connections.length > 1 ? (
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor={`${idPrefix}-account`}>{t('account')}</Label>
          <select
            id={`${idPrefix}-account`}
            value={connectionId}
            onChange={event => setConnectionId(event.target.value)}
            disabled={disabled}
            className={SELECT_CLASS}
          >
            {channel.connections.map(connection => (
              <option key={connection.id} value={connection.id}>
                {connection.displayName}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      {templates.isError ? (
        <LoadFailed error={templates.error} onRetry={() => void templates.refetch()} />
      ) : (
        <div className="grid max-w-md gap-1.5">
          <Label htmlFor={`${idPrefix}-approved`}>{t('approved')}</Label>
          <select
            id={`${idPrefix}-approved`}
            value={chosen === undefined ? '' : `${chosen.name}/${chosen.language}`}
            onChange={event => pick(event.target.value)}
            disabled={disabled || templates.data === undefined}
            className={SELECT_CLASS}
          >
            <option value="">
              {templates.data === undefined
                ? t('approvedLoading')
                : approved.length === 0
                  ? t('approvedNone')
                  : t('approvedPick')}
            </option>
            {approved.map(item => (
              <option key={`${item.name}/${item.language}`} value={`${item.name}/${item.language}`}>
                {item.name} ({item.language})
              </option>
            ))}
          </select>
          {chosen === undefined ? null : (
            <p className="text-muted-foreground text-xs whitespace-pre-wrap">{chosen.body}</p>
          )}
        </div>
      )}
    </div>
  )
}

// Which variable of ours fills each numbered placeholder of the channel template, in order
function Placeholders({
  link,
  onChange,
  disabled
}: {
  link: ChannelLinkDraft
  onChange: (next: ChannelLinkDraft) => void
  disabled: boolean
}): ReactElement {
  const t = useTranslations('settings.orderMessages')
  const idPrefix = useId()
  const set = (index: number, value: string): void =>
    onChange({
      ...link,
      variables: link.variables.map((current, at) => (at === index ? value : current))
    })
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-medium">{t('link.placeholders')}</p>
      <p className="text-muted-foreground text-xs">{t('link.placeholdersHint')}</p>
      {link.variables.map((value, index) => (
        // The slots are positional: the place is the identity of a row
        <div key={`placeholder-${index}`} className="flex items-center gap-2">
          <Label htmlFor={`${idPrefix}-${index}`} className="w-28 shrink-0">
            {t('link.placeholder', { number: index + 1 })}
          </Label>
          <select
            id={`${idPrefix}-${index}`}
            value={value}
            onChange={event => set(index, event.target.value)}
            disabled={disabled}
            className={SELECT_CLASS}
          >
            <option value="">{t('link.chooseVariable')}</option>
            {KNOWN_VARIABLES.map(variable => (
              <option key={variable} value={variable}>
                {t(`variables.${variable}.label`)}
              </option>
            ))}
          </select>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={t('link.removePlaceholder', { number: index + 1 })}
            disabled={disabled || index !== link.variables.length - 1}
            onClick={() => onChange({ ...link, variables: link.variables.slice(0, -1) })}
          >
            <X aria-hidden className="size-4" />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          variant="outline"
          disabled={
            disabled || link.variables.length >= OrderMessageLimits.CHANNEL_TEMPLATE_VARIABLES_MAX
          }
          onClick={() => onChange({ ...link, variables: [...link.variables, ''] })}
        >
          <Plus aria-hidden className="size-4" />
          {t('link.addPlaceholder')}
        </Button>
      </div>
    </div>
  )
}
