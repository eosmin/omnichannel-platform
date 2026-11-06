'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { ConversationLimits, SLASH_PREFIX } from '@platform/core/domain'

import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { useSnippets } from '../../lib/inbox/use-inbox-data'
import { usePushOffer } from '../../lib/push/use-push-offer'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { DialogFooter } from '../ui/dialog'
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

// The form of the options dialog of "Resolve" (closing message, reason). Apart from the flow, which
// every conversation mounts, so that the page does not download it until the dialog opens.
export function ResolveForm({
  conversationId,
  defaults,
  canSendClosing,
  onDone,
  onCancel
}: {
  conversationId: string
  defaults: { sendClosingMessage: boolean; closingSnippetId: string | null }
  canSendClosing: boolean
  onDone: () => void
  onCancel: () => void
}): ReactElement {
  const t = useTranslations('inbox.resolve')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const snippets = useSnippets(storeId, true)
  const { resolve } = useConversationActions(storeId, conversationId)
  const { offer: offerPush } = usePushOffer(storeId)
  const [wantsClosing, setWantsClosing] = useState(defaults.sendClosingMessage)
  const [snippetId, setSnippetId] = useState(defaults.closingSnippetId ?? '')
  const [reason, setReason] = useState('')

  const list = snippets.data ?? []
  // Without a snippet chosen, the first one of the list is what the select shows
  const chosenId = list.some(item => item.id === snippetId) ? snippetId : (list[0]?.id ?? '')
  const sendsClosing = wantsClosing && canSendClosing && chosenId !== ''
  // Asked for a closing message that cannot be sent yet (still loading, or no saved reply): resolving
  // now would drop it without a word, so the agent unchecks it or waits
  const isMissingClosing = wantsClosing && canSendClosing && chosenId === ''

  const submit = (): void => {
    const trimmed = reason.trim()
    resolve
      .mutateAsync({
        ...(trimmed === '' ? {} : { reason: trimmed }),
        ...(sendsClosing ? { closingSnippetId: chosenId } : {})
      })
      .then(() => {
        toast.success(t('resolved'))
        offerPush()
        onDone()
      })
      // The error shows in the dialog, from the state of the mutation
      .catch(() => undefined)
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        if (!resolve.isPending) submit()
      }}
    >
      <fieldset disabled={resolve.isPending} className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={wantsClosing && canSendClosing}
            disabled={!canSendClosing}
            onChange={event => setWantsClosing(event.target.checked)}
          />
          {t('sendClosing')}
        </label>
        {canSendClosing ? null : (
          <p className="text-muted-foreground text-xs">{t('windowClosed')}</p>
        )}
        {wantsClosing && canSendClosing ? (
          snippets.isPending ? (
            <p role="status" className="text-muted-foreground text-sm">
              {tAll('common.loading')}
            </p>
          ) : list.length === 0 ? (
            <div className="flex flex-col items-start gap-1">
              <p className="text-muted-foreground text-sm">{t('noSnippets')}</p>
              {can(ClientPermissions.SETTINGS_VIEW) ? (
                <Link
                  href={AppPaths.store.settings(storeId, StoreSettingsSections.SNIPPETS)}
                  className="text-sm underline underline-offset-2"
                >
                  {t('manageSnippets')}
                </Link>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="resolve-snippet">{t('snippet')}</Label>
              <select
                id="resolve-snippet"
                className={SELECT_CLASS}
                value={chosenId}
                onChange={event => setSnippetId(event.target.value)}
              >
                {list.map(item => (
                  <option key={item.id} value={item.id}>
                    {`${SLASH_PREFIX}${item.shortcut} · ${item.title}`}
                  </option>
                ))}
              </select>
              <p className="bg-muted rounded-md p-2 text-sm break-words whitespace-pre-wrap">
                {list.find(item => item.id === chosenId)?.content}
              </p>
            </div>
          )
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="resolve-reason">{t('reason')}</Label>
          <Textarea
            id="resolve-reason"
            value={reason}
            maxLength={ConversationLimits.RESOLUTION_REASON_MAX_LENGTH}
            rows={2}
            onChange={event => setReason(event.target.value)}
          />
        </div>
      </fieldset>
      {resolve.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(resolve.error)}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={resolve.isPending}>
          {tAll('common.cancel')}
        </Button>
        <Button type="submit" disabled={resolve.isPending || isMissingClosing}>
          {resolve.isPending ? t('resolving') : t('confirm')}
        </Button>
      </DialogFooter>
    </form>
  )
}
