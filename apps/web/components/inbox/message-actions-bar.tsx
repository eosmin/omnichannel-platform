'use client'

import {
  CornerUpLeft,
  Ellipsis,
  Eye,
  History,
  Pencil,
  RotateCcw,
  SmilePlus,
  Trash2
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { MessageView } from '@platform/api-client'
import { AuthorType, QUICK_REACTIONS } from '@platform/core/domain'

import { failureStateOf } from '../../lib/inbox/failure-state'
import type { MessageActions } from '../../lib/inbox/message-actions'
import { useMessageMutations } from '../../lib/inbox/use-message-actions'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import { useReplyTarget } from './reply-target'

// The dialogs load when one is first opened: the inbox has a script budget
// (apps/web-e2e/lighthouse/budgets.ts) and most messages are never edited or deleted
const CustomReactionDialog = dynamic(
  () => import('./message-action-dialogs').then(module => module.CustomReactionDialog),
  { ssr: false }
)
const DeleteMessageDialog = dynamic(
  () => import('./message-action-dialogs').then(module => module.DeleteMessageDialog),
  { ssr: false }
)
const DeletedContentDialog = dynamic(
  () => import('./message-action-dialogs').then(module => module.DeletedContentDialog),
  { ssr: false }
)
const DiscardMessageDialog = dynamic(
  () => import('./message-action-dialogs').then(module => module.DiscardMessageDialog),
  { ssr: false }
)
const ResendAgainDialog = dynamic(
  () => import('./message-action-dialogs').then(module => module.ResendAgainDialog),
  { ssr: false }
)
const EditMessageDialog = dynamic(
  () => import('./message-action-dialogs').then(module => module.EditMessageDialog),
  { ssr: false }
)
const RevisionsDialog = dynamic(
  () => import('./message-action-dialogs').then(module => module.RevisionsDialog),
  { ssr: false }
)

type OpenDialog =
  'edit' | 'delete' | 'revisions' | 'deleted' | 'reaction' | 'discard' | 'resend' | null

// What an agent can do to one message, beside its bubble: visible on hover and on keyboard focus (and
// always on a screen that cannot hover). Only the actions the rules allow are drawn; the api checks
// them again.
export function MessageActionsBar({
  message,
  conversationId,
  actions,
  userId,
  authorLabel,
  file,
  replyOnly,
  overlay = false
}: {
  message: MessageView
  conversationId: string
  actions: MessageActions
  userId: string | undefined
  authorLabel: (type: string, id: string | null) => string
  // One file of an album: the bar over its thumbnail answers and reacts to THAT file (and nothing else: the rest
  // of the actions are the message's), and its buttons say which one it is
  file?: { id: string; number: number; total: number }
  // A thumbnail of a native album (the channel took the files as ONE message): the bar answers the message and offers
  // nothing else, because a file of it cannot be reacted to or quoted alone
  replyOnly?: { number: number; total: number } | undefined
  // Drawn over a thumbnail: the bar has a surface of its own, and it shows only when the bar does (a surface
  // outside it was a white square that stayed when the buttons were hidden)
  overlay?: boolean
}): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const errorText = useErrorText()
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const { react, resend } = useMessageMutations(conversationId, message.id, file?.id)
  const { start: startReply } = useReplyTarget()
  const dialogProps = {
    message,
    conversationId,
    ...(file === undefined ? {} : { mediaId: file.id }),
    onOpenChange: (open: boolean): void => setDialog(open ? dialog : null)
  }

  // The reaction of this agent, if there is one: a second tap on the same emoji takes it back
  const mine =
    userId === undefined
      ? undefined
      : message.reactions.find(
          reaction =>
            reaction.authorType === String(AuthorType.AGENT) &&
            reaction.authorId === userId &&
            reaction.mediaId === (file?.id ?? null)
        )?.emoji

  const tell = (promise: Promise<unknown>): void => {
    promise.catch((error: unknown) => toast.error(errorText(error)))
  }
  const onThumbnail = file !== undefined || replyOnly !== undefined
  const hasMore =
    !onThumbnail &&
    (actions.resend ||
      actions.discard ||
      actions.edit ||
      actions.remove ||
      actions.revisions ||
      actions.viewDeleted)

  return (
    <div
      className={cn(
        'flex shrink-0 items-center opacity-0 transition-opacity max-md:opacity-100 pointer-coarse:opacity-100',
        overlay && 'bg-background/90 rounded-md shadow-sm',
        // The thumbnail is its own group: hovering the bubble does not light the bars of all its files
        !onThumbnail
          ? 'group-focus-within:opacity-100 group-hover:opacity-100'
          : 'group-focus-within/file:opacity-100 group-hover/file:opacity-100'
      )}
    >
      {actions.reply ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-7 pointer-coarse:size-10"
          aria-label={
            file !== undefined
              ? t('replyFile', file)
              : replyOnly !== undefined
                ? t('replyAlbum', replyOnly)
                : t('reply')
          }
          onClick={() =>
            startReply({
              messageId: message.id,
              type: message.type,
              content: message.content,
              author: authorLabel(message.authorType, message.authorId),
              ...(file === undefined
                ? {}
                : { mediaId: file.id, file: { number: file.number, total: file.total } })
            })
          }
        >
          <CornerUpLeft aria-hidden className="size-4" />
        </Button>
      ) : null}
      {actions.react && replyOnly === undefined ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 pointer-coarse:size-10"
              aria-label={file === undefined ? t('react') : t('reactFile', file)}
            >
              <SmilePlus aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="min-w-0" align="center">
            <div role="group" aria-label={t('quickReactions')} className="flex gap-0.5">
              {QUICK_REACTIONS.map(emoji => (
                <DropdownMenuItem
                  key={emoji}
                  aria-label={mine === emoji ? t('removeReactionWith', { emoji }) : emoji}
                  className={cn('size-8 justify-center p-0 text-lg', mine === emoji && 'bg-accent')}
                  onSelect={() => tell(react.mutateAsync(mine === emoji ? null : emoji))}
                >
                  {emoji}
                </DropdownMenuItem>
              ))}
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={() => setDialog('reaction')}>
              {t('otherEmoji')}
            </DropdownMenuItem>
            {mine === undefined ? null : (
              <DropdownMenuItem onSelect={() => tell(react.mutateAsync(null))}>
                {t('removeReaction')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {hasMore ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7 pointer-coarse:size-10"
              aria-label={t('more')}
            >
              <Ellipsis aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.resend ? (
              <DropdownMenuItem
                onSelect={() =>
                  // A reply that may have gone out asks first: the customer may receive it twice
                  failureStateOf(message) === 'unconfirmed'
                    ? setDialog('resend')
                    : tell(resend.mutateAsync())
                }
              >
                <RotateCcw aria-hidden className="size-4" />
                {t('resend')}
              </DropdownMenuItem>
            ) : null}
            {actions.discard ? (
              <DropdownMenuItem onSelect={() => setDialog('discard')}>
                <Trash2 aria-hidden className="size-4" />
                {t('discard')}
              </DropdownMenuItem>
            ) : null}
            {actions.edit ? (
              <DropdownMenuItem onSelect={() => setDialog('edit')}>
                <Pencil aria-hidden className="size-4" />
                {t('edit')}
              </DropdownMenuItem>
            ) : null}
            {actions.revisions ? (
              <DropdownMenuItem onSelect={() => setDialog('revisions')}>
                <History aria-hidden className="size-4" />
                {t('revisions')}
              </DropdownMenuItem>
            ) : null}
            {actions.viewDeleted ? (
              <DropdownMenuItem onSelect={() => setDialog('deleted')}>
                <Eye aria-hidden className="size-4" />
                {t('viewDeleted')}
              </DropdownMenuItem>
            ) : null}
            {actions.remove ? (
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => setDialog('delete')}
              >
                <Trash2 aria-hidden className="size-4" />
                {t('delete')}
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {/* Each dialog is drawn only for the action that opens it */}
      {dialog === 'edit' ? <EditMessageDialog {...dialogProps} open /> : null}
      {dialog === 'delete' ? <DeleteMessageDialog {...dialogProps} open /> : null}
      {dialog === 'discard' ? <DiscardMessageDialog {...dialogProps} open /> : null}
      {dialog === 'resend' ? <ResendAgainDialog {...dialogProps} open /> : null}
      {dialog === 'revisions' ? (
        <RevisionsDialog {...dialogProps} open authorLabel={authorLabel} />
      ) : null}
      {dialog === 'deleted' ? <DeletedContentDialog {...dialogProps} open /> : null}
      {dialog === 'reaction' ? <CustomReactionDialog {...dialogProps} open /> : null}
    </div>
  )
}
