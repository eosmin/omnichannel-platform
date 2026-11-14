'use client'

import { useQuery, type UseQueryResult } from '@tanstack/react-query'

import {
  fetchMetrics,
  fetchMyPerformance,
  type MetricsRequest,
  type MetricsResultView,
  type MyPerformanceView,
  QueryKeys
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
