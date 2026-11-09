'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { type FormEvent, type ReactElement, useEffect, useState } from 'react'

import type { MessageView } from '@platform/api-client'
import { InboundLimits, isWholeEmoji, MessageLimits, MessageType } from '@platform/core/domain'

import { failureStateOf } from '../../lib/inbox/failure-state'
import { currentNoteOf } from '../../lib/inbox/stale-note'
import {
  useDeletedContent,
  useMessageMutations,
  useRevisions
} from '../../lib/inbox/use-message-actions'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
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

export interface MessageDialogProps {
  message: MessageView
  conversationId: string
  // The file of an album a reaction goes under
  mediaId?: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

const isNote = (message: MessageView): boolean => message.type === String(MessageType.INTERNAL_NOTE)

// The whole new text. A note is the team's own and changes at once; a reply the customer has changes
// only when the channel takes the edit, and the bubble says so until then.
export function EditMessageDialog(props: MessageDialogProps): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{isNote(props.message) ? t('editNoteTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>
            {isNote(props.message) ? t('editNoteDescription') : t('editDescription')}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open: it starts from the text the message has now */}
        {props.open ? <EditForm {...props} /> : null}
      </DialogContent>
    </Dialog>
  )
}

function EditForm({ message, conversationId, onOpenChange }: MessageDialogProps): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const { edit } = useMessageMutations(conversationId, message.id)
  const [draft, setDraft] = useState(message.content ?? '')
  // The version the note was read at; a refused save brings the one it has now
  const [version, setVersion] = useState(message.version)
  // The text the draft is compared with: the one read when the dialog opened, then the one a refused
  // save brought (the thread is read again meanwhile, so the prop cannot be the baseline)
  const [base, setBase] = useState(message.content ?? '')
  const [isStale, setStale] = useState(false)

  const content = draft.trim()
  const canSave =
    content !== '' &&
    content !== base.trim() &&
    content.length <= MessageLimits.CONTENT_MAX_LENGTH &&
    !edit.isPending

  function submit(event: FormEvent): void {
    event.preventDefault()
    if (!canSave) return
    setStale(false)
    // A promise, not the callbacks of mutate: those do not run if the agent moves on before the answer
    edit
      .mutateAsync({ content, ...(isNote(message) ? { version } : {}) })
      .then(() => onOpenChange(false))
      .catch((error: unknown) => {
        const current = currentNoteOf(error)
        if (current === null) return // The error shows in the dialog, from the state of the mutation
        // Someone saved first: their text is shown, and saving again is a choice made after reading it
        setDraft(current.content)
        setVersion(current.version)
        setBase(current.content)
        setStale(true)
      })
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <Label htmlFor={`edit-${message.id}`} className="sr-only">
        {t('editLabel')}
      </Label>
      <Textarea
        id={`edit-${message.id}`}
        value={draft}
        rows={5}
        maxLength={MessageLimits.CONTENT_MAX_LENGTH}
        onChange={event => setDraft(event.target.value)}
        autoFocus
      />
      {isStale ? (
        <p role="alert" className="text-destructive text-sm">
          {t('stale')}
        </p>
      ) : edit.isError ? (
        <p role="alert" className="text-destructive text-sm">
          {errorText(edit.error)}
        </p>
      ) : null}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
          {tAll('common.cancel')}
        </Button>
        <Button type="submit" disabled={!canSave}>
          {t('save')}
        </Button>
      </DialogFooter>
    </form>
  )
}

// Deleting is for everyone and cannot be taken back, so it asks first
export function DeleteMessageDialog({
  message,
  conversationId,
  open,
  onOpenChange
}: MessageDialogProps): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const { remove } = useMessageMutations(conversationId, message.id)
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
          <AlertDialogDescription>
            {isNote(message) ? t('deleteNoteDescription') : t('deleteDescription')}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tAll('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={remove.isPending}
            onClick={event => {
              // The dialog stays until the api answers: a refusal is told here, not behind a closed dialog
              event.preventDefault()
              remove
                .mutateAsync()
                .then(() => onOpenChange(false))
                .catch((error: unknown) => {
                  toast.error(errorText(error))
                  onOpenChange(false)
                })
            }}
          >
            {t('delete')}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// One step of confirmation for an action on a failed reply (discard, send again with a warning). The dialog
// stays until the api answers, so a refusal is told here; and it closes by itself if the reply is no longer
// in the state it was opened for (another agent acted, the thread was read again).
function ConfirmFailedReplyDialog({
  message,
  open,
  onOpenChange,
  stillApplies,
  title,
  description,
  actionLabel,
  run
}: Pick<MessageDialogProps, 'message' | 'open' | 'onOpenChange'> & {
  stillApplies: boolean
  title: string
  description: string
  actionLabel: string
  run: { isPending: boolean; mutateAsync: () => Promise<unknown> }
}): ReactElement {
  const errorText = useErrorText()
  const tAll = useTranslations()
  useEffect(() => {
    if (open && !stillApplies) onOpenChange(false)
  }, [open, stillApplies, onOpenChange, message.id])
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{tAll('common.cancel')}</AlertDialogCancel>
          <AlertDialogAction
            disabled={run.isPending}
            onClick={event => {
              event.preventDefault()
              run
                .mutateAsync()
                .then(() => onOpenChange(false))
                .catch((error: unknown) => {
                  toast.error(errorText(error))
                  onOpenChange(false)
                })
            }}
          >
            {actionLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

// A reply known not to have reached the customer is given up: it leaves the thread for the whole team.
// The api checks again; a 409 says the screen was out of date and the thread is read again.
export function DiscardMessageDialog(props: MessageDialogProps): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const { discard } = useMessageMutations(props.conversationId, props.message.id)
  return (
    <ConfirmFailedReplyDialog
      {...props}
      stillApplies={failureStateOf(props.message) === 'definitive'}
      title={t('discardTitle')}
      description={t('discardDescription')}
      actionLabel={t('discard')}
      run={discard}
    />
  )
}

// A reply that may have reached the customer can be sent again, with the warning that they may get it twice
export function ResendAgainDialog(props: MessageDialogProps): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const { resend } = useMessageMutations(props.conversationId, props.message.id)
  return (
    <ConfirmFailedReplyDialog
      {...props}
      stillApplies={failureStateOf(props.message) === 'unconfirmed'}
      title={t('resendTitle')}
      description={t('resendDuplicateDescription')}
      actionLabel={t('resendAnyway')}
      run={resend}
    />
  )
}

// The earlier texts of an edited note, newest first, with who changed each into the next one
export function RevisionsDialog({
  message,
  open,
  onOpenChange,
  authorLabel
}: MessageDialogProps & {
  authorLabel: (type: string, id: string | null) => string
}): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const format = useFormatter()
  const revisions = useRevisions(message.id, open)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('revisionsTitle')}</DialogTitle>
          <DialogDescription>{t('revisionsDescription')}</DialogDescription>
        </DialogHeader>
        {revisions.isPending ? (
          <p role="status" className="text-muted-foreground text-sm">
            {tAll('common.loading')}
          </p>
        ) : revisions.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(revisions.error)}
          </p>
        ) : revisions.data.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noRevisions')}</p>
        ) : (
          <ol className="flex max-h-80 flex-col gap-3 overflow-y-auto">
            {revisions.data.map(revision => (
              <li key={revision.version} className="bg-muted flex flex-col gap-1 rounded-md p-3">
                <p className="text-muted-foreground text-xs">
                  {t('revisionBy', {
                    name: authorLabel(revision.editedByType, revision.editedById),
                    time: format.dateTime(new Date(revision.createdAt), {
                      dateStyle: 'medium',
                      timeStyle: 'short'
                    })
                  })}
                </p>
                <p className="text-sm break-words whitespace-pre-wrap">{revision.content}</p>
              </li>
            ))}
          </ol>
        )}
      </DialogContent>
    </Dialog>
  )
}

// The text of a message the customer deleted. Every read is audited, so it is asked for when the
// dialog opens and not kept.
export function DeletedContentDialog({
  message,
  open,
  onOpenChange
}: MessageDialogProps): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const errorText = useErrorText()
  const tAll = useTranslations()
  const content = useDeletedContent(message.id, open)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deletedContentTitle')}</DialogTitle>
          <DialogDescription>{t('deletedContentDescription')}</DialogDescription>
        </DialogHeader>
        {content.isPending ? (
          <p role="status" className="text-muted-foreground text-sm">
            {tAll('common.loading')}
          </p>
        ) : content.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorText(content.error)}
          </p>
        ) : content.data.content === null || content.data.content === '' ? (
          <p className="text-muted-foreground text-sm">{t('noDeletedContent')}</p>
        ) : (
          <p className="bg-muted max-h-80 overflow-y-auto rounded-md p-3 text-sm break-words whitespace-pre-wrap">
            {content.data.content}
          </p>
        )}
      </DialogContent>
    </Dialog>
  )
}

// Any emoji, for the one the quick row does not have: typed, pasted or from the system picker
export function CustomReactionDialog({
  message,
  conversationId,
  mediaId,
  open,
  onOpenChange
}: MessageDialogProps): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const errorText = useErrorText()
  const { react } = useMessageMutations(conversationId, message.id, mediaId)
  const [value, setValue] = useState('')
  const emoji = value.trim()
  const isValid = isWholeEmoji(emoji, InboundLimits.EMOJI_MAX_LENGTH)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('customReactionTitle')}</DialogTitle>
          <DialogDescription>{t('customReactionDescription')}</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={event => {
            event.preventDefault()
            if (!isValid || react.isPending) return
            react
              .mutateAsync(emoji)
              .then(() => {
                setValue('')
                onOpenChange(false)
              })
              .catch(() => undefined)
          }}
        >
          <Label htmlFor={`reaction-${message.id}`}>{t('customReactionLabel')}</Label>
          <Input
            id={`reaction-${message.id}`}
            value={value}
            onChange={event => setValue(event.target.value)}
            autoFocus
            autoComplete="off"
          />
          {react.isError ? (
            <p role="alert" className="text-destructive text-sm">
              {errorText(react.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={!isValid || react.isPending}>
              {t('react')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
