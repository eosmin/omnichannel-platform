import { isServerMessage, WidgetApi, WidgetApiError } from './api'

const BOOTSTRAP = {
  visitorToken: 'token',
  expiresInSeconds: 3600,
  store: { name: 'Shop', locale: 'es' },
  away: false,
  readUpToMessageId: null,
  messages: [{ id: 'm1', from: 'team', content: 'hola', createdAt: '2026-01-01T00:00:00.000Z' }]
}

// jsdom has no fetch: the api only reads `ok`, `status` and the json of an answer
function answering(status: number, body: unknown): typeof fetch {
  const answer = { ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) }
  return jest.fn(() => Promise.resolve(answer)) as unknown as typeof fetch
}

describe('WidgetApi', () => {
  it('asks for a session and returns it', async () => {
    const request = answering(200, BOOTSTRAP)

    const boot = await new WidgetApi('https://api.test/api/v1', request).bootstrap(
      'pk_x',
      'visitor'
    )

    expect(boot).toEqual(BOOTSTRAP)
    expect(request).toHaveBeenCalledWith(
      'https://api.test/api/v1/widget/bootstrap',
      expect.objectContaining({
        method: 'POST',
        credentials: 'omit',
        body: JSON.stringify({ siteKey: 'pk_x', visitorId: 'visitor' })
      })
    )
  })

  it('sends the token in the body beside the message', async () => {
    const request = answering(200, { received: true })

    await new WidgetApi('https://api.test', request).send('tok', 'id-1', 'hola')

    expect(request).toHaveBeenCalledWith(
      'https://api.test/widget/messages',
      expect.objectContaining({
        body: JSON.stringify({ visitorToken: 'tok', clientMessageId: 'id-1', content: 'hola' })
      })
    )
  })

  it('reports the code of a refusal and whether waiting would help', async () => {
    const api = new WidgetApi(
      'https://api.test',
      answering(401, { error: { code: 'WIDGET_TOKEN_INVALID' } })
    )

    const error = await api.send('tok', 'id', 'x').catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WidgetApiError)
    expect(error).toMatchObject({ status: 401, tokenInvalid: true, permanent: false })
  })

  it.each([403, 404])('treats a %s as permanent', async status => {
    const api = new WidgetApi('https://api.test', answering(status, { error: { code: 'X' } }))

    await expect(api.bootstrap('pk', 'v')).rejects.toMatchObject({ permanent: true })
  })

  it('reports a network that is down as status 0', async () => {
    const down = jest.fn(() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch

    await expect(
      new WidgetApi('https://api.test', down).bootstrap('pk', 'v')
    ).rejects.toMatchObject({
      status: 0,
      permanent: false
    })
  })

  it('takes the id of the last message that was read, or none', async () => {
    const read = answering(200, { ...BOOTSTRAP, readUpToMessageId: 'm1' })

    expect(
      (await new WidgetApi('https://api.test', read).bootstrap('pk', 'v')).readUpToMessageId
    ).toBe('m1')
  })

  it('does not accept an answer that leaves out the id of the last message read', async () => {
    const without: Partial<typeof BOOTSTRAP> = { ...BOOTSTRAP }
    delete without.readUpToMessageId
    const api = new WidgetApi('https://api.test', answering(200, without))

    await expect(api.bootstrap('pk', 'v')).rejects.toBeInstanceOf(WidgetApiError)
  })

  it('does not accept an answer of another shape', async () => {
    const api = new WidgetApi('https://api.test', answering(200, { visitorToken: 1 }))

    await expect(api.bootstrap('pk', 'v')).rejects.toBeInstanceOf(WidgetApiError)
  })
})

describe('isServerMessage', () => {
  it('only takes a message from the visitor or the team with text', () => {
    expect(isServerMessage({ id: 'a', from: 'visitor', content: 'x', createdAt: 'd' })).toBe(true)
    expect(isServerMessage({ id: 'a', from: 'bot', content: 'x', createdAt: 'd' })).toBe(false)
    expect(isServerMessage({ id: 'a', from: 'team', createdAt: 'd' })).toBe(false)
    expect(isServerMessage(null)).toBe(false)
  })
})
