import { onlineManager } from '@tanstack/react-query'

import { ApiError } from '@platform/api-client'
import { ClientErrorCodes, ErrorCodes } from '@platform/core/errors'

import { createQueryClient, retryDelayOf, shouldRetry } from './query-client'

describe('the query client of the app', () => {
  afterEach(() => onlineManager.setOnline(true))

  it('runs a save with no network and fails it at once, instead of holding it', async () => {
    onlineManager.setOnline(false)
    const client = createQueryClient()
    const offline = new ApiError(0, ErrorCodes.NETWORK_UNAVAILABLE, 'The api cannot be reached')
    const mutationFn = jest.fn().mockRejectedValue(offline)

    const observer = client.getMutationCache().build(client, { mutationFn })
    await expect(observer.execute({ name: 'urgent' })).rejects.toBe(offline)

    expect(mutationFn).toHaveBeenCalledTimes(1)
    expect(observer.state.status).toBe('error')
    expect(observer.state.isPaused).toBe(false)
  })

  it('retries a read after a network failure or a 5xx, twice, and nothing else', () => {
    const network = new ApiError(0, ErrorCodes.NETWORK_UNAVAILABLE, 'x')
    expect(shouldRetry(0, network)).toBe(true)
    expect(shouldRetry(2, network)).toBe(false)
    expect(shouldRetry(0, new ApiError(503, ErrorCodes.INTERNAL_ERROR, 'x'))).toBe(true)
    expect(shouldRetry(0, new ApiError(403, ErrorCodes.PERMISSION_DENIED, 'x'))).toBe(false)
    expect(shouldRetry(0, new Error('x'))).toBe(false)
  })

  it('retries a busy database once, not twice, and a plain 503 still twice', () => {
    const busy = new ApiError(503, ClientErrorCodes.DATABASE_BUSY, 'The service is busy', null, {
      retryAfterSeconds: 5
    })
    expect(shouldRetry(0, busy)).toBe(true)
    expect(shouldRetry(1, busy)).toBe(false)
    const plain = new ApiError(503, ErrorCodes.INTERNAL_ERROR, 'x')
    expect(shouldRetry(1, plain)).toBe(true)
    expect(shouldRetry(2, plain)).toBe(false)
  })

  it('waits for the retry as long as the api asked, else the default growth', () => {
    const busy = (metadata: Record<string, unknown>): ApiError =>
      new ApiError(503, ClientErrorCodes.DATABASE_BUSY, 'busy', null, metadata)
    expect(retryDelayOf(0, busy({ retryAfterSeconds: 5 }))).toBe(5000)
    expect(retryDelayOf(0, busy({ retryAfterSeconds: 4.2 }))).toBe(5000)
    expect(retryDelayOf(0, busy({ retryAfterSeconds: 999 }))).toBe(30_000)
    // No usable number: the default growth
    expect(retryDelayOf(0, busy({}))).toBe(1000)
    expect(retryDelayOf(1, busy({ retryAfterSeconds: 'soon' }))).toBe(2000)
    expect(retryDelayOf(2, new ApiError(500, ErrorCodes.INTERNAL_ERROR, 'x'))).toBe(4000)
  })

  it('never retries a mutation by itself, a busy database included', async () => {
    const client = createQueryClient()
    expect(client.getDefaultOptions().mutations?.retry).toBe(false)
    const busy = new ApiError(503, ClientErrorCodes.DATABASE_BUSY, 'busy', null, {
      retryAfterSeconds: 5
    })
    const mutationFn = jest.fn().mockRejectedValue(busy)
    await expect(client.getMutationCache().build(client, { mutationFn }).execute({})).rejects.toBe(
      busy
    )
    expect(mutationFn).toHaveBeenCalledTimes(1)
  })

  it('wires both rules into the queries of the app', () => {
    const queries = createQueryClient().getDefaultOptions().queries
    expect(queries?.retry).toBe(shouldRetry)
    expect(queries?.retryDelay).toBe(retryDelayOf)
  })
})
