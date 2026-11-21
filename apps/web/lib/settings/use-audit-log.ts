'use client'

import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type UseInfiniteQueryResult,
  type UseMutationResult,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type AuditLogEntryView,
  type AuditLogFilter,
  type AuditLogPageView,
  type ExportView,
  fetchAuditLog,
  fetchAuditLogEntry,
  QueryKeys,
  requestAuditLogExport
} from '@platform/api-client'

import { apiClient } from '../api'

// The log of the store, newest first, one page at a time. Reading it is itself audited by the api (the first page of a
// reading, not each page), so a filter that changes asks for a new reading and the previous page stays on screen meanwhile.
export function useAuditLog(
  storeId: string,
  filter: AuditLogFilter
): UseInfiniteQueryResult<InfiniteData<AuditLogPageView, string | null>> {
  return useInfiniteQuery({
    queryKey: QueryKeys.auditLog.list(storeId, filter),
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      fetchAuditLog(apiClient, storeId, filter, pageParam, signal),
    getNextPageParam: last => (last.hasMore ? last.nextCursor : undefined),
    placeholderData: keepPreviousData,
    // Reading the log writes an entry of its own: no silent refetch when the window regains focus
    refetchOnWindowFocus: false
  })
}

// One entry by its id. Opening an entry is a deliberate act that the api audits each time, so it is read once per opening and
// never refetched behind the person's back.
export function useAuditLogEntry(storeId: string, id: string): UseQueryResult<AuditLogEntryView> {
  return useQuery({
    queryKey: QueryKeys.auditLog.entry(storeId, id),
    queryFn: ({ signal }) => fetchAuditLogEntry(apiClient, storeId, id, signal),
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false
  })
}

// "Export CSV": queues the file for the filters the screen shows
export function useExportAuditLog(
  storeId: string
): UseMutationResult<ExportView, Error, AuditLogFilter> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (filter: AuditLogFilter) => requestAuditLogExport(apiClient, storeId, filter),
    // The exports center shows the new row the moment the person gets there
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.exports.all(storeId) })
    }
  })
}
