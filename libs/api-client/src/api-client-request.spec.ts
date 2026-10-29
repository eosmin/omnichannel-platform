import { z } from 'zod'

import { ErrorCodes } from '@platform/core/errors'

import { createApiClient } from './api-client'
import { ApiError } from './api-error'

const BASE = 'https://api.example.com'
const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const errorBody = (code: string): unknown => ({
  error: { code, message: code, metadata: {} },
  correlationId: 'c-1'
})

function setup(responses: Response[], token: string | null = 'old') {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>()
  responses.forEach(response => fetchImpl.mockResolvedValueOnce(response))
  const state = { token }
  const refreshAccessToken = jest.fn(() => {
    state.token = 'new'
    return Promise.resolve('new')
  })
  const client = createApiClient({
    baseUrl: BASE,
    getAccessToken: () => state.token,
    refreshAccessToken,
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl, refreshAccessToken }
}

const schema = z.object({ ok: z.literal(true) })

describe('createApiClient', () => {
  it('prefixes the path and sends the token and the store', async () => {
    const { client, fetchImpl } = setup([json(200, { ok: true })])
    await client.request('/conversations', { schema, storeId: 's1' })
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe(`${BASE}/api/v1/conversations`)
    expect(init?.headers).toEqual({ authorization: 'Bearer old', 'x-store-id': 's1' })
  })

  it('sends a JSON body with its content type', async () => {
    const { client, fetchImpl } = setup([json(200, { ok: true })])
    await client.request('/x', { method: 'POST', body: { a: 1 }, schema })
    const init = fetchImpl.mock.calls[0]?.[1]
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"a":1}')
    expect(init?.headers).toMatchObject({ 'content-type': 'application/json' })
  })

  it('asks for a token before the first request when the page has none', async () => {
    const { client, fetchImpl, refreshAccessToken } = setup([json(200, { ok: true })], null)
    await client.request('/x', { schema })
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl.mock.calls[0]?.[1].headers).toMatchObject({ authorization: 'Bearer new' })
  })

  it('sends no token and never refreshes on a public route', async () => {
    const { client, fetchImpl, refreshAccessToken } = setup([json(200, { ok: true })], null)
    await client.request('/x', { schema, authenticated: false })
    expect(refreshAccessToken).not.toHaveBeenCalled()
    expect(fetchImpl.mock.calls[0]?.[1].headers).toEqual({})
  })

  it('refreshes once and retries when the access token has expired', async () => {
    const { client, fetchImpl, refreshAccessToken } = setup([
      json(401, errorBody(ErrorCodes.AUTH_TOKEN_EXPIRED)),
      json(200, { ok: true })
    ])
    await expect(client.request('/x', { schema })).resolves.toEqual({ ok: true })
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(fetchImpl.mock.calls[1]?.[1].headers).toMatchObject({ authorization: 'Bearer new' })
  })

  it('does not retry a second time when the new token is also refused', async () => {
    const { client, fetchImpl } = setup([
      json(401, errorBody(ErrorCodes.AUTH_TOKEN_EXPIRED)),
      json(401, errorBody(ErrorCodes.AUTH_TOKEN_EXPIRED))
    ])
    await expect(client.request('/x', { schema })).rejects.toMatchObject({ status: 401 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('refreshes once for any 401, since a revoked token is refused with another code', async () => {
    const { client, refreshAccessToken } = setup([
      json(401, errorBody(ErrorCodes.AUTH_TOKEN_INVALID)),
      json(200, { ok: true })
    ])
    await expect(client.request('/x', { schema })).resolves.toEqual({ ok: true })
    expect(refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('throws the error contract with its code and correlation id', async () => {
    const { client } = setup([json(403, errorBody(ErrorCodes.AUTH_UNAUTHORIZED))])
    const error = await client.request('/x', { schema }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(error).toMatchObject({
      status: 403,
      code: ErrorCodes.AUTH_UNAUTHORIZED,
      correlationId: 'c-1'
    })
  })

  it('turns an answer that is not the contract into an internal error', async () => {
    const { client } = setup([new Response('<html>', { status: 502 })])
    await expect(client.request('/x', { schema })).rejects.toMatchObject({
      status: 502,
      code: ErrorCodes.INTERNAL_ERROR
    })
  })

  it('turns a network failure into an error with status 0', async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new TypeError('failed'))
    const client = createApiClient({
      baseUrl: BASE,
      getAccessToken: () => 't',
      refreshAccessToken: jest.fn(),
      fetchImpl
    })
    await expect(client.request('/x', { schema })).rejects.toMatchObject({ status: 0 })
  })

  it('refuses a body that does not match the schema', async () => {
    const { client } = setup([json(200, { ok: false })])
    await expect(client.request('/x', { schema })).rejects.toThrow()
  })

  it('reads a 204 as undefined', async () => {
    const { client } = setup([new Response(null, { status: 204 })])
    await expect(
      client.request('/x', { method: 'DELETE', schema: z.undefined() })
    ).resolves.toBeUndefined()
  })
})
