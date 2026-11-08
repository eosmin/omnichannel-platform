'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { type ReactElement, useState } from 'react'

import type { MessageView } from '@platform/api-client'

import { hasAnyAction, type MessageActions } from '../../lib/inbox/message-actions'
import { messageTimeOptions } from '../../lib/inbox/message-time'
import { useMediaUrls } from '../../lib/media/use-media-urls'
import { useStore } from '../providers/store-context'

import { MediaLightbox } from './media-lightbox'
import { MessageActionsBar } from './message-actions-bar'
import { messageDomId } from './message-bubble'
import { RunImage } from './message-media'
import { ReactionChips } from './reaction-chips'

// Pictures a customer sent one after the other, drawn as one block with a cell for each. Every cell is its own
// message: its hour, its reactions and its menu (reply, react) are its own, and it is the element a quote jumps
// to. The viewer is shared, so the arrows walk the pictures of the block.
export function ImageRun({
  messages,
  showAuthor,
  authorLabel,
  actionsOf,
  conversationId,
  userId
}: {
  messages: readonly MessageView[]
  showAuthor: boolean
  authorLabel: (type: string, id: string | null) => string
  actionsOf: (message: MessageView) => MessageActions
  conversationId: string
  userId: string | undefined
}): ReactElement {
  const t = useTranslations('inbox.thread')
  const format = useFormatter()
  const locale = useLocale()
  // The picture that is open is kept by its message, not by its place: the block can change while it is open
  const [openId, setOpenId] = useState<string | null>(null)
  const first = messages[0]
  return (
    <div className="flex flex-col items-start gap-0.5">
      {showAuthor && first !== undefined ? (
        <p className="text-muted-foreground text-xs">
          <span className="font-medium">{authorLabel(first.authorType, first.authorId)}</span>
        </p>
      ) : null}
      <div
        role="group"
        aria-label={t('imageRun', { count: messages.length })}
        className="grid w-[320px] max-w-[85%] grid-cols-2 gap-1"
      >
        {messages.map(message => {
          const [file] = message.media
          const actions = actionsOf(message)
          return (
            <div
              key={message.id}
              id={messageDomId(message.id)}
              tabIndex={-1}
              className="group focus-visible:ring-ring flex min-w-0 scroll-mt-16 flex-col gap-0.5 rounded-md outline-none focus-visible:ring-2"
            >
              <div className="relative">
                {file === undefined ? null : (
                  <RunImage file={file} onOpen={() => setOpenId(message.id)} />
                )}
                <time
                  dateTime={message.createdAt}
                  className="pointer-events-none absolute right-1 bottom-1 rounded bg-black/60 px-1 text-[11px] text-white"
                >
                  {format.dateTime(new Date(message.createdAt), messageTimeOptions(locale))}
                </time>
                {hasAnyAction(actions) ? (
                  <div className="bg-background/90 absolute top-1 right-1 rounded-md">
                    <MessageActionsBar
                      message={message}
                      conversationId={conversationId}
                      actions={actions}
                      userId={userId}
                      authorLabel={authorLabel}
                    />
                  </div>
                ) : null}
              </div>
              <ReactionChips reactions={message.reactions} authorLabel={authorLabel} />
            </div>
          )
        })}
      </div>
      <RunLightbox messages={messages} openId={openId} onOpenId={setOpenId} />
    </div>
  )
}

// The large variant of the picture that is open; the arrows walk the pictures of the block (the dialog stays open
// while the links of the next one load, so the arrows keep their focus)
function RunLightbox({
  messages,
  openId,
  onOpenId
}: {
  messages: readonly MessageView[]
  openId: string | null
  onOpenId: (id: string | null) => void
}): ReactElement {
  const { storeId } = useStore()
  const index = openId === null ? -1 : messages.findIndex(message => message.id === openId)
  const file = index === -1 ? undefined : messages[index]?.media[0]
  const urls = useMediaUrls(storeId, file?.id ?? '', file !== undefined)
  const step = (by: number): void => {
    if (index === -1) return
    onOpenId(messages[(index + by + messages.length) % messages.length]?.id ?? null)
  }
  return (
    <MediaLightbox
      file={
        file === undefined
          ? null
          : {
              kind: 'image',
              src: urls.data === undefined ? null : (urls.data.variants.full ?? urls.data.url),
              downloadUrl: urls.data?.url ?? '',
              filename: file.filename
            }
      }
      onClose={() => onOpenId(null)}
      onPrevious={messages.length > 1 ? () => step(-1) : undefined}
      onNext={messages.length > 1 ? () => step(1) : undefined}
    />
  )
}
