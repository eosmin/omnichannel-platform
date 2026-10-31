'use client'

import type { ReactElement } from 'react'

import { Composer } from './composer'
import { ConversationControls } from './conversation-controls'
import { ConversationHeader } from './conversation-header'
import { MessageThread } from './message-thread'
import { TypingLine } from './typing-line'

// The open conversation: header, thread, typing line and composer. It is its own chunk (loaded by
// lazy-dialogs.ts), because the inbox without an open conversation does not draw any of it.
export function ConversationPane({ conversationId }: { conversationId: string }): ReactElement {
  return (
    <ConversationControls key={conversationId} conversationId={conversationId}>
      <ConversationHeader conversationId={conversationId} />
      <MessageThread conversationId={conversationId} />
      <TypingLine conversationId={conversationId} />
      <Composer conversationId={conversationId} />
    </ConversationControls>
  )
}
