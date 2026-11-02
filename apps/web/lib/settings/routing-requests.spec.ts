import { ApiError, createApiClient } from '@platform/api-client'
import { TenantHeaders } from '@platform/core/auth'
import { RoutingActionTypes } from '@platform/core/domain'

import { createRule, deleteRule, fetchRules, reorderRules, updateRule } from './routing-requests'

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          })
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  const call = () => fetchImpl.mock.calls[0] ?? []
  return { client, call }
}

const rule = {
  id: 'r1',
  name: 'VIP',
  priority: 0,
  enabled: true,
  conditions: { channelTypes: ['whatsapp'], outsideBusinessHours: true as const },
  action: { type: RoutingActionTypes.ROUND_ROBIN, userIds: ['u1', 'u2'] }
}

function bodyOf(init: RequestInit | undefined): unknown {
  return typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
}

function header(init: RequestInit | undefined, name: string): string | null {
  return new Headers(init?.headers).get(name)
}

describe('routing requests', () => {
  it('reads the rules of the store named in X-Store-Id', async () => {
    const { client, call } = setup([rule])
    await expect(fetchRules(client, 's1')).resolves.toEqual([rule])
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/routing')
    expect(header(call()[1], TenantHeaders.STORE_ID)).toBe('s1')
  })

  it('refuses an answer whose action is none of the known ones', async () => {
    const { client } = setup([{ ...rule, action: { type: 'shout' } }])
    await expect(fetchRules(client, 's1')).rejects.toBeInstanceOf(Error)
  })

  it('creates a rule with the four fields and no priority', async () => {
    const { client, call } = setup(rule)
    const input = {
      name: rule.name,
      enabled: true,
      conditions: rule.conditions,
      action: rule.action
    }
    await createRule(client, 's1', input)
    expect(call()[1]?.method).toBe('POST')
    expect(bodyOf(call()[1])).toEqual(input)
  })

  it('updates and deletes a rule by an escaped id', async () => {
    const updated = setup(rule)
    await updateRule(updated.client, 's1', 'r/1', { enabled: false })
    expect(updated.call()[0]).toBe('https://api.example.com/api/v1/settings/routing/r%2F1')
    expect(updated.call()[1]?.method).toBe('PATCH')
    expect(bodyOf(updated.call()[1])).toEqual({ enabled: false })

    const deleted = setup(null, 204)
    await expect(deleteRule(deleted.client, 's1', 'r1')).resolves.toBeUndefined()
    expect(deleted.call()[1]?.method).toBe('DELETE')
  })

  it('sends the whole order to the order route, not an id', async () => {
    const { client, call } = setup([rule])
    await reorderRules(client, 's1', ['b', 'a'])
    expect(call()[0]).toBe('https://api.example.com/api/v1/settings/routing/order')
    expect(call()[1]?.method).toBe('PATCH')
    expect(bodyOf(call()[1])).toEqual({ ruleIds: ['b', 'a'] })
  })

  it('shows the code of a refusal', async () => {
    const { client } = setup(
      { error: { code: 'RESOURCE_NOT_FOUND', message: 'x' }, correlationId: 'c1' },
      404
    )
    await expect(fetchRules(client, 's1')).rejects.toBeInstanceOf(ApiError)
  })
})
