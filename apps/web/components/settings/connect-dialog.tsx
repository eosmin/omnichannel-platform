'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useId, useRef, useState } from 'react'
import { toast } from 'sonner'

import type {
  ChannelConnectionView,
  ConnectFieldView,
  PluginCatalogEntryView
} from '../../lib/settings/channels-requests'
import { connectFailureReasonOf, isTokenFailure } from '../../lib/settings/connect-failure'
import {
  ChannelMessagePrefix,
  type ConnectValues,
  credentialsOf,
  emptyValues,
  missingFields
} from '../../lib/settings/connect-form'
import { useConnect } from '../../lib/settings/use-channels'
import { useSubmitGuard } from '../../lib/submit-guard'
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
import { ConnectError } from './connect-error'

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
        <ConnectForm
          fields={plugin.channel?.connectFields ?? []}
          callbackUrl={plugin.channel?.callbackUrl ?? null}
          connect={connect}
          texts={{ submit: t('submit'), pending: t('connecting') }}
          onDone={connection => {
            toast.success(t('connected', { name: connection.displayName }))
            onClose()
          }}
          onClose={onClose}
        />
      </DialogContent>
    </Dialog>
  )
}

// The form of what the plugin asks for, and what happens with it. It serves to connect a channel and to
// replace the token of a connection (then `fields` are only the secret ones): the request is the caller's.
export function ConnectForm({
  fields,
  callbackUrl,
  connect,
  texts,
  onDone,
  onClose
}: {
  fields: readonly ConnectFieldView[]
  // The address the owner pastes at the provider; only when connecting a channel for the first time
  callbackUrl: string | null
  connect: Pick<ReturnType<typeof useConnect>, 'mutate' | 'isPending' | 'error'>
  texts: { submit: string; pending: string }
  onDone: (connection: ChannelConnectionView) => void
  onClose: () => void
}): ReactElement {
  const t = useTranslations('settings.channels.connectDialog')
  const tAll = useTranslations()
  const idPrefix = useId()
  const [values, setValues] = useState<ConnectValues>(() => emptyValues(fields))
  const canSubmit = missingFields(fields, values).length === 0 && !connect.isPending
  // When the refusal is about the token (not the account, not Meta being away), the person is taken back to
  // the field to paste another, and the field says it is the one that failed
  const tokenKey = fields.find(field => field.secret)?.key
  const tokenInput = useRef<HTMLInputElement>(null)
  const tokenFailed = isTokenFailure(connectFailureReasonOf(connect.error))
  // Once for each failure (a new error object), not for each submit: someone who retries from the button is
  // not pulled away while the request runs
  useEffect(() => {
    if (tokenFailed) tokenInput.current?.focus()
  }, [tokenFailed, connect.error])
  const errorId = `${idPrefix}-connect-error`

  const guard = useSubmitGuard()
  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!canSubmit || !guard.enter()) return
    connect.mutate(credentialsOf(fields, values), {
      onSuccess: onDone,
      onSettled: guard.leave
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
          <div key={field.key} className="grid grid-cols-1 gap-1.5">
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
                aria-describedby={field.key === tokenKey && tokenFailed ? errorId : undefined}
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
      {callbackUrl === null ? null : <CallbackUrl url={callbackUrl} />}
      <ConnectError error={connect.error} id={errorId} />
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={connect.isPending}>
          {tAll('common.cancel')}
        </Button>
        <Button type="submit" disabled={!canSubmit}>
          {connect.isPending ? texts.pending : texts.submit}
        </Button>
      </DialogFooter>
    </form>
  )
}
