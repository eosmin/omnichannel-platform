'use client'

import {
  useMutation,
  type UseMutationResult,
  useQuery,
  useQueryClient,
  type UseQueryResult
} from '@tanstack/react-query'

import {
  type AnalyticsExportRequest,
  type CreateReportInput,
  createReport,
  deleteReport,
  fetchReports,
  QueryKeys,
  type ReportView,
  requestAnalyticsExport,
  type UpdateReportInput,
  updateReport,
  type ExportView
} from '@platform/api-client'

import { apiClient } from '../api'

// The hooks of the scheduled reports and of the export of the dashboard. Only the analytics screens load this file.

export function useReports(storeId: string, enabled: boolean): UseQueryResult<ReportView[]> {
  return useQuery({
    queryKey: QueryKeys.analytics.reports(storeId),
    queryFn: ({ signal }) => fetchReports(apiClient, storeId, signal),
    enabled
  })
}

function useRefreshReports(storeId: string): () => void {
  const queryClient = useQueryClient()
  return () => {
    void queryClient.invalidateQueries({ queryKey: QueryKeys.analytics.reports(storeId) })
  }
}

export function useCreateReport(
  storeId: string
): UseMutationResult<ReportView, Error, CreateReportInput> {
  const refresh = useRefreshReports(storeId)
  return useMutation({
    mutationFn: (input: CreateReportInput) => createReport(apiClient, storeId, input),
    onSuccess: refresh
  })
}

export function useUpdateReport(
  storeId: string
): UseMutationResult<ReportView, Error, { id: string; input: UpdateReportInput }> {
  const refresh = useRefreshReports(storeId)
  return useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateReportInput }) =>
      updateReport(apiClient, storeId, id, input),
    // Also after a refusal: a 404 says the report is gone (deleted elsewhere), and the list must not keep showing it
    onSettled: refresh
  })
}

export function useDeleteReport(storeId: string): UseMutationResult<undefined, Error, string> {
  const refresh = useRefreshReports(storeId)
  return useMutation({
    mutationFn: (id: string) => deleteReport(apiClient, storeId, id),
    // Also after a refusal, for the same reason as the update
    onSettled: refresh
  })
}

// "Export" of the dashboard: queues the file for the figures asked
export function useExportAnalytics(
  storeId: string
): UseMutationResult<ExportView, Error, AnalyticsExportRequest> {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (request: AnalyticsExportRequest) =>
      requestAnalyticsExport(apiClient, storeId, request),
    // The exports center shows the new row the moment the person gets there
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: QueryKeys.exports.all(storeId) })
    }
  })
}
