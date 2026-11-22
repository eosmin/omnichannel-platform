/**
 * @jest-environment jsdom
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { renderHook, waitFor } from '@testing-library/react'
import { createElement, type ReactNode } from 'react'

import * as apiClientLib from '@platform/api-client'
import { ClientPermissions, RoleNames, RolePresets } from '@platform/core/auth'

import {
  useChannelDirectory,
  useConversationCounts,
  useMemberDirectory,
  useTags
} from './use-inbox-data'

// QA VERIF-31 WEB-1: a role without conversations:view must not make the four directory reads that sit beside the inbox (the console
// filled with 403s). The hooks run for real here, inside a real query client; only the network functions and the store context
// are replaced, so the test fails when a hook is enabled without the permission, not when its text changes.
const mockCan = jest.fn<boolean, [string]>()

jest.mock('../../components/providers/store-context', () => ({
  useStore: () => ({ can: (permission: string) => mockCan(permission) })
}))
jest.mock('../api', () => ({ apiClient: {} }))
jest.mock('../plugin-label', () => ({
  usePluginLabel: () => (_descriptor: unknown, serverName: string) => serverName
}))
jest.mock('@platform/api-client', () => ({
  ...jest.requireActual<Record<string, unknown>>('@platform/api-client'),
  fetchConversationCounts: jest.fn(),
  fetchMemberDirectory: jest.fn(),
  fetchChannelDirectory: jest.fn(),
  fetchTags: jest.fn()
}))

const STORE = '0b8f6a52-3d1c-4c8e-9a47-5e2f1d7c9b10'

const fetchers = {
  useConversationCounts: apiClientLib.fetchConversationCounts as jest.Mock,
  useMemberDirectory: apiClientLib.fetchMemberDirectory as jest.Mock,
  useChannelDirectory: apiClientLib.fetchChannelDirectory as jest.Mock,
  useTags: apiClientLib.fetchTags as jest.Mock
}

const hooks = {
  useConversationCounts,
  useMemberDirectory,
  useChannelDirectory,
  useTags
}

const wrapper = () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children)
}

const grant = (granted: readonly string[]): void => {
  mockCan.mockImplementation(permission => granted.includes(permission))
}

beforeEach(() => {
  jest.clearAllMocks()
  for (const fetcher of Object.values(fetchers)) fetcher.mockResolvedValue([])
})

describe.each(Object.keys(hooks) as (keyof typeof hooks)[])('%s', name => {
  it('asks the server nothing when the role cannot see conversations', () => {
    grant([ClientPermissions.CUSTOMERS_VIEW])
    const { result } = renderHook(() => hooks[name](STORE), { wrapper: wrapper() })

    // Not made: pending with nobody coming, the state `isAwaiting` exists for. A query that is enabled starts to fetch on mount, so
    // `idle` here already says that no request went out; the fetcher is checked all the same
    expect(result.current.fetchStatus).toBe('idle')
    expect(result.current.isPending).toBe(true)
    expect(fetchers[name]).not.toHaveBeenCalled()
  })

  it('reads the directory for a role that can see conversations', async () => {
    grant(RolePresets[RoleNames.VIEWER])
    const { result } = renderHook(() => hooks[name](STORE), { wrapper: wrapper() })

    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchers[name]).toHaveBeenCalledTimes(1)
    const [firstCall] = fetchers[name].mock.calls as unknown[][]
    expect(firstCall?.[1]).toBe(STORE)
  })

  it('starts reading when the permission arrives later', async () => {
    grant([])
    const { result, rerender } = renderHook(() => hooks[name](STORE), { wrapper: wrapper() })
    expect(result.current.fetchStatus).toBe('idle')

    grant([ClientPermissions.CONVERSATIONS_VIEW])
    rerender()
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(fetchers[name]).toHaveBeenCalledTimes(1)
  })
})
