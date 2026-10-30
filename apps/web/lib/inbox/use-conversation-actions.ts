'use client'

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useCallback } from 'react'

import {
  assignConversation,
  changeConversationStatus,
  type ConversationDetailView,
  fetchSnippets,
  QueryKeys,
  sendMessage,
  snoozeConversation
} from '@platform/api-client'
import { ConversationStatus, MessageType } from '@platform/core/domain'

import { apiClient } from '../api'

export interface ResolveInput {
  reason?: string
  // The snippet sent to the customer before the conversation is resolved. The key is the agent's
  // attempt, kept across retries so that one that follows a failed resolve does not send it twice.
  closing?: { snippetId: string; idempotencyKey: string }
}

export interface ConversationActions {
  assign: UseMutationResult<ConversationDetailView, Error, string | null>
  snooze: UseMutationResult<ConversationDetailView, Error, Date>
  resolve: UseMutationResult<ConversationDetailView, Error, ResolveInput>
  reopen: UseMutationResult<ConversationDetailView, Error, void>
}

// What an agent does to the conversation open in front of them. The events of the api already make
// the list and the thread stale; reading them again here covers a socket that is down, and the
// system line ("resolved by Ana") appears in the thread either way.
export function useConversationActions(
  storeId: string,
  conversationId: string
): ConversationActions {
  const queryClient = useQueryClient()
  const refresh = useCallback(async (): Promise<void> => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: QueryKeys.conversations.all(storeId) }),
      queryClient.invalidateQueries({
        queryKey: QueryKeys.messages.thread(storeId, conversationId)
      })
    ])
  }, [queryClient, storeId, conversationId])

  const assign = useMutation({
    mutationFn: (userId: string | null) =>
      assignConversation(apiClient, storeId, conversationId, userId),
    onSuccess: refresh
  })
  const snooze = useMutation({
    mutationFn: (until: Date) => snoozeConversation(apiClient, storeId, conversationId, until),
    onSuccess: refresh
  })
  // The closing message goes first and is waited for: an answer to a resolved conversation reopens
  // it (ConversationReopenedByReply), so sent after, it would undo the resolve
  const resolve = useMutation({
    mutationFn: async ({ reason, closing }: ResolveInput) => {
      if (closing !== undefined) {
        // Always read again: the customer must get the text as it is now, not as the list was cached
        const snippets = await queryClient.fetchQuery({
          queryKey: QueryKeys.snippets.all(storeId),
          queryFn: ({ signal }) => fetchSnippets(apiClient, storeId, signal),
          staleTime: 0
        })
        const snippet = snippets.find(item => item.id === closing.snippetId)
        // A snippet deleted since the settings were read: there is no message to send
        if (snippet !== undefined) {
          await sendMessage(apiClient, storeId, {
            type: MessageType.TEXT,
            conversationId,
            content: snippet.content,
            idempotencyKey: closing.idempotencyKey
          })
        }
      }
      return changeConversationStatus(
        apiClient,
        storeId,
        conversationId,
        ConversationStatus.RESOLVED,
        reason
      )
    },
    onSuccess: refresh
  })
  const reopen = useMutation({
    mutationFn: () =>
      changeConversationStatus(apiClient, storeId, conversationId, ConversationStatus.OPEN),
    onSuccess: refresh
  })

  return { assign, snooze, resolve, reopen }
}
