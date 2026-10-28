import { MetaGraphClient } from '@platform/channels/meta'
import { DeliveryStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type ChannelContext, PluginError } from '@platform/plugins/sdk'

import { WhatsAppPlugin } from './whatsapp.plugin'

const credentials = { phoneNumberId: '111', businessAccountId: '222', accessToken: 'tok' }
const ctx: ChannelContext = { storeId: 's', connectionId: '111', credentials, metadata: {} }
const key = { idempotencyKey: 'k' }

// What the plugin hands to the client, as far as these specs read it
interface GraphCall {
  path?: string[]
  token?: string
  body?: { type?: string }
  query?: Record<string, string>
}

const asyncMock = (): jest.Mock<Promise<unknown>, [GraphCall]> =>
  jest.fn<Promise<unknown>, [GraphCall]>()

function build(): { plugin: WhatsAppPlugin; meta: ReturnType<typeof buildMeta> } {
  const meta = buildMeta()
  // The plugin only calls these methods of the client, and each one is replaced here
  return { plugin: new WhatsAppPlugin(meta as unknown as MetaGraphClient), meta }
}

function buildMeta() {
  const meta = {
    get: asyncMock(),
    post: asyncMock(),
    downloadMedia: asyncMock(),
    isValidSignature: jest.fn<boolean, []>(),
    verifyHubChallenge: jest.fn<string | null, []>()
  }
  return meta
}

describe('WhatsAppPlugin', () => {
  it('declares the 24 hour window that asks for a template once it is closed', () => {
    expect(build().plugin.messagingWindow).toEqual({ hours: 24, requiresTemplateWhenClosed: true })
  })

  describe('connect', () => {
    it('reads the number, subscribes the app to the account and returns what to keep', async () => {
      const { plugin, meta } = build()
      meta.get
        .mockResolvedValueOnce({ display_phone_number: '+1 555-123-4567', verified_name: 'Shop' })
        .mockResolvedValueOnce({ data: [{ id: '111' }] })
      meta.post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      expect(meta.get).toHaveBeenCalledWith(
        expect.objectContaining({
          path: ['111'],
          token: 'tok',
          query: { fields: 'display_phone_number,verified_name' }
        })
      )
      expect(meta.post).toHaveBeenCalledWith(
        expect.objectContaining({ path: ['222', 'subscribed_apps'], token: 'tok' })
      )
      expect(result).toEqual({
        connectionId: '111',
        displayName: '+1 555-123-4567',
        credentials,
        metadata: { businessAccountId: '222', verifiedName: 'Shop' }
      })
    })

    it('refuses a number that is not under the account, and subscribes nothing', async () => {
      const { plugin, meta } = build()
      meta.get
        .mockResolvedValueOnce({ display_phone_number: '1' })
        .mockResolvedValueOnce({ data: [{ id: '999' }] })
      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
        retryable: false
      })
      expect(meta.post).not.toHaveBeenCalled()
    })

    it('refuses an account that does not take the subscription', async () => {
      const { plugin, meta } = build()
      meta.get
        .mockResolvedValueOnce({ display_phone_number: '1' })
        .mockResolvedValueOnce({ data: [{ id: '111' }] })
      meta.post.mockResolvedValue({ success: false })
      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
    })

    it.each([{}, { ...credentials, phoneNumberId: '../me' }, { ...credentials, accessToken: '' }])(
      'refuses credentials of the wrong shape (%o) before any call',
      async bad => {
        const { plugin, meta } = build()
        await expect(plugin.connect({ storeId: 's', credentials: bad })).rejects.toMatchObject({
          code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
          retryable: false
        })
        expect(meta.get).not.toHaveBeenCalled()
      }
    )
  })

  // The subscription is of the account, not of the number: deleting it would cut off the other
  // numbers of the same account, whose webhooks the core already drops for a connection it lacks
  it('leaves the subscription of the account alone on disconnect', async () => {
    const { plugin, meta } = build()
    await expect(plugin.disconnect()).resolves.toBeUndefined()
    expect(meta.get).not.toHaveBeenCalled()
    expect(meta.post).not.toHaveBeenCalled()
  })

  describe('healthCheck', () => {
    it('is healthy when the number can be read', async () => {
      const { plugin, meta } = build()
      meta.get.mockResolvedValue({ display_phone_number: '1' })
      await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })
    })

    it('lets the failure through, so the health service can tell a revoked token from an outage', async () => {
      const { plugin, meta } = build()
      const failure = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
      meta.get.mockRejectedValue(failure)
      await expect(plugin.healthCheck(ctx)).rejects.toBe(failure)
    })
  })

  describe('sending', () => {
    it('posts to the messages edge of the connection number and returns the id of the message', async () => {
      const { plugin, meta } = build()
      meta.post.mockResolvedValue({ messages: [{ id: 'wamid.1' }] })

      const result = await plugin.sendMessage(ctx, {
        channelIdentity: '15550001111',
        content: 'hi',
        ...key
      })

      expect(meta.post.mock.calls[0]?.[0]).toMatchObject({
        path: ['111', 'messages'],
        token: 'tok',
        body: { type: 'text', to: '15550001111' }
      })
      expect(result).toMatchObject({ externalId: 'wamid.1', status: DeliveryStatus.SENT })
    })

    it('does not call Meta for a message it refuses', async () => {
      const { plugin, meta } = build()
      await expect(
        plugin.sendMessage(ctx, { channelIdentity: 'not a number', content: 'hi', ...key })
      ).rejects.toBeInstanceOf(PluginError)
      expect(meta.post).not.toHaveBeenCalled()
    })

    it('sends media, a template, buttons and a location through the same edge', async () => {
      const { plugin, meta } = build()
      meta.post.mockResolvedValue({ messages: [{ id: 'wamid.2' }] })
      const to = '15550001111'
      await plugin.sendMedia(ctx, {
        channelIdentity: to,
        mediaUrl: 'https://x.test/a.png',
        contentType: 'image/png',
        filename: null,
        ...key
      })
      await plugin.sendTemplate(ctx, {
        channelIdentity: to,
        templateName: 'hello',
        language: 'en_US',
        variables: [],
        ...key
      })
      await plugin.sendButtons(ctx, {
        channelIdentity: to,
        content: 'c',
        buttons: [{ id: 'a', title: 'A' }],
        ...key
      })
      await plugin.sendLocation(ctx, { channelIdentity: to, latitude: 1, longitude: 2, ...key })
      expect(meta.post.mock.calls.map(([call]) => call.body?.type)).toEqual([
        'image',
        'template',
        'interactive',
        'location'
      ])
    })

    it('marks a message as read', async () => {
      const { plugin, meta } = build()
      meta.post.mockResolvedValue({ success: true })
      await plugin.markAsRead(ctx, { channelIdentity: '15550001111', externalId: 'wamid.3' })
      expect(meta.post.mock.calls[0]?.[0]).toMatchObject({
        body: { status: 'read', message_id: 'wamid.3' }
      })
    })
  })

  describe('listTemplates', () => {
    const page = (names: string[], after?: string): object => ({
      data: names.map(name => ({
        name,
        language: 'es',
        status: name.startsWith('ok')
          ? 'APPROVED'
          : name.startsWith('wait')
            ? 'IN_APPEAL'
            : 'PAUSED',
        components: [
          { type: 'HEADER', format: 'TEXT', text: 'h' },
          { type: 'BODY', text: `body of ${name}` }
        ]
      })),
      ...(after ? { paging: { cursors: { after }, next: 'https://graph.facebook.com/next' } } : {})
    })

    it('maps the status and the body, and follows the pages', async () => {
      const { plugin, meta } = build()
      meta.get
        .mockResolvedValueOnce(page(['ok1', 'wait1'], 'c1'))
        .mockResolvedValueOnce(page(['bad1']))

      const templates = await plugin.listTemplates(ctx)

      expect(templates).toEqual([
        { name: 'ok1', language: 'es', status: 'approved', body: 'body of ok1' },
        { name: 'wait1', language: 'es', status: 'pending', body: 'body of wait1' },
        { name: 'bad1', language: 'es', status: 'rejected', body: 'body of bad1' }
      ])
      expect(meta.get.mock.calls[1]?.[0]).toMatchObject({ query: { after: 'c1' } })
    })

    it('lists only the templates it can fill: body text, with static header, footer and buttons', async () => {
      const { plugin, meta } = build()
      const template = (name: string, components: object[]): object => ({
        name,
        language: 'es',
        status: 'APPROVED',
        components
      })
      meta.get.mockResolvedValue({
        data: [
          template('plain', [
            { type: 'BODY', text: 'hi {{1}}' },
            { type: 'FOOTER', text: 'f' }
          ]),
          template('text_header', [
            { type: 'HEADER', format: 'TEXT', text: 'Hello' },
            { type: 'BODY', text: 'b' }
          ]),
          template('static_buttons', [
            { type: 'BODY', text: 'b' },
            {
              type: 'BUTTONS',
              buttons: [
                { type: 'QUICK_REPLY', text: 'ok' },
                { type: 'URL', text: 'go', url: 'https://x.test/a' }
              ]
            }
          ]),
          template('media_header', [
            { type: 'HEADER', format: 'IMAGE' },
            { type: 'BODY', text: 'b' }
          ]),
          template('header_variable', [
            { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' },
            { type: 'BODY', text: 'b' }
          ]),
          template('url_variable', [
            { type: 'BODY', text: 'b' },
            { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'go', url: 'https://x.test/{{1}}' }] }
          ]),
          template('copy_code', [
            { type: 'BODY', text: 'b' },
            { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE' }] }
          ]),
          template('otp', [
            { type: 'BODY', text: 'b' },
            { type: 'BUTTONS', buttons: [{ type: 'OTP' }] }
          ]),
          template('named', [{ type: 'BODY', text: 'Hola {{first_name}}' }]),
          template('carousel', [{ type: 'BODY', text: 'b' }, { type: 'CAROUSEL' }])
        ]
      })
      const names = (await plugin.listTemplates(ctx)).map(t => t.name)
      expect(names).toEqual(['plain', 'text_header', 'static_buttons'])
    })

    it('stops after a bounded number of pages', async () => {
      const { plugin, meta } = build()
      meta.get.mockResolvedValue(page(['ok'], 'again'))
      await plugin.listTemplates(ctx)
      expect(meta.get).toHaveBeenCalledTimes(5)
    })
  })

  describe('webhooks and media', () => {
    it('leaves the signature and the handshake to the Meta client', () => {
      const { plugin, meta } = build()
      meta.isValidSignature.mockReturnValue(true)
      meta.verifyHubChallenge.mockReturnValue('42')
      expect(plugin.validateWebhookSignature('{}', { 'x-hub-signature-256': 'x' })).toBe(true)
      expect(plugin.verifyWebhook({ 'hub.challenge': '42' })).toBe('42')
    })

    it('downloads media with the token of the connection', async () => {
      const { plugin, meta } = build()
      const fetched = { stream: {}, contentType: 'image/jpeg', contentLength: 3 }
      meta.downloadMedia.mockResolvedValue(fetched)
      await expect(plugin.fetchMedia(ctx, '123')).resolves.toBe(fetched)
      expect(meta.downloadMedia).toHaveBeenCalledWith('tok', '123')
    })
  })
})

// The real client under the plugin, with Meta's answers: what the agent finally sees
describe('WhatsAppPlugin over the Meta client', () => {
  const plugin = new WhatsAppPlugin(
    new MetaGraphClient({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
  )
  const answer = (body: unknown, status: number): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  const send = (): Promise<unknown> =>
    plugin.sendMessage(ctx, { channelIdentity: '15550001111', content: 'hi', ...key })

  afterEach(() => jest.restoreAllMocks())

  it.each([
    [131047, ErrorCodes.CHANNEL_WINDOW_EXPIRED],
    [132001, ErrorCodes.CHANNEL_TEMPLATE_NOT_APPROVED],
    [190, ErrorCodes.CHANNEL_CREDENTIALS_INVALID],
    [131026, ErrorCodes.CHANNEL_MESSAGE_FAILED]
  ])('turns the Meta error %i of a send into %s, for good', async (code, expected) => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer({ error: { code } }, 400))
    await expect(send()).rejects.toMatchObject({ code: expected, retryable: false })
  })

  it('does not take an answer with no message id as a send', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue(answer({ messages: [] }, 200))
    await expect(send()).rejects.toMatchObject({
      code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
      retryable: false
    })
  })

  it('sends the number, the reply target and the token as given', async () => {
    const fetchMock = jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(answer({ messages: [{ id: 'wamid.1' }] }, 200))
    await plugin.sendMessage(ctx, {
      channelIdentity: '15550001111',
      content: 'hi',
      replyToExternalId: 'wamid.0',
      ...key
    })
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://graph.facebook.com/v23.0/111/messages')
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok' })
    expect(JSON.parse(init.body as string)).toMatchObject({
      to: '15550001111',
      context: { message_id: 'wamid.0' }
    })
  })

  it('does not report a connection when the subscription fails', async () => {
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(answer({ display_phone_number: '1' }, 200))
      .mockResolvedValueOnce(answer({ data: [{ id: '111' }] }, 200))
      .mockResolvedValueOnce(answer({ error: { code: 190 } }, 401))
    await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
      code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
    })
  })
})
