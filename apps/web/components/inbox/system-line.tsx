'use client'

import { useFormatter, useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import type { MessageView } from '@platform/api-client'
import { ConversationStatusReasons, SystemMessageEvents } from '@platform/core/domain'

type SystemLine = NonNullable<MessageView['system']>

const isEvent = (
  event: string
): event is (typeof SystemMessageEvents)[keyof typeof SystemMessageEvents] =>
  Object.values<string>(SystemMessageEvents).includes(event)

const isReason = (
  reason: string
): reason is (typeof ConversationStatusReasons)[keyof typeof ConversationStatusReasons] =>
  Object.values<string>(ConversationStatusReasons).includes(reason)

// "Resolved by Ana", "Reopened because the customer replied": a divider, not a bubble, so that a
// conversation that is one continuous chat still shows its story. It has no text of its own: it is
// written here from the event, the people and the dates, in the language of who reads it.
export function SystemLineView({
  line,
  createdAt,
  nameOf
}: {
  line: SystemLine
  createdAt: string
  nameOf: (id: string | null) => string
}): ReactElement {
  const t = useTranslations('inbox.thread.system')
  const format = useFormatter()
  const actorKind = line.actor.type === 'user' ? 'user' : 'system'
  const params = {
    actorKind,
    actor: nameOf(line.actor.id),
    assignee: nameOf(line.assignedTo)
  }
  const text = isEvent(line.event) ? t(line.event, params) : t('unknown')
  const until =
    line.snoozedUntil === null
      ? null
      : t('snoozedUntil', {
          until: format.dateTime(new Date(line.snoozedUntil), {
            dateStyle: 'medium',
            timeStyle: 'short'
          })
        })
  // The reason of a line the system wrote is a code of ours; the one an agent typed when resolving is
  // text, drawn as it is even when it looks like a code
  const reason =
    line.reason === null
      ? null
      : actorKind === 'system' && isReason(line.reason)
        ? t(`reasons.${line.reason}`)
        : line.reason

  return (
    <div className="text-muted-foreground flex flex-col items-center gap-0.5 py-1 text-center text-xs">
      <p>
        {text}
        {until === null ? null : ` ${until}`}
        {' · '}
        <time dateTime={createdAt}>
          {format.dateTime(new Date(createdAt), { dateStyle: 'medium', timeStyle: 'short' })}
        </time>
      </p>
      {reason === null ? null : <p>{t('reason', { reason })}</p>}
    </div>
  )
}
