'use client'

import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { type ReactElement, useEffect } from 'react'
import { z } from 'zod'

import { AppPaths } from '@platform/api-client'
import { RealtimeEvents } from '@platform/core/realtime'

import { forgetDraft } from '../../lib/inbox/composer-draft-index'
import { wasDeletedHere } from '../../lib/inbox/deleted-here'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { useRealtime } from '../../lib/realtime/realtime-context'
import { toast } from '../../lib/toast'
import { useProfile } from '../../lib/use-profile'
import { useStore } from '../providers/store-context'

const deletedSchema = z.object({ conversationId: z.string().min(1) })

// A conversation deleted, here or by someone else (the event reaches every client of the store). Its unsent draft is
// let go, so that the filter "With draft" does not count a conversation that no longer exists (N-BR2-50); and if it is
// the one open in this tab the thread leaves, with a notice, instead of staying on screen until a send fails
// (N-BR2-51). It draws nothing.
export function DeletedConversationWatcher({
  openId
}: {
  // The conversation open in the thread, if any
  openId: string | undefined
}): ReactElement | null {
  const t = useTranslations('inbox')
  const realtime = useRealtime()
  const router = useRouter()
  const { storeId } = useStore()
  const { search } = useInboxFilters()
  const userId = useProfile().data?.id

  useEffect(() => {
    if (realtime === null) return
    const { socket } = realtime.connection
    // The payload comes off a socket: it is read, not trusted
    const onDeleted = (payload: unknown): void => {
      const parsed = deletedSchema.safeParse(payload)
      if (!parsed.success) return
      const { conversationId } = parsed.data
      if (userId !== undefined) forgetDraft({ userId, storeId, conversationId })
      if (conversationId !== openId || wasDeletedHere(conversationId)) return
      toast.info(t('deletedElsewhere'))
      router.replace(`${AppPaths.store.inbox(storeId)}${search}`)
    }
    socket.on(RealtimeEvents.CONVERSATION_DELETED, onDeleted)
    return () => {
      socket.off(RealtimeEvents.CONVERSATION_DELETED, onDeleted)
    }
  }, [realtime, userId, storeId, openId, router, search, t])

  return null
}
