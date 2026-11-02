import { isServerMessage, WidgetApi, WidgetApiError } from './api'

const BOOTSTRAP = {
  visitorToken: 'token',
  expiresInSeconds: 3600,
  store: { name: 'Shop', locale: 'es' },
  away: false,
  preChat: true,
  readUpToMessageId: null,
  messages: [
    {
      id: 'm1',
      from: 'team',
      content: 'hola',
      attachments: [],
      createdAt: '2026-01-01T00:00:00.000Z'
    }
  ]
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

  it('sends the profile beside the message when there is one', async () => {
    const request = answering(200, { received: true })

    await new WidgetApi('https://api.test', request).send('tok', 'id-1', 'hola', { name: 'Ana' })

    expect(request).toHaveBeenCalledWith(
      'https://api.test/widget/messages',
      expect.objectContaining({
        body: JSON.stringify({
          visitorToken: 'tok',
          clientMessageId: 'id-1',
          content: 'hola',
          profile: { name: 'Ana' }
        })
      })
    )
  })

  it('sends the ids of the files and leaves out the text when there is none', async () => {
    const request = answering(200, { received: true })

    await new WidgetApi('https://api.test', request).send('tok', 'id-1', '', undefined, ['u1'])

    expect(request).toHaveBeenCalledWith(
      'https://api.test/widget/messages',
      expect.objectContaining({
        body: JSON.stringify({ visitorToken: 'tok', clientMessageId: 'id-1', uploadIds: ['u1'] })
      })
    )
  })

  it('asks for a signed url with the name, type and size of the file', async () => {
    const request = answering(200, { uploadUrl: 'https://b/x', uploadId: 'u1' })

    const slot = await new WidgetApi('https://api.test', request).requestUpload('tok', {
      name: 'a.png',
      type: 'image/png',
      size: 3
    })

    expect(slot).toEqual({ uploadUrl: 'https://b/x', uploadId: 'u1' })
    expect(request).toHaveBeenCalledWith(
      'https://api.test/widget/upload-url',
      expect.objectContaining({
        body: JSON.stringify({
          visitorToken: 'tok',
          filename: 'a.png',
          contentType: 'image/png',
          fileSizeBytes: 3
        })
      })
    )
  })

  it('refuses an answer that is not a signed url or a link', async () => {
    const api = new WidgetApi('https://api.test', answering(200, { url: 5 }))

    await expect(api.requestUpload('t', { name: 'a', type: 'b', size: 1 })).rejects.toBeInstanceOf(
      WidgetApiError
    )
    await expect(api.fileLink('t', 'm')).rejects.toBeInstanceOf(WidgetApiError)
  })

  it('asks for the link of a file', async () => {
    const link = {
      url: 'https://b/f',
      filename: 'a.png',
      contentType: 'image/png',
      previewUrl: null
    }
    const request = answering(200, link)

    expect(await new WidgetApi('https://api.test', request).fileLink('tok', 'm1')).toEqual(link)
    expect(request).toHaveBeenCalledWith(
      'https://api.test/widget/download-url',
      expect.objectContaining({ body: JSON.stringify({ visitorToken: 'tok', mediaId: 'm1' }) })
    )
  })

  it('reads the fields a validation error names', async () => {
    const body = {
      error: {
        code: 'VALIDATION_FAILED',
        metadata: { issues: [{ path: 'profile.phone', code: 'invalid_phone' }, { code: 'x' }] }
      }
    }

    const error = await new WidgetApi('https://api.test', answering(400, body))
      .send('t', 'i', 'x')
      .catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(WidgetApiError)
    expect((error as WidgetApiError).phoneRefused).toBe(true)
    expect((error as WidgetApiError).issuePaths).toEqual(['profile.phone'])
  })

  it('refuses a bootstrap that does not say whether to ask for the form', async () => {
    const incomplete: Partial<typeof BOOTSTRAP> = { ...BOOTSTRAP }
    delete incomplete.preChat

    await expect(
      new WidgetApi('https://api.test', answering(200, incomplete)).bootstrap('pk_x', 'visitor')
    ).rejects.toBeInstanceOf(WidgetApiError)
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
    expect(
      isServerMessage({ id: 'a', from: 'visitor', content: 'x', attachments: [], createdAt: 'd' })
    ).toBe(true)
    expect(
      isServerMessage({ id: 'a', from: 'bot', content: 'x', attachments: [], createdAt: 'd' })
    ).toBe(false)
    expect(isServerMessage({ id: 'a', from: 'team', createdAt: 'd' })).toBe(false)
    expect(isServerMessage(null)).toBe(false)
  })

  it('needs the files to be well formed', () => {
    const base = { id: 'a', from: 'team', content: '', createdAt: 'd' }
    const file = { id: 'f', filename: 'a.png', contentType: 'image/png', size: 3 }

    expect(isServerMessage({ ...base, attachments: [file] })).toBe(true)
    expect(isServerMessage({ ...base, attachments: [{ ...file, size: '3' }] })).toBe(false)
    expect(isServerMessage(base)).toBe(false)
  })
})
