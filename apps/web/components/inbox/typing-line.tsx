'use client'

import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { useConversationRoom } from '../../lib/realtime/use-conversation-room'
import { useTyping } from '../../lib/realtime/use-typing'
import { useProfile } from '../../lib/use-profile'

// Under the thread: who is typing now. The line keeps its height when nobody is, so the thread does
// not jump; the words are in a polite live region, and the color is never the only signal.
export function TypingLine({ conversationId }: { conversationId: string }): ReactElement {
  const t = useTranslations('inbox.thread.typing')
  // Joined here as well as by the thread: the rooms are counted, and this line is on screen even when
  // the thread is still loading or failed, while the composer is already announcing
  useConversationRoom(conversationId)
  const { isCustomerTyping, teammates } = useTyping(conversationId, useProfile().data?.id)

  const parts: string[] = []
  if (isCustomerTyping) parts.push(t('customer'))
  if (teammates.length > 0)
    parts.push(t('teammates', { count: teammates.length, names: teammates.join(', ') }))

  return (
    <p
      role="status"
      aria-live="polite"
      className="text-muted-foreground h-5 shrink-0 truncate px-4 text-xs"
    >
      {parts.join(' · ')}
    </p>
  )
}
