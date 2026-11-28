'use client'

import {
  type InfiniteData,
  useInfiniteQuery,
  type UseInfiniteQueryResult,
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  confirmFiscalIssuerChange,
  fetchFiscalDocument,
  fetchFiscalDocumentPage,
  fetchFiscalDelivery,
  fetchFiscalEvidenceUrls,
  fetchFiscalIssuer,
  fetchFiscalProviders,
  handOverFiscalDelivery,
  fetchFiscalSeries,
  type FiscalDeliveryView,
  type FiscalDocumentDetailView,
  type FiscalDocumentFilters,
  type FiscalDocumentPageView,
  type FiscalDocumentView,
  type FiscalIssuerView,
  type MediaUrlsView,
  type FiscalProviderView,
  type FiscalSeriesView,
  patchFiscalReceiver,
  putFiscalIssuer,
  QueryKeys,
  replaceFiscalDocument,
  retryFiscalDocument,
  voidFiscalDocument
} from '@platform/api-client'
import { FiscalDeliverySubject } from '@platform/core/domain'
import type {
  FiscalEvidenceKind,
  HandOverFiscalDeliveryInput,
  FiscalReceiverPatchBody,
  PutFiscalIssuerBody,
  VoidFiscalDocumentBody
} from '@platform/core/domain'

import { apiClient } from '../api'

// The hooks of the fiscal screens (Step 4B.9b-2). Reading is for fiscal:view and `enabled` keeps a page from asking for what its person
// may not read. Every write makes the fiscal root stale and the books too: a voided or replaced document moves the books' own entries.

export function useFiscalProviders(
  storeId: string,
  enabled: boolean
): UseQueryResult<FiscalProviderView[]> {
  return useQuery({
    queryKey: QueryKeys.fiscal.providers(storeId),
    queryFn: ({ signal }) => fetchFiscalProviders(apiClient, storeId, signal),
    enabled,
    // The providers of a deployment do not change while a person works
    staleTime: Infinity
  })
}

// The series of correlatives of the organization: what each counts and the number the next document of it takes. Any write of a document
// moves them, so the fiscal root makes them stale like the rest.
export function useFiscalSeries(
  storeId: string,
  enabled: boolean
): UseQueryResult<FiscalSeriesView[]> {
  return useQuery({
    queryKey: QueryKeys.fiscal.series(storeId),
    queryFn: ({ signal }) => fetchFiscalSeries(apiClient, storeId, signal),
    enabled
  })
}

export function useFiscalIssuer(
  storeId: string,
  enabled: boolean
): UseQueryResult<FiscalIssuerView | null> {
  return useQuery({
    queryKey: QueryKeys.fiscal.issuer(storeId),
    queryFn: ({ signal }) => fetchFiscalIssuer(apiClient, storeId, signal),
    enabled
  })
}

const keyOfFilters = (filters: FiscalDocumentFilters): Record<string, string> =>
  Object.fromEntries(
    Object.entries(filters).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== ''
    )
  )

// The newest page first (the correlative goes down); the next one is asked with the cursor of the last
export function useFiscalDocuments(
  storeId: string,
  filters: FiscalDocumentFilters,
  enabled: boolean
): UseInfiniteQueryResult<InfiniteData<FiscalDocumentPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.fiscal.documents(storeId, keyOfFilters(filters)),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchFiscalDocumentPage(apiClient, storeId, filters, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? (last.nextCursor ?? undefined) : undefined),
    enabled
  })
}

// `enabled` is false while the dialog is closed, so a document with its receiver is not read again with nobody looking at it
export function useFiscalDocument(
  storeId: string,
  id: string | null,
  enabled: boolean
): UseQueryResult<FiscalDocumentDetailView> {
  return useQuery({
    queryKey: QueryKeys.fiscal.document(storeId, id ?? ''),
    queryFn: ({ signal }) => fetchFiscalDocument(apiClient, storeId, id ?? '', signal),
    enabled: enabled && id !== null
  })
}

type Write<TInput, TResult> = UseMutationResult<TResult, Error, TInput>

// `books`: the write moves the books too (a void or a replacement), so the finance queries are read again as well; the others touch the
// documents and the issuer only. The providers of a deployment never change with a write.
function useFiscalWrite<TInput, TResult>(
  write: (input: TInput) => Promise<TResult>,
  books = false
): Write<TInput, TResult> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: write,
    // Returned, so the mutation settles after the lists have been read again: a dialog closes on fresh data, not on the old
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: QueryKeys.fiscal.root,
          predicate: query => query.queryKey[2] !== 'providers'
        }),
        ...(books ? [queryClient.invalidateQueries({ queryKey: QueryKeys.finance.root })] : [])
      ])
  })
}

export const usePutFiscalIssuer = (storeId: string): Write<PutFiscalIssuerBody, FiscalIssuerView> =>
  useFiscalWrite(body => putFiscalIssuer(apiClient, storeId, body))

export const usePatchFiscalReceiver = (
  storeId: string
): Write<{ id: string; changes: FiscalReceiverPatchBody }, FiscalDocumentView> =>
  useFiscalWrite(input => patchFiscalReceiver(apiClient, storeId, input.id, input.changes))

export const useRetryFiscalDocument = (storeId: string): Write<string, void> =>
  useFiscalWrite(id => retryFiscalDocument(apiClient, storeId, id))

export const useVoidFiscalDocument = (
  storeId: string
): Write<{ id: string; body: VoidFiscalDocumentBody }, FiscalDocumentView> =>
  useFiscalWrite(input => voidFiscalDocument(apiClient, storeId, input.id, input.body), true)

export const useReplaceFiscalDocument = (storeId: string): Write<string, FiscalDocumentView> =>
  useFiscalWrite(id => replaceFiscalDocument(apiClient, storeId, id), true)

export const useConfirmFiscalIssuerChange = (
  storeId: string
): Write<{ id: string; reason: string }, void> =>
  useFiscalWrite(input => confirmFiscalIssuerChange(apiClient, storeId, input.id, input.reason))

// The link of a file of evidence is signed and short-lived (15 minutes): it is asked when the person asks for the file, never kept in the
// cache, so a link that expired is never opened
export const useFiscalEvidenceLink = (
  storeId: string
): Write<{ id: string; kind: FiscalEvidenceKind }, MediaUrlsView> =>
  useMutation({
    mutationFn: input => fetchFiscalEvidenceUrls(apiClient, storeId, input.id, input.kind)
  })

// How the files of an accepted document, or of its invalidation (`subject`), reached its receiver, and which of them exist (a voided document may
// have none of its own)
export function useFiscalDelivery(
  storeId: string,
  id: string,
  enabled: boolean,
  subject: FiscalDeliverySubject = FiscalDeliverySubject.DOCUMENT
): UseQueryResult<FiscalDeliveryView> {
  return useQuery({
    queryKey: QueryKeys.fiscal.delivery(storeId, id, subject),
    queryFn: ({ signal }) => fetchFiscalDelivery(apiClient, storeId, id, signal, subject),
    enabled
  })
}

// A person records that they gave the files to the receiver by hand
export const useHandOverFiscalDelivery = (
  storeId: string
): Write<{ id: string; body: HandOverFiscalDeliveryInput }, FiscalDeliveryView> =>
  useFiscalWrite(input => handOverFiscalDelivery(apiClient, storeId, input.id, input.body))
