'use client'

import { useMutation, useQueryClient, type UseMutationResult } from '@tanstack/react-query'
import { useCallback } from 'react'

import {
  assignConversation,
  changeConversationStatus,
  type ConversationDetailView,
  QueryKeys,
  snoozeConversation
} from '@platform/api-client'
import { ConversationStatus } from '@platform/core/domain'

import { apiClient } from '../api'

export interface ResolveInput {
  reason?: string
  // The saved reply for the customer: the server sends it when the time to undo is over, if the
  // conversation is still resolved
  closingSnippetId?: string
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
  const resolve = useMutation({
    mutationFn: ({ reason, closingSnippetId }: ResolveInput) =>
      changeConversationStatus(apiClient, storeId, conversationId, ConversationStatus.RESOLVED, {
        ...(reason === undefined ? {} : { resolutionReason: reason }),
        ...(closingSnippetId === undefined ? {} : { closingSnippetId })
      }),
    onSuccess: refresh
  })
  const reopen = useMutation({
    mutationFn: () =>
      changeConversationStatus(apiClient, storeId, conversationId, ConversationStatus.OPEN),
    onSuccess: refresh
  })

  return { assign, snooze, resolve, reopen }
}
