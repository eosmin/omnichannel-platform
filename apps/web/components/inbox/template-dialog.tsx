'use client'

import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { QueryKeys, sendTemplate } from '@platform/api-client'
import { MessageType, TemplateStatuses } from '@platform/core/domain'

import { apiClient } from '../../lib/api'
import { errorCodeOf } from '../../lib/error-message'
import { fillTemplate, variableCountOf } from '../../lib/inbox/template-variables'
import { useChannelTemplates } from '../../lib/inbox/use-inbox-data'
import { ConnectionStatuses } from '../../lib/realtime/connection-status'
import { useConnectionStatus } from '../../lib/realtime/use-connection-status'
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

export interface TemplateDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  conversationId: string
  pluginId: string
  connectionId: string
}

// The only way to write to a customer outside the messaging window. It does not use the offline
// queue: a template is a deliberate act that costs money and the provider checks it, so it is sent now
// or not at all, and the agent sees the answer. The key of the request is made for each choice and
// kept across retries, so a retry after a timeout cannot send the template twice.
export function TemplateDialog(props: TemplateDialogProps): ReactElement {
  const t = useTranslations('inbox.composer.template')
  // While a send is in flight the dialog stays: closing it would hide the answer, an error included
  const [isSending, setSending] = useState(false)
  return (
    <Dialog
      open={props.open}
      onOpenChange={open => {
        if (open || !isSending) props.onOpenChange(open)
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: closing forgets the choice, as a new dialog should */}
        {props.open ? <TemplateForm {...props} onSendingChange={setSending} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function TemplateForm({
  onOpenChange,
  onSendingChange,
  conversationId,
  pluginId,
  connectionId
}: TemplateDialogProps & { onSendingChange: (isSending: boolean) => void }): ReactElement {
  const t = useTranslations('inbox.composer.template')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const queryClient = useQueryClient()
  const templates = useChannelTemplates(storeId, pluginId, connectionId)
  const connection = useConnectionStatus()
  const isOffline = connection !== ConnectionStatuses.CONNECTED
  const [chosen, setChosen] = useState<string | null>(null)
  const [values, setValues] = useState<string[]>([])
  const idempotencyKey = useRef(crypto.randomUUID())

  const approved = (templates.data ?? []).filter(
    template => template.status === TemplateStatuses.APPROVED
  )
  const template = approved.find(item => `${item.name}|${item.language}` === chosen)
  const count = template === undefined ? 0 : variableCountOf(template.body)
  const typed = Array.from({ length: count }, (_, index) => values[index] ?? '')
  const isComplete = template !== undefined && typed.every(value => value.trim() !== '')

  // A different choice is a different send
  const changeChoice = (next: string): void => {
    setChosen(next)
    setValues([])
    idempotencyKey.current = crypto.randomUUID()
  }
  const changeValue = (index: number, value: string): void => {
    setValues(typed.map((current, at) => (at === index ? value : current)))
    idempotencyKey.current = crypto.randomUUID()
  }

  const send = useMutation({
    mutationFn: () => {
      if (template === undefined) throw new Error('no template chosen')
      return sendTemplate(apiClient, storeId, {
        type: MessageType.TEMPLATE,
        conversationId,
        templateName: template.name,
        language: template.language,
        variables: typed.map(value => value.trim()),
        idempotencyKey: idempotencyKey.current
      })
    },
    onSuccess: () => {
      // The message is stored: the dialog does not wait for the thread to be read again
      void queryClient.invalidateQueries({
        queryKey: QueryKeys.messages.thread(storeId, conversationId)
      })
      onOpenChange(false)
    }
  })

  const isSending = send.isPending
  useEffect(() => {
    onSendingChange(isSending)
    return () => onSendingChange(false)
  }, [isSending, onSendingChange])

  if (templates.isPending) {
    return (
      <p role="status" className="text-muted-foreground text-sm">
        {t('loading')}
      </p>
    )
  }
  if (templates.isError) {
    return (
      <div className="flex flex-col gap-3">
        <p role="alert" className="text-destructive text-sm">
          {tAll(`errors.${errorCodeOf(templates.error)}`)}
        </p>
        <Button type="button" variant="outline" size="sm" onClick={() => void templates.refetch()}>
          {tAll('common.tryAgain')}
        </Button>
      </div>
    )
  }
  if (approved.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('none')}</p>
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        if (isComplete && !isOffline && !send.isPending) send.mutate()
      }}
    >
      <fieldset disabled={send.isPending} className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('choose')}</legend>
        {approved.map(item => {
          const key = `${item.name}|${item.language}`
          return (
            <label
              key={key}
              className="has-[:checked]:border-ring flex cursor-pointer flex-col gap-1 rounded-md border p-2 text-sm"
            >
              <span className="flex items-center gap-2">
                <input
                  type="radio"
                  name="template"
                  value={key}
                  checked={chosen === key}
                  onChange={() => changeChoice(key)}
                />
                <span className="font-medium">{item.name}</span>
                <span className="text-muted-foreground text-xs">{item.language}</span>
              </span>
              <span className="text-muted-foreground break-words whitespace-pre-wrap">
                {item.body}
              </span>
            </label>
          )
        })}
      </fieldset>

      {template === undefined || count === 0 ? null : (
        <div className="flex flex-col gap-3">
          {typed.map((value, index) => (
            <div key={`${chosen}-${index + 1}`} className="flex flex-col gap-1.5">
              <Label htmlFor={`template-variable-${index + 1}`}>
                {t('variable', { number: index + 1 })}
              </Label>
              <Input
                id={`template-variable-${index + 1}`}
                value={value}
                disabled={send.isPending}
                onChange={event => changeValue(index, event.target.value)}
              />
            </div>
          ))}
        </div>
      )}

      {template === undefined ? null : (
        <div className="flex flex-col gap-1">
          <p className="text-sm font-medium">{t('preview')}</p>
          <p className="bg-muted rounded-md p-2 text-sm break-words whitespace-pre-wrap">
            {fillTemplate(template.body, typed)}
          </p>
        </div>
      )}

      {isOffline ? (
        <p role="status" className="text-muted-foreground text-sm">
          {t('offline')}
        </p>
      ) : null}
      {send.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {tAll(`errors.${errorCodeOf(send.error)}`)}
        </p>
      ) : null}

      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          disabled={send.isPending}
          onClick={() => onOpenChange(false)}
        >
          {tAll('common.cancel')}
        </Button>
        <Button type="submit" disabled={!isComplete || isOffline || send.isPending}>
          {send.isPending ? t('sending') : t('send')}
        </Button>
      </DialogFooter>
    </form>
  )
}
