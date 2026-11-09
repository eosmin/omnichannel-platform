'use client'

import {
  createContext,
  type ReactElement,
  type ReactNode,
  useContext,
  useMemo,
  useState
} from 'react'

import { isSameReplyTarget } from '../../lib/inbox/reply-target-match'

// The message the agent is answering: what the chip of the composer shows, and the id the reply carries
export interface ReplyTarget {
  messageId: string
  type: string
  content: string | null
  author: string
  // The file of an album the agent answers (with its number among them), when it is one file and not the message
  mediaId?: string
  file?: { number: number; total: number }
}

interface ReplyTargetValue {
  target: ReplyTarget | null
  start: (target: ReplyTarget) => void
  cancel: () => void
  // Clears the reply only if it is still the one with this id (a send that took time must not wipe
  // the reply the agent chose in the meantime)
  cancelIf: (messageId: string, mediaId?: string) => void
}

const ReplyTargetContext = createContext<ReplyTargetValue | null>(null)

// One per open conversation (the pane is keyed by it): the bar beside a message starts a reply, the
// composer shows it and sends it. Nothing of it is kept when the agent leaves the conversation.
export function ReplyTargetProvider({ children }: { children: ReactNode }): ReactElement {
  const [target, setTarget] = useState<ReplyTarget | null>(null)
  const value = useMemo<ReplyTargetValue>(
    () => ({
      target,
      // A new object each time: answering the message that is already chosen is still a request
      start: next => setTarget({ ...next }),
      cancel: () => setTarget(null),
      cancelIf: (messageId, mediaId) =>
        setTarget(current => (isSameReplyTarget(current, messageId, mediaId) ? null : current))
    }),
    [target]
  )
  return <ReplyTargetContext.Provider value={value}>{children}</ReplyTargetContext.Provider>
}

export function useReplyTarget(): ReplyTargetValue {
  const value = useContext(ReplyTargetContext)
  if (value === null) throw new Error('useReplyTarget needs ReplyTargetProvider above it')
  return value
}
