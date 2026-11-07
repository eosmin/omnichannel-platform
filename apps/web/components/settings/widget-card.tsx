'use client'

import { useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useState } from 'react'

import { WidgetLimits } from '@platform/core/domain'

import type { WidgetEmbedView } from '../../lib/settings/channels-requests'
import { linesOf } from '../../lib/settings/connect-form'
import {
  useSaveWidgetOrigins,
  useSaveWidgetPreChat,
  useWidget
} from '../../lib/settings/use-channels'
import { toast } from '../../lib/toast'
import { MutationError } from '../customers/mutation-error'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

import { CopyButton } from './copy-button'
import { LoadFailed, PageLoading } from './states'

// The web widget of a connection (TDD_10 §5.4): the snippet to paste, the sites that may load it, the
// pre-chat form and what a site with a strict content security policy must allow.
export function WidgetCard({
  connectionId,
  canEdit
}: {
  connectionId: string
  canEdit: boolean
}): ReactElement {
  const { storeId } = useStore()
  const widget = useWidget(storeId, connectionId)
  if (widget.isError) {
    return <LoadFailed error={widget.error} onRetry={() => void widget.refetch()} />
  }
  if (widget.data === undefined) return <PageLoading />
  return <WidgetBody connectionId={connectionId} widget={widget.data} canEdit={canEdit} />
}

function WidgetBody({
  connectionId,
  widget,
  canEdit
}: {
  connectionId: string
  widget: WidgetEmbedView
  canEdit: boolean
}): ReactElement {
  const t = useTranslations('settings.channels.widget')
  const { storeId } = useStore()
  const saveOrigins = useSaveWidgetOrigins(storeId, connectionId)
  const savePreChat = useSaveWidgetPreChat(storeId, connectionId)
  // What the person typed, or null while they have not touched it: then the box follows the server
  // (another tab, another person), and never overwrites their text with a list they have not seen
  const [draft, setDraft] = useState<string | null>(null)
  const served = widget.allowedOrigins.join('\n')
  const text = draft ?? served
  const entries = linesOf(text)
  const changed = draft !== null && entries.join('\n') !== served
  const tooMany = entries.length > WidgetLimits.MAX_ORIGINS
  // What the site must allow, by directive: where the script comes from, and where the chat connects (the api,
  // its socket and the bucket of the files). Nothing is listed for a directive the server gave no address for.
  const directives = [
    { name: 'script-src', origins: widget.scriptSrc },
    { name: 'connect-src', origins: widget.connectSrc }
  ].filter(directive => directive.origins.length > 0)

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    if (!changed || tooMany || saveOrigins.isPending) return
    saveOrigins.mutate(entries, {
      onSuccess: () => {
        setDraft(null)
        toast.success(t('originsSaved'))
      }
    })
  }

  return (
    <div className="flex flex-col gap-5 border-t pt-4">
      <section className="grid grid-cols-1 gap-1.5">
        <h3 className="text-sm font-semibold">{t('snippet.title')}</h3>
        <p className="text-muted-foreground text-xs">{t('snippet.hint')}</p>
        <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
          <code>{widget.snippet}</code>
        </pre>
        <div>
          <CopyButton text={widget.snippet} label={t('snippet.title')} />
        </div>
      </section>

      <form onSubmit={submit} className="grid grid-cols-1 gap-1.5">
        <Label htmlFor={`origins-${connectionId}`} className="text-sm font-semibold">
          {t('origins.label')}
        </Label>
        <p className="text-muted-foreground text-xs">
          {t('origins.hint', { max: WidgetLimits.MAX_ORIGINS })}
        </p>
        <Textarea
          id={`origins-${connectionId}`}
          rows={3}
          spellCheck={false}
          value={text}
          onChange={event => {
            saveOrigins.reset()
            // Typed back to what the server has: the box follows the server again
            setDraft(event.target.value === served ? null : event.target.value)
          }}
          disabled={!canEdit || saveOrigins.isPending}
          aria-invalid={tooMany}
        />
        {tooMany ? (
          <p role="alert" className="text-destructive text-sm">
            {t('origins.tooMany', { max: WidgetLimits.MAX_ORIGINS })}
          </p>
        ) : null}
        <MutationError error={saveOrigins.error} />
        {canEdit ? (
          <div>
            <Button type="submit" size="sm" disabled={!changed || tooMany || saveOrigins.isPending}>
              {t('origins.save')}
            </Button>
          </div>
        ) : null}
      </form>

      <section className="grid grid-cols-1 gap-1.5">
        <div className="flex items-center gap-2">
          <input
            id={`prechat-${connectionId}`}
            type="checkbox"
            className="size-4"
            checked={widget.preChatEnabled}
            disabled={!canEdit || savePreChat.isPending}
            onChange={event => savePreChat.mutate(event.target.checked)}
          />
          <Label htmlFor={`prechat-${connectionId}`} className="text-sm font-semibold">
            {t('preChat.label')}
          </Label>
        </div>
        <p className="text-muted-foreground text-xs">{t('preChat.hint')}</p>
        <MutationError error={savePreChat.error} />
      </section>

      {directives.length > 0 ? (
        <section className="grid grid-cols-1 gap-1.5" aria-label={t('csp.title')}>
          <h3 className="text-sm font-semibold">{t('csp.title')}</h3>
          <p className="text-muted-foreground text-xs">{t('csp.hint')}</p>
          <ul className="grid grid-cols-1 gap-2">
            {directives.map(directive => (
              <li key={directive.name} className="grid grid-cols-1 gap-1">
                <code className="bg-muted rounded-md px-2 py-1.5 text-xs break-all">
                  {directive.name} {directive.origins.join(' ')}
                </code>
                <div>
                  <CopyButton
                    text={`${directive.name} ${directive.origins.join(' ')}`}
                    label={directive.name}
                  />
                </div>
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">{t('csp.others')}</p>
        </section>
      ) : null}
    </div>
  )
}
