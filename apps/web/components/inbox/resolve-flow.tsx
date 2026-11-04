'use client'

import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Permissions } from '@platform/core/auth'
import { ResolveUndo } from '@platform/core/domain'

import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { useInboxBehavior, useMessagingWindow } from '../../lib/inbox/use-inbox-data'
import { useWindowState } from '../../lib/inbox/use-window-state'
import { usePushOffer } from '../../lib/push/use-push-offer'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '../ui/dialog'

function ResolveFormLoading(): ReactElement {
  const t = useTranslations('common')
  return (
    <p role="status" className="text-muted-foreground text-sm">
      {t('loading')}
    </p>
  )
}

const ResolveForm = dynamic(() => import('./resolve-form').then(module => module.ResolveForm), {
  loading: () => <ResolveFormLoading />
})

export interface ResolveFlow {
  // False until the settings of the store are read: they decide which of the two flows runs
  isReady: boolean
  // The options dialog is showing: a caller that mounts the flow for one action waits for it to close
  isDialogOpen: boolean
  start: () => void
  // The options dialog, to render once where the flow is used
  dialog: ReactElement
}

// Marking a conversation resolved, the way the store configured it: with the options dialog (closing message, reason) or at once, with a toast that takes it back for ten seconds. The
// closing message is chosen here and sent by the server after the Undo, and only when the messaging
// window is open.
export function useResolveFlow(conversationId: string): ResolveFlow {
  const t = useTranslations('inbox.resolve')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const { storeId, can } = useStore()
  const behavior = useInboxBehavior(storeId)
  const windowState = useWindowState(storeId, conversationId)
  const windowQuery = useMessagingWindow(storeId, conversationId)
  const { resolve, reopen } = useConversationActions(storeId, conversationId)
  const { offer: offerPush } = usePushOffer(storeId)
  const [isDialogOpen, setDialogOpen] = useState(false)

  // The closing message is a reply: it needs the window open and the permission to reply
  const canSendClosing = windowState.kind !== 'closed' && can(Permissions.MESSAGES_SEND)
  const settings = behavior.data

  const start = (): void => {
    if (resolve.isPending) return
    if (settings === undefined) {
      // The settings did not load: say so and ask again, instead of a button that does nothing
      if (behavior.isError) {
        toast.error(errorText(behavior.error))
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
      .mutateAsync(closingSnippetId === null ? {} : { closingSnippetId })
      .then(() => {
        offerPush()
        toast(t('resolved'), {
          duration: ResolveUndo.DURATION_MS,
          action: {
            label: tAll('common.undo'),
            onClick: () =>
              void reopen.mutateAsync().catch((error: unknown) => toast.error(errorText(error)))
          }
        })
      })
      .catch((error: unknown) => toast.error(errorText(error)))
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
    isDialogOpen,
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
              onDone={() => setDialogOpen(false)}
              onCancel={() => setDialogOpen(false)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    )
  }
}
