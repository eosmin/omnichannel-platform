'use client'

import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import {
  createContext,
  type ReactElement,
  type ReactNode,
  useCallback,
  useContext,
  useId,
  useRef,
  useState
} from 'react'
import { toast } from 'sonner'

import type { DestructiveAction } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import {
  ConfirmationStyles,
  confirmationStyleFor,
  needsDestructiveButton,
  phraseMatches
} from '../../lib/destructive-action'

// The texts arrive already translated: they name the thing being destroyed, which only the
// caller knows
export interface DestructiveActionRequest {
  title: string
  description: string
  confirmLabel: string
  // The phrase the user must type; required by the actions of the critical tier
  phrase?: string
  // What to do once the user agrees (or at once, for a low-tier action). If it rejects, the user
  // sees a generic error toast: the caller shows anything more specific itself
  onConfirm: () => Promise<void> | void
  // A low-tier action runs at once and, once it has succeeded, offers this to take it back
  onUndo?: () => Promise<void> | void
  undoMessage?: string
}

type RunDestructiveAction = (action: DestructiveAction, request: DestructiveActionRequest) => void

const DestructiveActionContext = createContext<RunDestructiveAction | null>(null)

export function useDestructiveAction(): RunDestructiveAction {
  const run = useContext(DestructiveActionContext)
  if (run === null) throw new Error('useDestructiveAction needs a DestructiveActionProvider')
  return run
}

// The dialog is drawn on the first request, not with every page: its primitives stay out of the
// chunk that all of them share
const ConfirmationDialog = dynamic(
  () => import('./confirmation-dialog').then(module => module.ConfirmationDialog),
  { ssr: false }
)

export interface DialogRequest {
  request: DestructiveActionRequest
  requiresPhrase: boolean
  destructive: boolean
}

export function DestructiveActionProvider({ children }: { children: ReactNode }): ReactElement {
  const t = useTranslations()
  // The request outlives the dialog: it keeps its text on screen while the dialog fades out
  const [dialog, setDialog] = useState<DialogRequest | null>(null)
  const [open, setOpen] = useState(false)
  // A ref as well, because two calls in the same tick both read the same state
  const openRef = useRef(false)
  const busyRef = useRef(false)
  const phraseId = useId()
  const [busy, setBusy] = useState(false)
  const [typed, setTyped] = useState('')

  // Runs what the user agreed to; a failure becomes a toast instead of an unhandled rejection
  const attempt = useCallback(
    async (work: () => Promise<void> | void): Promise<boolean> => {
      try {
        await work()
        return true
      } catch {
        toast.error(t(`errors.${ErrorCodes.INTERNAL_ERROR}`))
        return false
      }
    },
    [t]
  )

  const runAtOnce = useCallback(
    async (request: DestructiveActionRequest): Promise<void> => {
      const done = await attempt(request.onConfirm)
      const { onUndo, undoMessage } = request
      if (done && onUndo && undoMessage) {
        toast(undoMessage, {
          action: { label: t('common.undo'), onClick: () => void attempt(onUndo) }
        })
      }
    },
    [attempt, t]
  )

  const run = useCallback<RunDestructiveAction>(
    (action, request) => {
      const style = confirmationStyleFor(action)
      if (style === ConfirmationStyles.UNDO_TOAST) {
        void runAtOnce(request)
        return
      }
      // A dialog already asks something: a second request must not replace it under the user's hand
      if (openRef.current) return
      if (style === ConfirmationStyles.TYPED_PHRASE && !request.phrase?.trim()) {
        throw new Error(`The action ${action} is critical and needs a phrase to type`)
      }
      setTyped('')
      setDialog({
        request,
        requiresPhrase: style === ConfirmationStyles.TYPED_PHRASE,
        destructive: needsDestructiveButton(action)
      })
      openRef.current = true
      setOpen(true)
    },
    [runAtOnce]
  )

  const phrase = dialog?.request.phrase
  const canConfirm =
    !dialog?.requiresPhrase || (phrase !== undefined && phraseMatches(typed, phrase))

  const confirm = async (): Promise<void> => {
    // The ref, because a second click before the next render still sees busy as false
    if (dialog === null || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    const done = await attempt(dialog.request.onConfirm)
    busyRef.current = false
    setBusy(false)
    // After a failure the dialog stays open, with what the user typed, so that they can try again
    if (done) close()
  }

  const close = (): void => {
    openRef.current = false
    setOpen(false)
  }

  return (
    <DestructiveActionContext.Provider value={run}>
      {children}
      {dialog === null ? null : (
        <ConfirmationDialog
          open={open}
          busy={busy}
          dialog={dialog}
          typed={typed}
          phraseId={phraseId}
          canConfirm={canConfirm}
          onTyped={setTyped}
          onConfirm={() => void confirm()}
          onOpenChange={next => {
            if (busy) return
            if (next) setOpen(true)
            else close()
          }}
        />
      )}
    </DestructiveActionContext.Provider>
  )
}
