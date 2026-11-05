'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import { connectFailureReasonOf, isTokenFailure } from '../../lib/error-message'
import type { PluginCatalogEntryView } from '../../lib/settings/channels-requests'
import {
  ChannelMessagePrefix,
  type ConnectValues,
  credentialsOf,
  emptyValues,
  missingFields
} from '../../lib/settings/connect-form'
import { useConnect } from '../../lib/settings/use-channels'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

import { CallbackUrl } from './callback-url'

// Connect a channel (TDD_09 §13, TDD_10 §10): the form is what the plugin asks for, nothing here knows
// a channel by name. A secret is typed in a masked field and is never shown again; the plugin checks
// every value, and its refusal is what the person reads.
export function ConnectDialog({
  plugin,
  onClose
}: {
  plugin: PluginCatalogEntryView
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.channels.connectDialog')
  const { storeId } = useStore()
  const connect = useConnect(storeId, plugin.id)
  // The request is not abandoned half way: its answer (the toast, the error) needs this dialog open
  return (
    <Dialog open onOpenChange={open => (open || connect.isPending ? undefined : onClose())}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title', { name: plugin.name })}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        <ConnectForm plugin={plugin} connect={connect} onClose={onClose} />
      </DialogContent>
    </Dialog>
  )
}

function ConnectForm({
  plugin,
  connect,
  onClose
}: {
  plugin: PluginCatalogEntryView
  connect: ReturnType<typeof useConnect>
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.channels.connectDialog')
  const tAll = useTranslations()
  const idPrefix = useId()
  const fields = plugin.channel?.connectFields ?? []
  const [values, setValues] = useState<ConnectValues>(() => emptyValues(fields))
  const canSubmit = missingFields(fields, values).length === 0 && !connect.isPending
  // When the refusal is about the token (not the account, not Meta being away), the person is taken back to
  // the field to paste another, and the field says it is the one that failed
  const tokenKey = fields.find(field => field.secret)?.key
  const tokenInput = useRef<HTMLInputElement>(null)
  const tokenFailed = isTokenFailure(connectFailureReasonOf(connect.error))
  useEffect(() => {
    if (tokenFailed) tokenInput.current?.focus()
  }, [tokenFailed, connect.submittedAt])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit) return
    connect.mutate(credentialsOf(fields, values), {
      onSuccess: connection => {
        toast.success(t('connected', { name: connection.displayName }))
        onClose()
      }
    })
  }

  // A key the page has no text for (a plugin newer than the page) shows the key of the field
  const labelOf = (key: string, labelKey: string): string =>
    labelKey.startsWith(ChannelMessagePrefix) &&
    tAll.has(labelKey as Parameters<typeof tAll.has>[0])
      ? tAll(labelKey as Parameters<typeof tAll>[0])
      : key

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      {fields.map(field => {
        const id = `${idPrefix}-${field.key}`
        const label = labelOf(field.key, field.labelKey)
        return (
          <div key={field.key} className="grid gap-1.5">
            <Label htmlFor={id}>
              {label}
              {field.required ? null : (
                <span className="text-muted-foreground font-normal"> {t('optional')}</span>
              )}
            </Label>
            {field.multiple && !field.secret ? (
              <Textarea
                id={id}
                rows={3}
                autoComplete="off"
                spellCheck={false}
                value={values[field.key] ?? ''}
                onChange={event => setValues({ ...values, [field.key]: event.target.value })}
                disabled={connect.isPending}
                required={field.required}
              />
            ) : (
              <Input
                id={id}
                ref={field.key === tokenKey ? tokenInput : undefined}
                aria-invalid={field.key === tokenKey && tokenFailed ? true : undefined}
                // A token or a password: masked (a secret is always one line, so it can always be masked), and the browser is told not to keep it
                type={field.secret ? 'password' : 'text'}
                // `off` is ignored for a password field: this one is not offered for saving
                autoComplete={field.secret ? 'new-password' : 'off'}
                spellCheck={false}
                value={values[field.key] ?? ''}
                onChange={event => setValues({ ...values, [field.key]: event.target.value })}
                disabled={connect.isPending}
                required={field.required}
              />
            )}
            {field.secret ? (
              <p className="text-muted-foreground text-xs">{t('secretHint')}</p>
            ) : null}
          </div>
        )
      })}
      {plugin.channel?.callbackUrl != null ? (
        <CallbackUrl url={plugin.channel.callbackUrl} />
      ) : null}
      <MutationError error={connect.error} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={connect.isPending}>
          {tAll('common.cancel')}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {connect.isPending ? t('connecting') : t('submit')}
        </Button>
      </DialogFooter>
    </form>
  )
}
