'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import { apiClient } from '../api'

import {
  type ApiKeyView,
  type ApiKeyWithTokenView,
  type CreateApiKeyInput,
  createApiKey,
  fetchApiKeys,
  revokeApiKey
} from './api-keys-requests'
import { IntegrationKeys } from './integration-keys'
import {
  fetchRetention,
  type RetentionInput,
  type RetentionView,
  saveRetention
} from './retention-requests'
import {
  type CreateWebhookInput,
  createWebhook,
  deleteWebhook,
  type DeliveryOutcome,
  fetchWebhookDeliveries,
  fetchWebhooks,
  rotateWebhookSecret,
  type UpdateWebhookInput,
  updateWebhook,
  type WebhookDeliveryPage,
  type WebhookView,
  type WebhookWithSecretView
} from './webhooks-requests'

// The hooks of Settings → Webhooks, API keys and Data retention. Only those pages load this file.

// A call that makes a secret keeps its answer for nobody: the secret is shown once, from the state of the dialog that asked,
// and the mutation cache must not hold it for its default five minutes after the dialog is gone
const NO_CACHE = { gcTime: 0 } as const

export function useWebhooks(storeId: string): UseQueryResult<WebhookView[]> {
  return useQuery({
    queryKey: IntegrationKeys.webhooks(storeId),
    queryFn: ({ signal }) => fetchWebhooks(apiClient, storeId, signal)
  })
}

export function useCreateWebhook(
  storeId: string
): UseMutationResult<WebhookWithSecretView, Error, CreateWebhookInput> {
  const queryClient = useQueryClient()
  return useMutation({
    ...NO_CACHE,
    mutationFn: input => createWebhook(apiClient, storeId, input),
    // Not returned: the mutation waits for what `onSuccess` returns before the caller hears of the secret, and the secret
    // must reach the screen as soon as the api answers, not after the list is read again
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: IntegrationKeys.webhooks(storeId) })
    }
  })
}

export function useUpdateWebhook(
  storeId: string
): UseMutationResult<WebhookView, Error, { webhookId: string; input: UpdateWebhookInput }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ webhookId, input }) => updateWebhook(apiClient, storeId, webhookId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IntegrationKeys.webhooks(storeId) })
  })
}

export function useDeleteWebhook(storeId: string): UseMutationResult<undefined, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: webhookId => deleteWebhook(apiClient, storeId, webhookId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IntegrationKeys.webhooks(storeId) })
  })
}

export function useRotateWebhookSecret(
  storeId: string
): UseMutationResult<WebhookWithSecretView, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    ...NO_CACHE,
    mutationFn: webhookId => rotateWebhookSecret(apiClient, storeId, webhookId),
    // Not returned, as in the create
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: IntegrationKeys.webhooks(storeId) })
    }
  })
}

// The log of one webhook, newest first, a page at a time
export function useWebhookDeliveries(
  storeId: string,
  webhookId: string,
  outcome: DeliveryOutcome
): UseInfiniteQueryResult<InfiniteData<WebhookDeliveryPage, string | null>> {
  return useInfiniteQuery({
    queryKey: IntegrationKeys.deliveries(storeId, webhookId, outcome),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchWebhookDeliveries(apiClient, storeId, webhookId, { cursor: pageParam, outcome }, signal),
    getNextPageParam: page => page.nextCursor,
    // The rows of the last filter stay on screen while the next one loads
    placeholderData: keepPreviousData
  })
}

export function useApiKeys(storeId: string): UseQueryResult<ApiKeyView[]> {
  return useQuery({
    queryKey: IntegrationKeys.apiKeys(storeId),
    queryFn: ({ signal }) => fetchApiKeys(apiClient, storeId, signal)
  })
}

export function useCreateApiKey(
  storeId: string
): UseMutationResult<ApiKeyWithTokenView, Error, CreateApiKeyInput> {
  const queryClient = useQueryClient()
  return useMutation({
    ...NO_CACHE,
    mutationFn: input => createApiKey(apiClient, storeId, input),
    // Not returned: the key must reach the screen as soon as the api answers
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: IntegrationKeys.apiKeys(storeId) })
    }
  })
}

export function useRevokeApiKey(storeId: string): UseMutationResult<ApiKeyView, Error, string> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: keyId => revokeApiKey(apiClient, storeId, keyId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: IntegrationKeys.apiKeys(storeId) })
  })
}

export function useRetention(storeId: string): UseQueryResult<RetentionView> {
  return useQuery({
    queryKey: IntegrationKeys.retention(storeId),
    queryFn: ({ signal }) => fetchRetention(apiClient, storeId, signal)
  })
}

export function useSaveRetention(
  storeId: string
): UseMutationResult<RetentionView, Error, RetentionInput> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: input => saveRetention(apiClient, storeId, input),
    onSuccess: saved => {
      queryClient.setQueryData(IntegrationKeys.retention(storeId), saved)
    }
  })
}
