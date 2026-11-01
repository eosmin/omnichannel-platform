'use client'

import { FileText, Image as ImageIcon, Mic, TriangleAlert, Video } from 'lucide-react'
import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'
import { AuthorType, DeliveryStatus, MessageType } from '@platform/core/domain'

import { knownErrorCode } from '../../lib/error-message'
import { initialsOf } from '../../lib/inbox/customer-label'
import { mentionSegments } from '../../lib/inbox/mention-segments'
import { hasAnyAction, type MessageActions } from '../../lib/inbox/message-actions'
import {
  deliveryTicksOf,
  isFromCustomer,
  type MessageKind,
  messageKindOf
} from '../../lib/inbox/thread-items'
import { cn } from '../../lib/utils'

import { CustomerAvatar } from './customer-avatar'
import { DeliveryTicksIcon } from './delivery-ticks'
import { MessageActionsBar } from './message-actions-bar'
import { MessageMedia } from './message-media'
import { QuotedMessage } from './quoted-message'
import { ReactionChips } from './reaction-chips'
import { SharedLink } from './shared-link'
import { SystemLineView } from './system-line'

const MEDIA_ICONS = {
  [MessageType.IMAGE]: ImageIcon,
  [MessageType.VIDEO]: Video,
  [MessageType.AUDIO]: Mic,
  [MessageType.DOCUMENT]: FileText
} as const
type MediaType = keyof typeof MEDIA_ICONS

const isMediaType = (type: string): type is MediaType => Object.hasOwn(MEDIA_ICONS, type)

// The id the page gives the element of a message, so that a quote can scroll to it
export const messageDomId = (messageId: string): string => `message-${messageId}`

export interface MessageBubbleProps {
  message: MessageView
  showAuthor: boolean
  authorLabel: (type: string, id: string | null) => string
  // The ids of the messages in the loaded part of the thread: a quote links to one of them only
  loadedIds: ReadonlySet<string>
  onJumpTo: (messageId: string) => void
  // What the agent may do to this message; the thread works it out once for each message
  actions: MessageActions
  conversationId: string
  userId: string | undefined
  // The names a note mentions, to highlight them in its text
  mentionNames: readonly string[]
}

// The element a quote scrolls to and focuses has to exist for every kind of message, a line included
export function MessageBubble(props: MessageBubbleProps): ReactElement {
  return (
    <div
      id={messageDomId(props.message.id)}
      tabIndex={-1}
      className="focus-visible:ring-ring scroll-mt-16 rounded-md outline-none focus-visible:ring-2"
    >
      <MessageBody {...props} />
    </div>
  )
}

function MessageBody(props: MessageBubbleProps): ReactElement {
  const { message, authorLabel } = props
  const kind = messageKindOf(message)
  if (kind === 'system') {
    // messageKindOf only says system for a message that has its line; the check is for the types
    return message.system === null ? (
      <NeutralLine message={message} />
    ) : (
      <SystemLineView
        line={message.system}
        createdAt={message.createdAt}
        nameOf={id => authorLabel(AuthorType.AGENT, id)}
      />
    )
  }
  if (kind === 'neutral') return <NeutralLine message={message} />
  return <Bubble {...props} kind={kind} />
}

// A type this page has no bubble for (a location, an order summary, a type of a newer server): a line
// that says what it is, never an empty bubble
function NeutralLine({ message }: { message: MessageView }): ReactElement {
  const t = useTranslations('inbox.thread.neutral')
  const key = ['LOCATION', 'PRODUCT_CARD', 'ORDER_SUMMARY', 'SYSTEM'].includes(message.type)
    ? (message.type as 'LOCATION' | 'PRODUCT_CARD' | 'ORDER_SUMMARY' | 'SYSTEM') // Narrowed by the list
    : 'unknown'
  return (
    <p className="text-muted-foreground py-1 text-center text-xs italic">
      {t(key)}
      {message.content === null || message.content === '' ? null : `: ${message.content}`}
    </p>
  )
}

function Bubble({
  message,
  kind,
  showAuthor,
  authorLabel,
  loadedIds,
  onJumpTo,
  actions,
  conversationId,
  userId,
  mentionNames
}: MessageBubbleProps & { kind: Exclude<MessageKind, 'system' | 'neutral'> }): ReactElement {
  const t = useTranslations('inbox.thread')
  const tAll = useTranslations()
  const format = useFormatter()
  const isCustomer = isFromCustomer(message)
  const isNote = kind === 'note'
  const author = authorLabel(message.authorType, message.authorId)
  const ticks = deliveryTicksOf(message)
  const time = format.dateTime(new Date(message.createdAt), { timeStyle: 'short' })
  const reason = (code: string | null): string | null =>
    code === null ? null : tAll(`errors.${knownErrorCode(code)}`)

  const problems = [
    message.deleteStatus === String(DeliveryStatus.QUEUED) ? t('deleting') : null,
    message.deleteStatus === String(DeliveryStatus.FAILED)
      ? joinReason(t('deleteFailed'), reason(message.deleteError))
      : null,
    message.pendingEdit && message.editStatus !== String(DeliveryStatus.FAILED)
      ? t('editPending')
      : null,
    message.editStatus === String(DeliveryStatus.FAILED)
      ? joinReason(t('editFailed'), reason(message.editError))
      : null,
    ticks === DeliveryStatus.FAILED
      ? message.deliveryError === null
        ? t('ticks.failed')
        : t('failedWithReason', { reason: tAll(`errors.${knownErrorCode(message.deliveryError)}`) })
      : null
  ].filter((text): text is string => text !== null)

  return (
    <div className={cn('flex flex-col gap-0.5', isCustomer ? 'items-start' : 'items-end')}>
      {showAuthor ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          {isNote ? (
            <CustomerAvatar
              avatarUrl={null}
              initials={initialsOf({ kind: 'name', text: author })}
              className="size-5 text-[10px]"
            />
          ) : null}
          <span className="font-medium">{author}</span>
        </p>
      ) : null}
      <div
        className={cn(
          'group flex max-w-[85%] items-start gap-1 md:max-w-[70%]',
          !isCustomer && 'flex-row-reverse'
        )}
      >
        <div
          className={cn(
            'flex min-w-0 flex-col gap-1 rounded-lg px-3 py-2 text-sm',
            isCustomer && 'bg-card border',
            !isCustomer && !isNote && 'bg-secondary text-secondary-foreground',
            isNote && 'bg-note text-note-foreground border-note-border border border-dashed'
          )}
        >
          {isNote ? <p className="text-xs font-semibold">{t('internalNote')}</p> : null}
          {message.replyToMessageId === null ? null : (
            <QuotedMessage
              quote={message.replyTo}
              replyTo={message.replyToMessageId}
              authorName={
                message.replyTo === null
                  ? null
                  : authorLabel(message.replyTo.authorType, message.replyTo.authorId)
              }
              onJump={loadedIds.has(message.replyToMessageId) ? onJumpTo : undefined}
            />
          )}
          <Content
            message={message}
            kind={kind}
            authorLabel={authorLabel}
            mentionNames={isNote ? mentionNames : NO_NAMES}
          />
          {message.attachmentUrl === null ? null : <SharedLink url={message.attachmentUrl} />}
          <p className="text-muted-foreground flex items-center justify-end gap-1.5 text-xs">
            {message.editedAt === null ? null : (
              <span>
                {isNote && message.editedById !== null
                  ? t('editedBy', {
                      name: authorLabel(message.editedByType ?? '', message.editedById)
                    })
                  : t('edited')}
              </span>
            )}
            <time dateTime={message.createdAt}>{time}</time>
            {ticks === null ? null : <DeliveryTicksIcon status={ticks} />}
          </p>
        </div>
        {hasAnyAction(actions) ? (
          <MessageActionsBar
            message={message}
            conversationId={conversationId}
            actions={actions}
            userId={userId}
            authorLabel={authorLabel}
          />
        ) : null}
      </div>
      {problems.map(problem => (
        <p key={problem} role="status" className="text-destructive text-xs">
          {problem}
        </p>
      ))}
      <ReactionChips reactions={message.reactions} authorLabel={authorLabel} />
    </div>
  )
}

const NO_NAMES: readonly string[] = []

const joinReason = (what: string, reason: string | null): string =>
  reason === null ? what : `${what}: ${reason}`

function Content({
  message,
  kind,
  authorLabel,
  mentionNames
}: {
  message: MessageView
  kind: Exclude<MessageKind, 'system' | 'neutral'>
  authorLabel: (type: string, id: string | null) => string
  mentionNames: readonly string[]
}): ReactElement | null {
  const t = useTranslations('inbox.thread')
  if (kind === 'deleted') {
    const who =
      message.deletedByType === String(AuthorType.CUSTOMER)
        ? t('deletedByCustomer')
        : message.deletedByType === String(AuthorType.AGENT)
          ? t('deletedByAgent', { name: authorLabel(AuthorType.AGENT, message.deletedById) })
          : message.deletedByType === String(AuthorType.EXTERNAL)
            ? t('deletedByOwner')
            : t('deletedGeneric')
    return <p className="text-muted-foreground italic">{who}</p>
  }
  const text = message.content === null || message.content === '' ? null : message.content
  const MediaIcon = isMediaType(message.type) ? MEDIA_ICONS[message.type] : null
  const hasFiles = message.media.length > 0 || message.unavailableFiles.length > 0
  return (
    <>
      {hasFiles ? (
        <MessageMedia files={message.media} unavailable={message.unavailableFiles} />
      ) : null}
      {MediaIcon === null || !isMediaType(message.type) || hasFiles ? null : (
        <p className="flex items-center gap-1.5 text-xs font-medium">
          <MediaIcon aria-hidden className="size-4" />
          {t(`mediaLabel.${message.type}`)}
        </p>
      )}
      {message.type === String(MessageType.TEMPLATE) ? (
        <p className="text-muted-foreground text-xs">{t('templateLabel')}</p>
      ) : null}
      {text === null ? null : (
        <p className="break-words whitespace-pre-wrap">
          {mentionSegments(text, mentionNames).map((segment, index) =>
            segment.isMention ? (
              <strong key={index} className="bg-note-border/40 rounded px-0.5 font-semibold">
                {segment.text}
              </strong>
            ) : (
              segment.text
            )
          )}
        </p>
      )}
      {message.captionFailed ? (
        <p role="status" className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <TriangleAlert aria-hidden className="size-3.5 shrink-0" />
          {t('captionFailed')}
        </p>
      ) : null}
    </>
  )
}
