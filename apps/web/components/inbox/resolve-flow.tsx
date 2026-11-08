'use client'

import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useCallback, useLayoutEffect, useRef, useState } from 'react'

import { ClientPermissions } from '@platform/core/auth'
import { ResolveUndo } from '@platform/core/domain'

import { useConversationActions } from '../../lib/inbox/use-conversation-actions'
import { useInboxBehavior, useMessagingWindow } from '../../lib/inbox/use-inbox-data'
import { useWindowState } from '../../lib/inbox/use-window-state'
import { usePushOffer } from '../../lib/push/use-push-offer'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useMountedOnce } from '../../lib/use-mounted-once'
import { useStore } from '../providers/store-context'

// The options dialog (the dialog primitive and the form) is downloaded the first time it opens
const ResolveDialog = dynamic(() => import('./resolve-dialog'), { ssr: false })

// At once, with a toast to undo; or asking first for the closing message and the reason
export const ResolveMode = { NOW: 'now', OPTIONS: 'options' } as const
export type ResolveModeType = (typeof ResolveMode)[keyof typeof ResolveMode]

// The way the store chose, from its settings (the way a row shows before the flow of a conversation exists)
export function resolveModeOf(
  settings: { resolveShowOptions: boolean } | undefined
): ResolveModeType {
  return settings?.resolveShowOptions === true ? ResolveMode.OPTIONS : ResolveMode.NOW
}

// The way the arrow of the button and `Shift+E` offer: the one the main button does not take
export function otherResolveMode(mode: ResolveModeType): ResolveModeType {
  return mode === ResolveMode.NOW ? ResolveMode.OPTIONS : ResolveMode.NOW
}

export interface ResolveFlow {
  // False until the settings of the store are read: they decide which of the two flows runs
  isReady: boolean
  // The options dialog is showing: a caller that mounts the flow for one action waits for it to close
  isDialogOpen: boolean
  // What the main button and the key `e` do: the way the store chose (see `ResolveMode`)
  defaultMode: ResolveModeType
  // The main action, the way the store chose
  start: () => void
  // One of the two ways, whatever the store chose: the arrow of the button and `Shift+E` offer the other
  startWith: (mode: ResolveModeType) => void
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
  const { resolve, undoResolve } = useConversationActions(storeId, conversationId)
  const { offer: offerPush } = usePushOffer(storeId)
  const [isDialogOpen, setDialogOpen] = useState(false)
  const isDialogMounted = useMountedOnce(isDialogOpen)

  // The closing message is a reply: it needs the window open and the permission to reply
  const canSendClosing = windowState.kind !== 'closed' && can(ClientPermissions.MESSAGES_SEND)
  const settings = behavior.data

  const startWith = (mode: ResolveModeType): void => {
    if (resolve.isPending) return
    if (settings === undefined) {
      // The settings did not load: say so and ask again, instead of a button that does nothing
      if (behavior.isError) {
        toast.error(errorText(behavior.error))
        void behavior.refetch()
      }
      return
    }
    if (mode === ResolveMode.OPTIONS) {
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
              void undoResolve
                .mutateAsync()
                .catch((error: unknown) => toast.error(errorText(error)))
          }
        })
      })
      .catch((error: unknown) => toast.error(errorText(error)))
  }

  const defaultMode = resolveModeOf(settings)
  const start = (): void => startWith(defaultMode)

  // The same functions for the life of the hook: the header and the composer hold them in a context
  // A layout effect, so that it has run before any effect of a component that calls `start` when the settings
  // arrive (those run after it, with the settings that `start` has to read)
  const latest = useRef({ start, startWith })
  useLayoutEffect(() => {
    latest.current = { start, startWith }
  })
  const stableStart = useCallback((): void => latest.current.start(), [])
  const stableStartWith = useCallback(
    (mode: ResolveModeType): void => latest.current.startWith(mode),
    []
  )

  return {
    // Ready once the settings and the window are known (a failed read does not block: the click then
    // says what failed and reads again)
    isReady: !behavior.isPending && !windowQuery.isPending,
    isDialogOpen,
    defaultMode,
    start: stableStart,
    startWith: stableStartWith,
    dialog: isDialogMounted ? (
      <ResolveDialog
        open={isDialogOpen}
        onOpenChange={setDialogOpen}
        conversationId={conversationId}
        settings={settings}
        canSendClosing={canSendClosing}
      />
    ) : (
      <></>
    )
  }
}
