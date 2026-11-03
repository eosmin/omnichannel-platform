import { onlineManager } from '@tanstack/react-query'

import { ApiError } from '@platform/api-client'
import { ErrorCodes } from '@platform/core/errors'

import { createQueryClient, shouldRetry } from './query-client'

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
})
