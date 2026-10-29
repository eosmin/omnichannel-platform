'use client'

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
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle
} from '../ui/alert-dialog'
import { buttonVariants } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'

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

interface DialogRequest {
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
      <AlertDialog
        open={open}
        onOpenChange={next => {
          if (busy) return
          if (next) setOpen(true)
          else close()
        }}
      >
        <AlertDialogContent aria-busy={busy}>
          <AlertDialogHeader>
            <AlertDialogTitle>{dialog?.request.title}</AlertDialogTitle>
            <AlertDialogDescription>{dialog?.request.description}</AlertDialogDescription>
          </AlertDialogHeader>
          {dialog?.requiresPhrase && phrase !== undefined ? (
            <div className="grid gap-2">
              <Label htmlFor={phraseId}>{t('confirm.phraseLabel')}</Label>
              <Input
                id={phraseId}
                autoComplete="off"
                value={typed}
                placeholder={phrase}
                onChange={event => setTyped(event.target.value)}
              />
              <p className="text-muted-foreground text-sm">{t('confirm.typePhrase', { phrase })}</p>
            </div>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!canConfirm || busy}
              className={
                dialog?.destructive ? buttonVariants({ variant: 'destructive' }) : undefined
              }
              onClick={event => {
                // Radix closes the dialog on click; it closes here once the work is done
                event.preventDefault()
                void confirm()
              }}
            >
              {dialog?.request.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DestructiveActionContext.Provider>
  )
}
