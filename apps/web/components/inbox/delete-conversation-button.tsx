'use client'

import { useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { ReactElement } from 'react'

import { AppPaths, QueryKeys } from '@platform/api-client'

import { apiClient } from '../../lib/api'
import { deleteConversation } from '../../lib/inbox/delete-conversation'
import { useInboxFilters } from '../../lib/inbox/use-inbox-filters'
import { toast } from '../../lib/toast'
import { useErrorText } from '../../lib/use-error-text'
import { useStore } from '../providers/store-context'
import { useDestructiveAction } from '../shared/destructive-action'
import { Button } from '../ui/button'

// "Delete conversation" in the header of the thread, for who holds conversations:delete (the Admin preset). The conversation,
// its messages and its files are gone for good, so it is the typed-phrase tier: the person writes a word of the interface
// (the api keeps the permission and does not read the phrase). Loaded after the header (`next/dynamic`) and mounted only
// for who may use it, because the inbox has a script budget.
export default function DeleteConversationButton({
  conversationId,
  name
}: {
  conversationId: string
  // How the conversation is called on screen (the customer's name), for the text of the dialog
  name: string
}): ReactElement {
  const t = useTranslations('inbox.actions.delete')
  const errorText = useErrorText()
  const router = useRouter()
  const queryClient = useQueryClient()
  const run = useDestructiveAction()
  const { storeId } = useStore()
  const { search } = useInboxFilters()

  const ask = (): void => {
    run('DELETE_CONVERSATION', {
      title: t('title'),
      description: t('description', { name }),
      confirmLabel: t('confirm'),
      phrase: t('phrase'),
      onConfirm: async () => {
        // The shared confirmation shows a generic error for a rejection: the reason of the api is said here, and the
        // dialog closes after it, as in the other pages of settings
        try {
          await deleteConversation(apiClient, storeId, conversationId)
        } catch (error) {
          toast.error(errorText(error))
          return
        }
        toast.success(t('done'))
        // Out of the thread first: reading it again would answer not found for a conversation that is gone
        router.replace(`${AppPaths.store.inbox(storeId)}${search}`)
        queryClient.removeQueries({
          queryKey: QueryKeys.conversations.byId(storeId, conversationId)
        })
        queryClient.removeQueries({ queryKey: QueryKeys.messages.thread(storeId, conversationId) })
        void queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) })
      }
    })
  }

  return (
    <Button type="button" variant="ghost" size="icon" aria-label={t('action')} onClick={ask}>
      <Trash2 aria-hidden />
    </Button>
  )
}
