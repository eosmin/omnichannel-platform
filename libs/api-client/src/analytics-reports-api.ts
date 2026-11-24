import { z } from 'zod'

import type {
  AnalyticsFileFormat,
  CreateReportBody,
  UpdateReportBody
} from '@platform/core/analytics'
import { ApiRoutesAnalytics } from '@platform/core/api'

import type { ApiClient } from './api-client'
import { exportSchema, type ExportView } from './exports-api'

// A scheduled report as the api tells it. `metrics`, `frequency` and `format` stay text: a value this page does not know (a newer
// server) must still draw, and the page maps the ones it knows.
export const reportSchema = z.object({
  id: z.string(),
  name: z.string(),
  metrics: z.array(z.string()),
  frequency: z.string(),
  format: z.string(),
  recipients: z.array(z.string()),
  timezone: z.string(),
  sendAtHour: z.number().int(),
  enabled: z.boolean(),
  lastSentAt: z.string().nullable(),
  createdAt: z.string()
})
export type ReportView = z.output<typeof reportSchema>

// What the form sends: the body the api checks (`createReportSchema`), so a field added there fails to compile here
export type CreateReportInput = CreateReportBody
// Only the keys that change
export type UpdateReportInput = UpdateReportBody

export function fetchReports(
  client: ApiClient,
  storeId: string,
  signal?: AbortSignal
): Promise<ReportView[]> {
  return client.request(ApiRoutesAnalytics.reports, {
    schema: z.array(reportSchema),
    storeId,
    signal
  })
}

export function createReport(
  client: ApiClient,
  storeId: string,
  input: CreateReportInput
): Promise<ReportView> {
  return client.request(ApiRoutesAnalytics.reports, {
    method: 'POST',
    body: input,
    schema: reportSchema,
    storeId
  })
}

export function updateReport(
  client: ApiClient,
  storeId: string,
  id: string,
  input: UpdateReportInput
): Promise<ReportView> {
  return client.request(ApiRoutesAnalytics.reportById(id), {
    method: 'PATCH',
    body: input,
    schema: reportSchema,
    storeId
  })
}

export function deleteReport(client: ApiClient, storeId: string, id: string): Promise<undefined> {
  return client.request(ApiRoutesAnalytics.reportById(id), {
    method: 'DELETE',
    schema: z.undefined(),
    storeId
  })
}

export interface AnalyticsExportRequest {
  // `RolledUpMetric` names of the whole-store metrics (`ReportMetrics`)
  metrics: readonly string[]
  // Calendar days (YYYY-MM-DD, UTC), the last one out
  from: string
  to: string
  format: AnalyticsFileFormat
}

// "Export" of the dashboard: queues the file for the figures asked and answers with its row in the exports center
export function requestAnalyticsExport(
  client: ApiClient,
  storeId: string,
  request: AnalyticsExportRequest
): Promise<ExportView> {
  const params = new URLSearchParams({
    metrics: request.metrics.join(','),
    from: request.from,
    to: request.to,
    format: request.format
  })
  return client.request(`${ApiRoutesAnalytics.export}?${params.toString()}`, {
    schema: exportSchema,
    storeId
  })
}
