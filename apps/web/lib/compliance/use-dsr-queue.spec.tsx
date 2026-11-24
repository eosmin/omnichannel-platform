/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook } from '@testing-library/react'
import type { ReactElement, ReactNode } from 'react'

import type { DsrRequestPageView } from './dsr-requests'
import { DSR_QUEUE_POLL_MAX_PAGES, DSR_QUEUE_REFRESH_MS, useDsrQueue } from './use-dsr'

const mockFetch = jest.fn<Promise<DsrRequestPageView>, []>()
jest.mock('../api', () => ({ apiClient: {} }))
jest.mock('./dsr-requests', () => ({
  ...jest.requireActual<object>('./dsr-requests'),
  fetchDsrRequests: (): Promise<DsrRequestPageView> => mockFetch()
}))

const page: DsrRequestPageView = { items: [], hasMore: false, nextCursor: null }

function wrapperOf(client: QueryClient): (props: { children: ReactNode }) => ReactElement {
  return function Wrapper({ children }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

describe('useDsrQueue', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockFetch.mockReset()
    mockFetch.mockResolvedValue(page)
  })
  afterEach(() => jest.useRealTimers())

  // PRI-076: the list stayed on "Esperando verificación" for good until the page was reloaded
  it('reads the queue again on its own, so a request that changed elsewhere shows without a reload', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useDsrQueue('store-1'), { wrapper: wrapperOf(client) })
    await jest.advanceTimersByTimeAsync(0)
    expect(mockFetch).toHaveBeenCalledTimes(1)
    await jest.advanceTimersByTimeAsync(DSR_QUEUE_REFRESH_MS + 100)
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not poll a queue that is already several pages long: a refetch reads every loaded page', async () => {
    const more: DsrRequestPageView = { items: [], hasMore: true, nextCursor: 'c' }
    mockFetch.mockResolvedValueOnce(more).mockResolvedValueOnce(more).mockResolvedValueOnce(more)
    mockFetch.mockResolvedValueOnce(more).mockResolvedValue(page)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    renderHook(() => useDsrQueue('store-2'), { wrapper: wrapperOf(client) })
    await jest.advanceTimersByTimeAsync(1_000)
    const settled = mockFetch.mock.calls.length
    expect(settled).toBeGreaterThan(DSR_QUEUE_POLL_MAX_PAGES)
    await jest.advanceTimersByTimeAsync(DSR_QUEUE_REFRESH_MS * 3)
    expect(mockFetch.mock.calls.length).toBe(settled)
  })
})
