'use client'

import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import {
  type DeletedContentView,
  deleteMessage,
  editMessage,
  fetchDeletedContent,
  fetchRevisions,
  type MessageView,
  QueryKeys,
  reactToMessage,
  resendMessage,
  type RevisionView
} from '@platform/api-client'

import { useStore } from '../../components/providers/store-context'
import { apiClient } from '../api'
import { useProfile } from '../use-profile'

import { type ActionViewer } from './message-actions'
import { useChannelDirectory, useConversation } from './use-inbox-data'

export interface EditInput {
  content: string
  // The version a note was read at; a reply to the customer has none
  version?: number
}

export interface MessageMutations {
  react: UseMutationResult<void, Error, string | null>
  resend: UseMutationResult<MessageView, Error, void>
  edit: UseMutationResult<MessageView, Error, EditInput>
  remove: UseMutationResult<void, Error, void>
}

// What an agent does to one message. The events of the api make the thread stale as well; reading it
// again here covers a socket that is down, and shows the pending state of the change at once.
export function useMessageMutations(conversationId: string, messageId: string): MessageMutations {
  const { storeId } = useStore()
  const queryClient = useQueryClient()
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: QueryKeys.messages.thread(storeId, conversationId)
      }),
      queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) })
    ])
  }, [queryClient, storeId, conversationId])

  const react = useMutation({
    mutationFn: (emoji: string | null) => reactToMessage(apiClient, storeId, messageId, emoji),
    onSuccess: refresh
  })
  const resend = useMutation({
    mutationFn: () => resendMessage(apiClient, storeId, messageId),
    onSuccess: refresh
  })
  const edit = useMutation({
    mutationFn: (input: EditInput) => editMessage(apiClient, storeId, messageId, input),
    onSuccess: refresh,
    // A stale note answers 409; the thread is read again so the dialog can show the current text
    onError: refresh
  })
  const remove = useMutation({
    mutationFn: () => deleteMessage(apiClient, storeId, messageId),
    onSuccess: refresh
  })
  return { react, resend, edit, remove }
}

// Read when the dialog opens, never with the thread: every read of the kept text is audited by the api,
// so nothing caches it or asks again on its own
export function useDeletedContent(
  messageId: string,
  isEnabled: boolean
): UseQueryResult<DeletedContentView> {
  const { storeId } = useStore()
  return useQuery({
    queryKey: QueryKeys.messages.deletedContent(storeId, messageId),
    queryFn: () => fetchDeletedContent(apiClient, storeId, messageId),
    enabled: isEnabled,
    gcTime: 0,
    staleTime: Infinity,
    retry: false
  })
}

export function useRevisions(
  messageId: string,
  isEnabled: boolean
): UseQueryResult<RevisionView[]> {
  const { storeId } = useStore()
  return useQuery({
    queryKey: QueryKeys.messages.revisions(storeId, messageId),
    queryFn: ({ signal }) => fetchRevisions(apiClient, storeId, messageId, signal),
    enabled: isEnabled
  })
}

// Who is asking and what the channel of this conversation declares, for the rules of the actions
export function useActionViewer(conversationId: string): ActionViewer {
  const { storeId, can } = useStore()
  const userId = useProfile().data?.id
  const conversation = useConversation(storeId, conversationId)
  const channels = useChannelDirectory(storeId)
  const channelType = conversation.data?.channelType
  const capabilities = useMemo(
    () => channels.data?.find(channel => channel.pluginId === channelType)?.capabilities ?? [],
    [channels.data, channelType]
  )
  return useMemo(() => ({ userId, can, capabilities }), [userId, can, capabilities])
}
