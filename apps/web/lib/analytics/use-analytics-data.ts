'use client'

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import {
  fetchMetrics,
  fetchMyPerformance,
  fetchSearchReport,
  type MetricsRequest,
  type MetricsResultView,
  type MyPerformanceView,
  QueryKeys,
  type SearchReportView
} from '@platform/api-client'

import { apiClient } from '../api'

// The rollups close an hour or a day at a time: a minute of cache is as fresh as the data can be
const METRICS_STALE_MS = 60_000
// "Today" of the widget moves with every answer, and the inbox is where the agent is all day
const MY_PERFORMANCE_REFRESH_MS = 60_000

export function useMetrics(
  storeId: string,
  request: MetricsRequest
): UseQueryResult<MetricsResultView> {
  return useQuery({
    queryKey: QueryKeys.analytics.metrics(storeId, request),
    queryFn: ({ signal }) => fetchMetrics(apiClient, storeId, request, signal),
    staleTime: METRICS_STALE_MS
  })
}

export function useMyPerformance(storeId: string): UseQueryResult<MyPerformanceView> {
  return useQuery({
    queryKey: QueryKeys.analytics.myPerformance(storeId),
    queryFn: ({ signal }) => fetchMyPerformance(apiClient, storeId, signal),
    refetchInterval: MY_PERFORMANCE_REFRESH_MS
  })
}

// What was searched in the last `days` days: events are written as people search, so a minute of cache is as fresh as it is read
export function useSearchReport(storeId: string, days: number): UseQueryResult<SearchReportView> {
  return useQuery({
    queryKey: QueryKeys.analytics.search(storeId, days),
    queryFn: ({ signal }) => fetchSearchReport(apiClient, storeId, days, signal),
    staleTime: METRICS_STALE_MS
  })
}
