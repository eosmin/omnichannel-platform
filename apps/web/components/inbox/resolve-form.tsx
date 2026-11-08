'use client'

import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useRef, useState } from 'react'

import { AppPaths, StoreSettingsSections } from '@platform/api-client'
import { ClientPermissions } from '@platform/core/auth'
import { ConversationLimits, ResolveUndo, SLASH_PREFIX } from '@platform/core/domain'

import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { useSnippets } from '../../lib/inbox/use-inbox-data'
import { usePushOffer } from '../../lib/push/use-push-offer'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Button } from '../ui/button'
import { CharCounter } from '../ui/char-counter'
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
  const { resolve, undoResolve } = useConversationActions(storeId, conversationId)
  const { offer: offerPush } = usePushOffer(storeId)
  const [wantsClosing, setWantsClosing] = useState(defaults.sendClosingMessage)
  const [snippetId, setSnippetId] = useState(defaults.closingSnippetId ?? '')
  const [reason, setReason] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  // The form loads after the dialog opens, so the dialog has already put the focus on its close button:
  // the first field takes it, and the agent starts where the choices are (Cancel and Resolve never take it)
  useEffect(() => {
    formRef.current
      ?.querySelector<HTMLElement>(
        'input:not(:disabled), select:not(:disabled), textarea:not(:disabled)'
      )
      ?.focus()
  }, [])

  const list = snippets.data ?? []
  // Without a snippet chosen, the first one of the list is what the select shows
  const chosenId = list.some(item => item.id === snippetId) ? snippetId : (list[0]?.id ?? '')
  const sendsClosing = wantsClosing && canSendClosing && chosenId !== ''
  // Asked for a closing message that cannot be sent yet (still loading, or no saved reply): resolving
  // now would drop it without a word, so the agent unchecks it or waits
  const isMissingClosing = wantsClosing && canSendClosing && chosenId === ''

  // Set at once, not with the render: two presses that land in the same cycle of render would both see a form that
  // is not pending yet, and the conversation would be resolved twice
  const isSubmitting = useRef(false)
  const submit = (): void => {
    if (isSubmitting.current) return
    isSubmitting.current = true
    const trimmed = reason.trim()
    resolve
      .mutateAsync({
        ...(trimmed === '' ? {} : { reason: trimmed }),
        ...(sendsClosing ? { closingSnippetId: chosenId } : {})
      })
      .then(
        () => {
          // The same Undo as the way with no dialog: the closing message waits for it on the server
          toast(t('resolved'), {
            duration: ResolveUndo.DURATION_MS,
            action: {
              label: tAll('common.undo'),
              onClick: () =>
                void undoResolve
                  .mutateAsync()
                  .catch((error: unknown) => toast.error(errorText(error)))
            }
          })
          offerPush()
          onDone()
        },
        // The error shows in the dialog, from the state of the mutation, and the form can be sent again.
        // Only a refused resolve opens the lock: what happens after a good one must not
        () => {
          isSubmitting.current = false
        }
      )
  }

  return (
    <form
      ref={formRef}
      className="flex flex-col gap-4"
      onSubmit={event => {
        event.preventDefault()
        if (!resolve.isPending && !isMissingClosing) submit()
      }}
      // Cmd/Ctrl+Enter confirms from any field, as it sends in the composer: `e` then the pair resolves
      // without the four Tab to the button (the Enter of the box of the reason stays a line break)
      onKeyDown={event => {
        if (event.key !== 'Enter' || !(event.metaKey || event.ctrlKey)) return
        // Held down, or confirming a candidate of an input method, it is not a decision; on Cancel or a link
        // the keys keep their own meaning
        if (event.repeat || event.nativeEvent.isComposing) return
        if (
          !(event.target instanceof HTMLElement) ||
          !event.target.matches('input, select, textarea')
        ) {
          return
        }
        event.preventDefault()
        if (!resolve.isPending && !isMissingClosing) submit()
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
          <CharCounter
            length={reason.length}
            max={ConversationLimits.RESOLUTION_REASON_MAX_LENGTH}
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
        <Button
          type="submit"
          disabled={resolve.isPending || isMissingClosing}
          aria-keyshortcuts={
            resolve.isPending || isMissingClosing ? undefined : 'Control+Enter Meta+Enter'
          }
        >
          {resolve.isPending ? t('resolving') : t('confirm')}
        </Button>
      </DialogFooter>
    </form>
  )
}
