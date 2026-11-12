'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'
import { useEffect, useState } from 'react'

import {
  deleteOrderTemplate,
  fetchOrderTemplates,
  type OrderTemplatePreviewView,
  type OrderTemplateView,
  previewOrderTemplate,
  type PutOrderTemplateInput,
  putOrderTemplate,
  QueryKeys
} from '@platform/api-client'
import type { OrderMessageKindType } from '@platform/core/domain'
import type { Locale } from '@platform/core/i18n'

import { apiClient } from '../api'

// The hooks of Settings → Order messages. Only that page loads this file.

// How long the text must rest before the preview asks the api to render it
const PREVIEW_DELAY_MS = 400

export function useOrderTemplates(storeId: string): UseQueryResult<OrderTemplateView[]> {
  return useQuery({
    queryKey: QueryKeys.orderTemplates.all(storeId),
    queryFn: ({ signal }) => fetchOrderTemplates(apiClient, storeId, signal)
  })
}

interface TemplateAddress {
  kind: OrderMessageKindType
  locale: Locale
}

export function useSaveOrderTemplate(
  storeId: string
): UseMutationResult<OrderTemplateView, Error, TemplateAddress & { input: PutOrderTemplateInput }> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: QueryKeys.orderTemplates.writing(storeId),
    mutationFn: ({ kind, locale, input }) =>
      putOrderTemplate(apiClient, storeId, kind, locale, input),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: QueryKeys.orderTemplates.all(storeId) })
  })
}

export function useDeleteOrderTemplate(
  storeId: string
): UseMutationResult<undefined, Error, TemplateAddress> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationKey: QueryKeys.orderTemplates.writing(storeId),
    mutationFn: ({ kind, locale }) => deleteOrderTemplate(apiClient, storeId, kind, locale),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: QueryKeys.orderTemplates.all(storeId) })
  })
}

// The text being typed, rendered by the api with a sample order once it has rested. Asked only for a text that may be
// rendered (not blank) and only by who may preview (the api asks the same permission as for writing).
export function useTemplatePreview(
  storeId: string,
  body: string,
  locale: Locale,
  isEnabled: boolean
): { preview: UseQueryResult<OrderTemplatePreviewView>; settled: boolean } {
  const [rested, setRested] = useState(body)
  useEffect(() => {
    const timer = setTimeout(() => setRested(body), PREVIEW_DELAY_MS)
    return () => clearTimeout(timer)
  }, [body])
  const preview = useQuery({
    queryKey: QueryKeys.orderTemplates.preview(storeId, locale, rested),
    queryFn: ({ signal }) => previewOrderTemplate(apiClient, storeId, rested, locale, signal),
    enabled: isEnabled && rested.trim() !== '',
    retry: false,
    staleTime: Infinity,
    // Every pause of the typing makes an entry keyed by the whole text: none is kept once nobody reads it
    gcTime: 0,
    // The last preview stays while the next one loads, never after the text was cleared
    placeholderData: previous => (rested.trim() === '' ? undefined : previous)
  })
  return { preview, settled: rested === body }
}
