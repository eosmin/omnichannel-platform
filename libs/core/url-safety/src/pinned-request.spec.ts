import { Agent } from 'node:https'

import { openPinnedRequest } from './pinned-request'
import type { HttpsRequester } from './pinned-request'
import type { PublicTarget } from './public-url'

const target = (host: string, addresses: string[]): PublicTarget => ({
  url: new URL(`https://${host}/in?x=1`),
  addresses
})

function recorded() {
  const calls: Record<string, unknown>[] = []
  const request = ((options: Record<string, unknown>) => {
    calls.push(options)
    return {}
  }) as unknown as HttpsRequester
  return { calls, request }
}

describe('openPinnedRequest', () => {
  it('connects to the checked addresses only, over https, with a socket of its own and the name as the certificate name', async () => {
    const { calls, request } = recorded()

    openPinnedRequest(target('hooks.example.com', ['8.8.8.8']), {
      method: 'POST',
      headers: { 'x-a': '1' },
      timeoutMs: 700,
      request
    })

    expect(calls[0]).toMatchObject({
      protocol: 'https:',
      hostname: 'hooks.example.com',
      port: 443,
      path: '/in?x=1',
      method: 'POST',
      headers: { 'x-a': '1' },
      servername: 'hooks.example.com',
      timeout: 700
    })
    const agent = calls[0]?.['agent'] as Agent
    expect(agent).toBeInstanceOf(Agent)
    expect(agent.options.keepAlive).toBe(false)
    const lookup = calls[0]?.['lookup'] as (
      host: string,
      options: object,
      callback: (error: unknown, address: string, family: number) => void
    ) => void
    const answered = await new Promise<string>(resolve => {
      lookup('hooks.example.com', {}, (_error, address) => {
        resolve(address)
      })
    })
    expect(answered).toBe('8.8.8.8')
  })

  it('sets no certificate name for a literal address, and keeps the port it is given', () => {
    const { calls, request } = recorded()

    openPinnedRequest(target('8.8.4.4', ['8.8.4.4']), {
      method: 'GET',
      port: 8443,
      headers: {},
      timeoutMs: 5,
      request
    })

    expect(calls[0]).toMatchObject({ hostname: '8.8.4.4', port: 8443, method: 'GET' })
    expect(calls[0]).not.toHaveProperty('servername')
  })

  it('does not share the headers object with the caller', () => {
    const { calls, request } = recorded()
    const headers = { 'x-a': '1' }

    openPinnedRequest(target('hooks.example.com', ['8.8.8.8']), {
      method: 'POST',
      headers,
      timeoutMs: 5,
      request
    })

    expect(calls[0]?.['headers']).not.toBe(headers)
  })
})
