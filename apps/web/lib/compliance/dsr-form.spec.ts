import { ApiRoutes } from '@platform/core/api'

import en from '../../messages/en.json'
import es from '../../messages/es.json'

import { fetchDsrForm, makeDsrFormKey, revokeDsrFormKey } from './dsr-form'

// A client that answers what it is told and remembers what it was asked
function clientAnswering(answer: unknown): {
  client: Parameters<typeof fetchDsrForm>[0]
  asked: { path: string; options: Record<string, unknown> }[]
} {
  const asked: { path: string; options: Record<string, unknown> }[] = []
  const client = {
    request: (
      path: string,
      options: { schema: { parse: (raw: unknown) => unknown } } & Record<string, unknown>
    ) => {
      asked.push({ path, options })
      // Like the real client: a bad answer is a rejected promise, not a throw before one exists
      return Promise.resolve().then(() => options.schema.parse(answer))
    }
  } as unknown as Parameters<typeof fetchDsrForm>[0]
  return { client, asked }
}

describe('the calls of the public form key', () => {
  it('reads the key of the store in the header, with no body', async () => {
    const { client, asked } = clientAnswering({ key: 'k'.repeat(22), open: false })
    expect(await fetchDsrForm(client, 'store-1')).toEqual({ key: 'k'.repeat(22), open: false })
    expect(asked[0]?.path).toBe(ApiRoutes.compliance.dsrForm)
    expect(asked[0]?.options).toMatchObject({ storeId: 'store-1' })
    expect(asked[0]?.options['method']).toBeUndefined()
  })

  it('sends the key the screen showed with a change, so the api can refuse a stale one', async () => {
    const { client, asked } = clientAnswering({ key: null, open: true })
    await makeDsrFormKey(client, 'store-1', null)
    await makeDsrFormKey(client, 'store-1', 'old'.repeat(8))
    expect(asked.map(call => call.path)).toEqual([
      ApiRoutes.compliance.dsrFormKey,
      ApiRoutes.compliance.dsrFormKey
    ])
    expect(asked.map(call => call.options['body'])).toEqual([
      { current: null },
      { current: 'old'.repeat(8) }
    ])
    expect(asked.every(call => call.options['method'] === 'POST')).toBe(true)
  })

  it('switches off through its own route with the key it saw', async () => {
    const { client, asked } = clientAnswering({ key: null, open: false })
    await revokeDsrFormKey(client, 'store-1', 'old'.repeat(8))
    expect(asked[0]?.path).toBe(ApiRoutes.compliance.dsrFormKeyRevoke)
    expect(asked[0]?.options['body']).toEqual({ current: 'old'.repeat(8) })
  })

  it('refuses an answer that does not say whether the form is open', async () => {
    const { client } = clientAnswering({ key: null })
    await expect(fetchDsrForm(client, 'store-1')).rejects.toThrow()
  })
})

describe.each([
  ['en', en.settings.dsrForm],
  ['es', es.settings.dsrForm]
])('the texts of the public form in %s', (_language, messages) => {
  it('has the words of every state and of both confirmations', () => {
    for (const block of [messages.replace, messages.off]) {
      for (const key of ['action', 'title', 'description', 'confirm'] as const) {
        expect(block[key].length).toBeGreaterThan(0)
      }
    }
    expect(Object.keys(messages.done).sort()).toEqual(['make', 'replace', 'revoke'])
    expect(Object.keys(messages.state).sort()).toEqual(['open', 'shut'])
  })
})
