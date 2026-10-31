'use client'

import { Ellipsis, Eye, History, Pencil, RotateCcw, SmilePlus, Trash2 } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'
import { toast } from 'sonner'

import type { MessageView } from '@platform/api-client'
import { AuthorType, QUICK_REACTIONS } from '@platform/core/domain'

import { errorCodeOf } from '../../lib/error-message'
import type { MessageActions } from '../../lib/inbox/message-actions'
import { useMessageMutations } from '../../lib/inbox/use-message-actions'
import { cn } from '../../lib/utils'
import { Button } from '../ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '../ui/dropdown-menu'

import {
  CustomReactionDialog,
  DeleteMessageDialog,
  DeletedContentDialog,
  EditMessageDialog,
  RevisionsDialog
} from './message-action-dialogs'

type OpenDialog = 'edit' | 'delete' | 'revisions' | 'deleted' | 'reaction' | null

// What an agent can do to one message, beside its bubble: visible on hover and on keyboard focus (and
// always on a screen that cannot hover). Only the actions the rules allow are drawn; the api checks
// them again.
export function MessageActionsBar({
  message,
  conversationId,
  actions,
  userId,
  authorLabel
}: {
  message: MessageView
  conversationId: string
  actions: MessageActions
  userId: string | undefined
  authorLabel: (type: string, id: string | null) => string
}): ReactElement {
  const t = useTranslations('inbox.thread.actions')
  const tAll = useTranslations()
  const [dialog, setDialog] = useState<OpenDialog>(null)
  const { react, resend } = useMessageMutations(conversationId, message.id)
  const dialogProps = {
    message,
    conversationId,
    onOpenChange: (open: boolean): void => setDialog(open ? dialog : null)
  }

  // The reaction of this agent, if there is one: a second tap on the same emoji takes it back
  const mine =
    userId === undefined
      ? undefined
      : message.reactions.find(
          reaction =>
            reaction.authorType === String(AuthorType.AGENT) && reaction.authorId === userId
        )?.emoji

  const tell = (promise: Promise<unknown>): void => {
    promise.catch((error: unknown) => toast.error(tAll(`errors.${errorCodeOf(error)}`)))
  }
  const hasMore =
    actions.resend || actions.edit || actions.remove || actions.revisions || actions.viewDeleted

  return (
    <div className="flex shrink-0 items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 pointer-coarse:opacity-100">
      {actions.react ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="size-7"
              aria-label={t('react')}
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
              className="size-7"
              aria-label={t('more')}
            >
              <Ellipsis aria-hidden className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {actions.resend ? (
              <DropdownMenuItem onSelect={() => tell(resend.mutateAsync())}>
                <RotateCcw aria-hidden className="size-4" />
                {t('resend')}
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
      {dialog === 'revisions' ? (
        <RevisionsDialog {...dialogProps} open authorLabel={authorLabel} />
      ) : null}
      {dialog === 'deleted' ? <DeletedContentDialog {...dialogProps} open /> : null}
      {dialog === 'reaction' ? <CustomReactionDialog {...dialogProps} open /> : null}
    </div>
  )
}
