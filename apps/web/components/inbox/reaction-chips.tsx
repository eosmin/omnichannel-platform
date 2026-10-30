'use client'

import { Clock, TriangleAlert } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { type ReactElement, useId, useState } from 'react'

import type { ReactionView } from '@platform/api-client'
import { DeliveryStatus } from '@platform/core/domain'

import { knownErrorCode } from '../../lib/error-message'
import { cn } from '../../lib/utils'

interface EmojiGroup {
  emoji: string
  reactions: ReactionView[]
}

// Same emoji, one chip with its count, in the order the first of each was left
function groupByEmoji(reactions: readonly ReactionView[]): EmojiGroup[] {
  const groups = new Map<string, EmojiGroup>()
  for (const reaction of reactions) {
    const group = groups.get(reaction.emoji) ?? { emoji: reaction.emoji, reactions: [] }
    group.reactions.push(reaction)
    groups.set(reaction.emoji, group)
  }
  return [...groups.values()]
}

// The emoji in the corner of the message it was left on, as chips with a count. Who reacted shows
// when the chip is opened (a click or tap, and from the keyboard). A reaction of an agent that the
// channel has not taken yet says so, and one that it refused says why.
export function ReactionChips({
  reactions,
  authorLabel
}: {
  reactions: readonly ReactionView[]
  authorLabel: (type: string, id: string | null) => string
}): ReactElement | null {
  const t = useTranslations('inbox.thread')
  const tAll = useTranslations()
  const [openEmoji, setOpenEmoji] = useState<string | null>(null)
  const detailId = useId()
  if (reactions.length === 0) return null

  function stateOf(reaction: ReactionView): string | null {
    if (reaction.deliveryStatus === String(DeliveryStatus.QUEUED)) return t('reactions.pending')
    if (reaction.deliveryStatus !== String(DeliveryStatus.FAILED)) return null
    return reaction.deliveryError === null
      ? t('reactions.failed')
      : `${t('reactions.failed')}: ${tAll(`errors.${knownErrorCode(reaction.deliveryError)}`)}`
  }

  return (
    <ul aria-label={t('reactions.group')} className="flex flex-wrap gap-1">
      {groupByEmoji(reactions).map(group => {
        const isOpen = openEmoji === group.emoji
        const hasProblem = group.reactions.some(reaction => stateOf(reaction) !== null)
        return (
          <li key={group.emoji} className="flex flex-col items-start">
            <button
              type="button"
              aria-expanded={isOpen}
              aria-controls={isOpen ? detailId : undefined}
              onClick={() => setOpenEmoji(isOpen ? null : group.emoji)}
              className={cn(
                'bg-card focus-visible:ring-ring flex items-center gap-1 rounded-full border px-1.5 text-xs outline-none focus-visible:ring-2'
              )}
            >
              <span aria-hidden>{group.emoji}</span>
              <span aria-hidden>{group.reactions.length}</span>
              <span className="sr-only">
                {t('reactions.chip', { emoji: group.emoji, count: group.reactions.length })}
                {hasProblem ? `. ${t('reactions.hasProblem')}` : ''}
              </span>
              {hasProblem ? <TriangleAlert aria-hidden className="size-3" /> : null}
            </button>
            {isOpen ? (
              <ul id={detailId} className="text-muted-foreground mt-0.5 text-xs">
                {group.reactions.map((reaction, index) => {
                  const state = stateOf(reaction)
                  return (
                    <li key={index} className="flex items-center gap-1">
                      {reaction.deliveryStatus === String(DeliveryStatus.QUEUED) ? (
                        <Clock aria-hidden className="size-3" />
                      ) : null}
                      <span>{authorLabel(reaction.authorType, reaction.authorId)}</span>
                      {state === null ? null : <span>· {state}</span>}
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
