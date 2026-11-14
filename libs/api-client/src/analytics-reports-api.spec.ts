import { AnalyticsMetrics, ReportFormats, ReportFrequency } from '@platform/core/analytics'

import {
  createReport,
  deleteReport,
  fetchReports,
  requestAnalyticsExport,
  updateReport
} from './analytics-reports-api'
import { createApiClient } from './api-client'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(response: Response) {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(response.clone()))
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const report = {
  id: 'r1',
  name: 'Weekly',
  metrics: [AnalyticsMetrics.CONVERSATIONS_CREATED],
  frequency: ReportFrequency.WEEKLY,
  format: ReportFormats.CSV,
  recipients: ['boss@example.com'],
  timezone: 'America/El_Salvador',
  sendAtHour: 8,
  enabled: true,
  lastSentAt: null,
  createdAt: '2026-11-01T00:00:00.000Z'
}

describe('the scheduled reports', () => {
  it('lists the reports of the store in X-Store-Id', async () => {
    const { client, fetchImpl } = setup(json(200, [report]))

    const list = await fetchReports(client, 's1')

    expect(list).toEqual([report])
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/analytics/reports')
    expect(new Headers(init?.headers).get('X-Store-Id')).toBe('s1')
  })

  it('sends a new report as a POST with the body the form made', async () => {
    const { client, fetchImpl } = setup(json(201, report))

    await createReport(client, 's1', {
      name: 'Weekly',
      metrics: [AnalyticsMetrics.CONVERSATIONS_CREATED],
      frequency: ReportFrequency.WEEKLY,
      format: ReportFormats.CSV,
      recipients: ['boss@example.com'],
      timezone: 'America/El_Salvador',
      sendAtHour: 8,
      enabled: true
    })

    const init = fetchImpl.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toMatchObject({ name: 'Weekly', sendAtHour: 8 })
  })

  it('patches only what changes and reads the report back', async () => {
    const { client, fetchImpl } = setup(json(200, { ...report, enabled: false }))

    const answer = await updateReport(client, 's1', 'r1', { enabled: false })

    expect(answer.enabled).toBe(false)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(String(url)).toMatch(/\/analytics\/reports\/r1$/)
    expect(init?.method).toBe('PATCH')
    expect(JSON.parse(init?.body as string)).toEqual({ enabled: false })
  })

  it('deletes a report and expects no body', async () => {
    const { client, fetchImpl } = setup(new Response(null, { status: 204 }))

    await expect(deleteReport(client, 's1', 'r1')).resolves.toBeUndefined()
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('DELETE')
  })

  it('refuses an answer that is not a report', async () => {
    const { client } = setup(json(200, [{ id: 'r1' }]))

    await expect(fetchReports(client, 's1')).rejects.toThrow()
  })
})

describe('requestAnalyticsExport', () => {
  it('asks for the metrics as one comma-separated list, the days and the format', async () => {
    const row = {
      id: 'e1',
      type: 'analytics',
      format: 'excel',
      status: 'pending',
      filename: null,
      rowCount: null,
      progress: null,
      error: null,
      createdAt: '2026-11-01T00:00:00.000Z',
      completedAt: null,
      expiresAt: '2026-11-08T00:00:00.000Z'
    }
    const { client, fetchImpl } = setup(json(202, row))

    const answer = await requestAnalyticsExport(client, 's1', {
      metrics: [AnalyticsMetrics.CONVERSATIONS_CREATED, AnalyticsMetrics.ORDERS_REVENUE],
      from: '2026-10-01',
      to: '2026-11-01',
      format: ReportFormats.EXCEL
    })

    expect(answer.id).toBe('e1')
    const url = new URL(fetchImpl.mock.calls[0]?.[0] ?? '')
    expect(url.pathname).toBe('/api/v1/analytics/export')
    expect(url.searchParams.get('metrics')).toBe(
      `${AnalyticsMetrics.CONVERSATIONS_CREATED},${AnalyticsMetrics.ORDERS_REVENUE}`
    )
    expect(url.searchParams.get('from')).toBe('2026-10-01')
    expect(url.searchParams.get('to')).toBe('2026-11-01')
    expect(url.searchParams.get('format')).toBe('excel')
  })
})
