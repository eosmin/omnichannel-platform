'use client'

import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect, useState } from 'react'
import { z } from 'zod'

import { RealtimeEvents } from '@platform/core/realtime'

import { useRealtime } from '../../lib/realtime/realtime-context'
import { useProfile } from '../../lib/use-profile'

const assignedSchema = z.object({
  assignedTo: z.string().nullable(),
  assignedBy: z.string().nullable().optional()
})

// Screen readers hear what a sighted person sees appear in the list (TDD_09 §17): a new message and
// an assignment to the person. The events carry ids only, so the words say what happened and never
// who wrote or what. The text sits in a node of its own for each announcement, so that the same
// sentence twice in a row is read twice.
export function RealtimeAnnouncer(): ReactElement {
  const t = useTranslations('inbox.announce')
  const realtime = useRealtime()
  const userId = useProfile().data?.id
  const [announcement, setAnnouncement] = useState<{ id: number; text: string } | null>(null)

  useEffect(() => {
    if (realtime === null) return
    const { socket } = realtime.connection
    const say = (text: string): void => setAnnouncement(last => ({ id: (last?.id ?? 0) + 1, text }))
    const onMessage = (): void => say(t('newMessage'))
    // The payload comes off a socket: it is read, not trusted
    const onAssigned = (payload: unknown): void => {
      const parsed = assignedSchema.safeParse(payload)
      if (
        userId !== undefined &&
        parsed.success &&
        parsed.data.assignedTo === userId &&
        parsed.data.assignedBy !== userId
      ) {
        say(t('assignedToYou'))
      }
    }
    socket.on(RealtimeEvents.MESSAGE_RECEIVED, onMessage)
    socket.on(RealtimeEvents.CONVERSATION_ASSIGNED, onAssigned)
    return () => {
      socket.off(RealtimeEvents.MESSAGE_RECEIVED, onMessage)
      socket.off(RealtimeEvents.CONVERSATION_ASSIGNED, onAssigned)
    }
  }, [realtime, userId, t])

  return (
    <div role="status" aria-live="polite" className="sr-only">
      {announcement === null ? null : <p key={announcement.id}>{announcement.text}</p>}
    </div>
  )
}
