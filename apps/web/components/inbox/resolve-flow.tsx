'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'
import { ConversationLimits, ResolveUndo, SLASH_PREFIX } from '@platform/core/domain'

import { errorCodeOf } from '../../lib/error-message'
import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { useInboxBehavior, useMessagingWindow, useSnippets } from '../../lib/inbox/use-inbox-data'
import { useWindowState } from '../../lib/inbox/use-window-state'
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
import { SELECT_CLASS } from '../ui/field-classes'
import { Label } from '../ui/label'
import { Textarea } from '../ui/textarea'

export interface ResolveFlow {
  // False until the settings of the store are read: they decide which of the two flows runs
  isReady: boolean
  start: () => void
  // The options dialog, to render once where the flow is used
  dialog: ReactElement
}

// The idempotency key of a send that may be tried again: the same for the same scope (here the saved
// reply chosen), so that a retry after a failed resolve returns the message that went out instead of
// sending it twice, and another one for another scope, because that is another message.
function useAttemptKey(): { keyFor: (scope: string) => string; reset: () => void } {
  const attempt = useRef<{ scope: string; key: string } | null>(null)
  const keyFor = useCallback((scope: string): string => {
    if (attempt.current?.scope !== scope) attempt.current = { scope, key: crypto.randomUUID() }
    return attempt.current.key
  }, [])
  const reset = useCallback((): void => {
    attempt.current = null
  }, [])
  return { keyFor, reset }
}

// Marking a conversation resolved, the way the store configured it: with the options dialog (closing message, reason) or at once, with a toast that takes it back for ten seconds. The
// closing message is sent before the status changes and only when the messaging window is open.
export function useResolveFlow(conversationId: string): ResolveFlow {
  const t = useTranslations('inbox.resolve')
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const behavior = useInboxBehavior(storeId)
  const windowState = useWindowState(storeId, conversationId)
  const windowQuery = useMessagingWindow(storeId, conversationId)
  const { resolve, reopen } = useConversationActions(storeId, conversationId)
  const [isDialogOpen, setDialogOpen] = useState(false)
  // One attempt, one key: starting again after a failed resolve must not send the closing message twice
  const attempt = useAttemptKey()

  // The closing message is a reply: it needs the window open and the permission to reply
  const canSendClosing = windowState.kind !== 'closed' && can(Permissions.MESSAGES_SEND)
  const settings = behavior.data

  const start = (): void => {
    if (resolve.isPending) return
    if (settings === undefined) {
      // The settings did not load: say so and ask again, instead of a button that does nothing
      if (behavior.isError) {
        toast.error(tAll(`errors.${errorCodeOf(behavior.error)}`))
        void behavior.refetch()
      }
      return
    }
    if (settings.resolveShowOptions) {
      setDialogOpen(true)
      return
    }
    const closingSnippetId =
      settings.sendClosingMessage && canSendClosing ? settings.closingSnippetId : null
    // Promises, not the callbacks of mutate: those do not run if the agent moves to another
    // conversation before the answer, and the Undo must still appear
    resolve
      .mutateAsync(
        closingSnippetId === null
          ? {}
          : {
              closing: {
                snippetId: closingSnippetId,
                idempotencyKey: attempt.keyFor(closingSnippetId)
              }
            }
      )
      .then(() => {
        attempt.reset()
        toast(t('resolved'), {
          duration: ResolveUndo.DURATION_MS,
          action: {
            label: tAll('common.undo'),
            onClick: () =>
              void reopen
                .mutateAsync()
                .catch((error: unknown) => toast.error(tAll(`errors.${errorCodeOf(error)}`)))
          }
        })
      })
      .catch((error: unknown) => toast.error(tAll(`errors.${errorCodeOf(error)}`)))
  }

  // The same function for the life of the hook: the header and the composer hold it in a context
  const latest = useRef(start)
  useEffect(() => {
    latest.current = start
  })
  const stableStart = useCallback((): void => latest.current(), [])

  return {
    // Ready once the settings and the window are known (a failed read does not block: the click then
    // says what failed and reads again)
    isReady: !behavior.isPending && !windowQuery.isPending,
    start: stableStart,
    dialog: (
      <Dialog open={isDialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          {/* Mounted only while open: the choices start from the settings each time */}
          {isDialogOpen && settings !== undefined ? (
            <ResolveForm
              conversationId={conversationId}
              defaults={settings}
              canSendClosing={canSendClosing}
              attempt={attempt}
              onDone={() => {
                attempt.reset()
                setDialogOpen(false)
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    )
  }
}

function ResolveForm({
  conversationId,
  defaults,
  canSendClosing,
  attempt,
  onDone
}: {
  conversationId: string
  defaults: { sendClosingMessage: boolean; closingSnippetId: string | null }
  canSendClosing: boolean
  // Kept by the hook, not the form: the dialog closes and opens again after a failed resolve, and the
  // closing message that already went out must not go twice
  attempt: ReturnType<typeof useAttemptKey>
  onDone: () => void
}): ReactElement {
  const t = useTranslations('inbox.resolve')
  const tAll = useTranslations()
  const { storeId } = useStore()
  const snippets = useSnippets(storeId, true)
  const { resolve } = useConversationActions(storeId, conversationId)
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
        ...(sendsClosing
          ? { closing: { snippetId: chosenId, idempotencyKey: attempt.keyFor(chosenId) } }
          : {})
      })
      .then(() => {
        toast.success(t('resolved'))
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
            <p className="text-muted-foreground text-sm">{t('noSnippets')}</p>
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
          {tAll(`errors.${errorCodeOf(resolve.error)}`)}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="submit" disabled={resolve.isPending || isMissingClosing}>
          {resolve.isPending ? t('resolving') : t('confirm')}
        </Button>
      </DialogFooter>
    </form>
  )
}
