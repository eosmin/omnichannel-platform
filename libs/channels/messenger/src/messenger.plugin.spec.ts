import { Readable } from 'node:stream'

import { MetaGraphClient, metaTokenCredentialsSchema } from '@platform/channels/meta'
import {
  ChannelSetupStepKeys,
  MessengerApi,
  MetaGraph,
  MetaSubscribableFields
} from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes, PluginChecks } from '@platform/core/errors'
import { type ChannelContext, ChannelCapability, PluginError } from '@platform/plugins/sdk'

import { MessengerPlugin } from './messenger.plugin'

// The plugin hands the opener to the client, which opens the file only after everything refusable was refused
const opensTheFile = (): Promise<NodeJS.ReadableStream> => Promise.resolve(Readable.from([]))

const credentials = { accessToken: 'EAAB-page-token' }
const ctx: ChannelContext = {
  storeId: 's',
  connectionId: '1090000000000001',
  credentials,
  metadata: {}
}
const key = { idempotencyKey: 'k' }

// What the plugin asks the client to upload and send
interface UploadCall {
  origin?: string
  path: string[]
  token: string
  fields: Record<string, string>
  fileField?: string
  fileName?: string
  safeToRepeat?: boolean
  file: { open: () => Promise<NodeJS.ReadableStream>; contentType: string; size: number }
}

interface GraphCall {
  origin?: string
  path?: string[]
  token?: string
  body?: Record<string, unknown>
  query?: Record<string, string>
  schema?: { parse: (value: unknown) => unknown }
}

const APP = '1804256354142951'

// The two reads a connect makes after the account: the app of the token, and the fields that app has on
// the Page (none yet). Answered by route, so the order of the reads does not matter; the reads of the
// account a test queues with `mockResolvedValueOnce` come first.
function subscriptionReads(get: jest.Mock<Promise<unknown>, [GraphCall]>): void {
  get.mockImplementation(request =>
    request.path?.[0] === 'app'
      ? Promise.resolve({ id: APP })
      : request.path?.[1] === 'subscribed_apps'
        ? Promise.resolve({ data: [] })
        : Promise.reject(new Error('a read the test did not queue'))
  )
}

function buildReal(): MessengerPlugin {
  return new MessengerPlugin(
    new MetaGraphClient({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
  )
}

function build(): {
  plugin: MessengerPlugin
  get: jest.Mock<Promise<unknown>, [GraphCall]>
  post: jest.Mock<Promise<unknown>, [GraphCall]>
  upload: jest.Mock<Promise<unknown>, [UploadCall]>
} {
  const get = jest.fn<Promise<unknown>, [GraphCall]>()
  const post = jest.fn<Promise<unknown>, [GraphCall]>()
  const upload = jest.fn<Promise<unknown>, [UploadCall]>()
  // The plugin only calls these methods of the client, and each one is replaced here
  const meta = { get, post, uploadMedia: upload } as unknown as MetaGraphClient
  return { plugin: new MessengerPlugin(meta), get, post, upload }
}

describe('MessengerPlugin', () => {
  it('asks, in its connect form, for the one token its credentials need, as a secret', () => {
    const { plugin } = build()
    expect(plugin.connectFields.map(field => field.key)).toEqual(
      Object.keys(metaTokenCredentialsSchema.shape)
    )
    expect(plugin.connectFields.every(field => field.secret && field.required)).toBe(true)
    expect(plugin.receivesProviderWebhooks).toBe(true)
  })

  it('names the step the owner takes on the Page so that customer profiles can be read', () => {
    expect(build().plugin.profileSetupKey).toBe(ChannelSetupStepKeys.MESSENGER_PROFILE_ACCESS)
  })

  it('declares what it can do, with no buttons', () => {
    const { plugin } = build()
    expect(plugin.capabilities).toEqual(
      expect.arrayContaining([
        ChannelCapability.TEXT,
        ChannelCapability.DOCUMENT,
        ChannelCapability.REACTIONS,
        ChannelCapability.MESSAGING_WINDOW
      ])
    )
    expect(plugin.capabilities).not.toContain(ChannelCapability.BUTTONS)
    expect(plugin.capabilities).toContain(ChannelCapability.REPLY_TO)
    expect(plugin.messagingWindow.extendedHoursAfterAd).toBe(168)
  })

  describe('connect', () => {
    it('names the call that failed, with the numbers of the answer and nothing else, and stops there', async () => {
      const refusal = (): PluginError =>
        new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, providerCode: 100 })

      const reading = build()
      reading.get.mockRejectedValue(refusal())
      await expect(reading.plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        failedCheck: PluginChecks.ACCOUNT_READ_FAILED,
        providerCode: 100
      })
      expect(reading.post).not.toHaveBeenCalled()

      const subscribing = build()
      subscribing.get.mockResolvedValueOnce({ id: '1090000000000001' })
      subscribing.get.mockResolvedValueOnce({ id: '1090000000000001', name: 'Mi Tienda' })
      subscriptionReads(subscribing.get)
      subscribing.post.mockRejectedValue(refusal())
      await expect(subscribing.plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject(
        {
          failedCheck: PluginChecks.SUBSCRIBE_FAILED,
          providerCode: 100
        }
      )
    })

    it('asks for names the Page edge accepts', () => {
      for (const name of MessengerApi.SUBSCRIBED_FIELDS.split(',')) {
        expect(MetaSubscribableFields.PAGE).toContain(name)
      }
    })

    it('reads the Page of the token and subscribes the app to it', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockResolvedValueOnce({ id: '1090000000000001', name: 'Mi Tienda' })
      subscriptionReads(get)
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      // The id first, alone: it needs no permission. The name is a second, separate read.
      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['me'],
        query: { fields: 'id' }
      })
      expect(get.mock.calls[1]?.[0]).toMatchObject({ path: ['me'], query: { fields: 'id,name' } })
      // Then what the app already has on the Page, to add to it and not post over it
      expect(get.mock.calls[2]?.[0]).toMatchObject({ path: ['app'], query: { fields: 'id' } })
      expect(get.mock.calls[3]?.[0]).toMatchObject({
        path: ['1090000000000001', 'subscribed_apps']
      })
      expect(post.mock.calls[0]?.[0]).toMatchObject({
        path: ['1090000000000001', 'subscribed_apps'],
        query: {
          subscribed_fields:
            'messages,message_echoes,message_reactions,message_edits,messaging_referrals'
        }
      })
      expect(result).toEqual({
        connectionId: '1090000000000001',
        displayName: 'Mi Tienda',
        credentials,
        metadata: {}
      })
    })

    it('subscribes only to names the Messenger API accepts, as Meta does (error 100 otherwise)', async () => {
      const { plugin, get, post } = build()
      get.mockImplementation(request =>
        Promise.resolve(
          request.path?.[0] === 'app'
            ? { id: APP }
            : request.path?.[1] === 'subscribed_apps'
              ? { data: [] }
              : { id: '1090000000000001', name: 'Mi Tienda' }
        )
      )
      post.mockImplementation(request => {
        const unknown = (request.query?.subscribed_fields ?? '')
          .split(',')
          .filter(name => !(MetaSubscribableFields.PAGE as readonly string[]).includes(name))
        return unknown.length === 0
          ? Promise.resolve({ success: true })
          : Promise.reject(new Error(`Param subscribed_fields must be valid: ${unknown.join()}`))
      })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        connectionId: '1090000000000001'
      })
    })

    it('connects with the fallback name when Meta answers the name read with an id and no name', async () => {
      const { plugin, get, post } = build()
      // The real client validates the answer with the schema of the call: a 200 without `name` must pass it
      get.mockImplementation(request =>
        Promise.resolve(
          request.path?.[0] === 'app'
            ? { id: APP }
            : request.path?.[1] === 'subscribed_apps'
              ? { data: [] }
              : request.schema?.parse({ id: '1090000000000001' })
        )
      )
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('connects with a fallback name when the token cannot read the name of the Page', async () => {
      const { plugin, get, post } = build()
      // Error 100 of a token without pages_read_engagement: the id was readable, the name was not
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockRejectedValueOnce(
        new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { retryable: false, providerCode: 100 })
      )
      subscriptionReads(get)
      post.mockResolvedValue({ success: true })

      const result = await plugin.connect({ storeId: 's', credentials })

      expect(result).toMatchObject({
        connectionId: '1090000000000001',
        displayName: 'Messenger 1090000000000001'
      })
    })

    it.each([
      ['a throttle', { retryable: true, providerCode: 4 }],
      ['an outage', { retryable: false, outcomeUnknown: true }],
      ['a revoked token', { retryable: false, providerCode: 190 }]
    ])('does not hide %s behind the fallback name', async (_label, options) => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockRejectedValueOnce(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, options))

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toBeInstanceOf(
        PluginError
      )
      expect(post).not.toHaveBeenCalled()
    })

    it('uses the fallback name for a permission error too (code 200)', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockRejectedValueOnce(
        new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
          retryable: false,
          providerCode: 200
        })
      )
      subscriptionReads(get)
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('uses the fallback name when the name answer belongs to another id', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockResolvedValueOnce({ id: '999', name: 'Otra' })
      subscriptionReads(get)
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('uses the fallback name when the Page has an empty name', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValueOnce({ id: '1090000000000001' })
      get.mockResolvedValueOnce({ id: '1090000000000001', name: '' })
      subscriptionReads(get)
      post.mockResolvedValue({ success: true })

      await expect(plugin.connect({ storeId: 's', credentials })).resolves.toMatchObject({
        displayName: 'Messenger 1090000000000001'
      })
    })

    it('refuses the token when even the id cannot be read', async () => {
      const { plugin, get, post } = build()
      get.mockRejectedValue(
        new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: false })
      )

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
      expect(post).not.toHaveBeenCalled()
    })

    it('refuses a Page id that is not digits, before it reaches a path', async () => {
      const { plugin, get, post } = build()
      get.mockResolvedValue({ id: 'me/accounts', name: 'x' })

      await expect(plugin.connect({ storeId: 's', credentials })).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID
      })
      expect(post).not.toHaveBeenCalled()
    })
  })

  it('reads only the id for the health check, which needs no permission for the name', async () => {
    const { plugin, get } = build()
    get.mockResolvedValueOnce({ id: ctx.connectionId })

    await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })

    expect(get).toHaveBeenCalledTimes(1)
    expect(get.mock.calls[0]?.[0]).toMatchObject({ query: { fields: 'id' } })
  })

  describe('sends', () => {
    it('sends a text as a response, replying to a message beside it', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99', message_id: 'm_1' })

      const result = await plugin.sendMessage(ctx, {
        channelIdentity: '99',
        content: 'hola',
        replyToExternalId: 'm_0',
        ...key
      })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['1090000000000001', 'messages'],
        body: { recipient: { id: '99' }, messaging_type: 'RESPONSE', message: { text: 'hola' } }
      })
      expect(post.mock.calls[0]?.[0].body).toMatchObject({ reply_to: { mid: 'm_0' } })
      expect(result).toMatchObject({ externalId: 'm_1', status: 'sent' })
    })

    const media = (overrides: Record<string, unknown> = {}) => ({
      channelIdentity: '99',
      fileSize: 1000,
      openFile: opensTheFile,
      contentType: 'video/mp4',
      filename: null,
      ...key,
      ...overrides
    })

    it('uploads the file and sends it in one call, as a response', async () => {
      const { plugin, post, upload } = build()
      upload.mockResolvedValue({ message_id: 'm_2' })

      const result = await plugin.sendMedia(ctx, media({ replyToExternalId: 'm_0' }))

      expect(post).not.toHaveBeenCalled()
      const call = upload.mock.calls[0]?.[0]
      expect(call).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['1090000000000001', 'messages'],
        token: 'EAAB-page-token',
        fileField: 'filedata',
        safeToRepeat: false,
        file: { contentType: 'video/mp4', size: 1000, open: opensTheFile }
      })
      expect(call?.fields).toEqual({
        recipient: '{"id":"99"}',
        messaging_type: 'RESPONSE',
        message: '{"attachment":{"type":"video","payload":{}}}',
        reply_to: '{"mid":"m_0"}'
      })
      expect(result).toMatchObject({ externalId: 'm_2', status: 'sent' })
    })

    it.each([
      ['an image', 'image/png', 'image'],
      ['an audio', 'audio/mpeg', 'audio'],
      ['a document', 'application/pdf', 'file'],
      ['a text file', 'text/plain', 'file']
    ])('sends %s with the kind the Send API names for it', async (_name, contentType, type) => {
      const { plugin, upload } = build()
      upload.mockResolvedValue({ message_id: 'm_2' })

      await plugin.sendMedia(ctx, media({ contentType }))

      expect(upload.mock.calls[0]?.[0].fields['message']).toBe(
        `{"attachment":{"type":"${type}","payload":{}}}`
      )
    })

    it.each([
      ['an image over 8 MB', 'image/png', 8 * 1024 * 1024 + 1],
      ['a video over 25 MB', 'video/mp4', 25 * 1024 * 1024 + 1],
      ['a document over 25 MB', 'application/pdf', 25 * 1024 * 1024 + 1]
    ])(
      'refuses %s with its own code, before opening the file',
      async (_name, contentType, size) => {
        const { plugin, upload } = build()
        const open = jest.fn(opensTheFile)

        await expect(
          plugin.sendMedia(ctx, media({ contentType, fileSize: size, openFile: open }))
        ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_FILE_TOO_LARGE, retryable: false })

        expect(open).not.toHaveBeenCalled()
        expect(upload).not.toHaveBeenCalled()
      }
    )

    it('takes an image of exactly 8 MB and a video of exactly 25 MB', async () => {
      const { plugin, upload } = build()
      upload.mockResolvedValue({ message_id: 'm_2' })

      await plugin.sendMedia(ctx, media({ contentType: 'image/png', fileSize: 8 * 1024 * 1024 }))
      await plugin.sendMedia(ctx, media({ fileSize: 25 * 1024 * 1024 }))

      expect(upload).toHaveBeenCalledTimes(2)
    })

    it.each([0, -1, 1.5, Number.NaN])('refuses a recorded size of %p', async size => {
      const { plugin, upload } = build()

      await expect(plugin.sendMedia(ctx, media({ fileSize: size }))).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_MESSAGE_FAILED,
        retryable: false
      })
      expect(upload).not.toHaveBeenCalled()
    })

    it('refuses a host that gives no file instead of letting the queue retry a TypeError', async () => {
      const { plugin, upload } = build()

      await expect(plugin.sendMedia(ctx, media({ openFile: undefined }))).rejects.toMatchObject({
        code: ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
        retryable: false
      })
      expect(upload).not.toHaveBeenCalled()
    })

    it('names a document by its file name with plain characters, and an image without one', async () => {
      const { plugin, upload } = build()
      upload.mockResolvedValue({ message_id: 'm_2' })

      await plugin.sendMedia(
        ctx,
        media({ contentType: 'application/pdf', filename: 'Factura "2026"\r\n/ñ.pdf' })
      )
      await plugin.sendMedia(ctx, media({ contentType: 'image/png', filename: 'foto.png' }))

      expect(upload.mock.calls[0]?.[0].fileName).toBe('Factura _2026_____.pdf')
      expect(upload.mock.calls[1]?.[0].fileName).toBeUndefined()
    })

    it('sends the caption as its own message after the file', async () => {
      const { plugin, post, upload } = build()
      upload.mockResolvedValue({ message_id: 'm_2' })
      post.mockResolvedValueOnce({ message_id: 'm_3' })

      const result = await plugin.sendMedia(ctx, media({ caption: 'tu factura' }))

      expect(post.mock.calls[0]?.[0].body).toMatchObject({ message: { text: 'tu factura' } })
      expect(result.metadata).toEqual({ captionExternalId: 'm_3' })
    })

    it('sends no caption after a file that may not have gone', async () => {
      const { plugin, post, upload } = build()
      upload.mockRejectedValue(
        new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, {
          retryable: false,
          outcomeUnknown: true
        })
      )

      await expect(plugin.sendMedia(ctx, media({ caption: 'mira' }))).rejects.toMatchObject({
        outcomeUnknown: true
      })
      expect(post).not.toHaveBeenCalled()
    })

    it('reacts through the Page', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.sendReaction(ctx, {
        channelIdentity: '99',
        targetExternalId: 'm_1',
        emoji: '👍'
      })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        path: ['1090000000000001', 'messages'],
        body: { sender_action: 'react', payload: { message_id: 'm_1', reaction: '👍' } }
      })
    })
  })

  describe('sender actions', () => {
    it('shows and takes away the typing indicator, alone and safe to repeat', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.sendTypingIndicator(ctx, { channelIdentity: '99', active: true })
      await plugin.sendTypingIndicator(ctx, { channelIdentity: '99', active: false })

      expect(post.mock.calls[0]?.[0]).toMatchObject({
        path: ['1090000000000001', 'messages'],
        idempotent: true,
        body: { recipient: { id: '99' }, sender_action: 'typing_on' }
      })
      expect(post.mock.calls[1]?.[0].body).toEqual({
        recipient: { id: '99' },
        sender_action: 'typing_off'
      })
    })

    it('marks the conversation as seen, whatever the message', async () => {
      const { plugin, post } = build()
      post.mockResolvedValue({ recipient_id: '99' })

      await plugin.markAsRead(ctx, { channelIdentity: '99', externalId: 'm_1' })

      expect(post.mock.calls[0]?.[0].body).toEqual({
        recipient: { id: '99' },
        sender_action: 'mark_seen'
      })
    })

    it('declares both capabilities', () => {
      const { plugin } = build()
      expect(plugin.capabilities).toEqual(
        expect.arrayContaining([
          ChannelCapability.TYPING_INDICATOR,
          ChannelCapability.READ_RECEIPTS
        ])
      )
    })
  })

  it('reports a healthy connection only for the Page the connection is', async () => {
    const { plugin, get } = build()
    get.mockResolvedValueOnce({ id: ctx.connectionId, name: 'Mi Tienda' })
    await expect(plugin.healthCheck(ctx)).resolves.toMatchObject({ healthy: true })

    get.mockResolvedValueOnce({ id: '999', name: 'Otra' })
    await expect(plugin.healthCheck(ctx)).rejects.toMatchObject({
      code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
      retryable: false
    })
  })

  it('reads the webhook of a Page only', async () => {
    const { plugin } = build()
    const body = (object: string): object => ({
      object,
      entry: [
        {
          id: '1090000000000001',
          messaging: [
            {
              sender: { id: '99' },
              recipient: { id: '1090000000000001' },
              timestamp: 1_761_600_000_000,
              message: { mid: 'm_1', text: 'hola' }
            }
          ]
        }
      ]
    })
    await expect(plugin.handleWebhook(body('page'))).resolves.toHaveLength(1)
    await expect(plugin.handleWebhook(body('instagram'))).resolves.toEqual([])
  })

  describe('fetchProfile', () => {
    it('joins the first and last name and reads from the Facebook host', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({
        first_name: 'Peter',
        last_name: 'Chang',
        profile_pic: 'https://fbcdn.example/p.jpg'
      })

      const profile = await plugin.fetchProfile(ctx, '3000000000000001')

      expect(get.mock.calls[0]?.[0]).toMatchObject({
        origin: MetaGraph.ORIGIN,
        path: ['3000000000000001'],
        token: 'EAAB-page-token',
        query: { fields: 'first_name,last_name,profile_pic' }
      })
      expect(profile).toEqual({ name: 'Peter Chang', avatarUrl: 'https://fbcdn.example/p.jpg' })
    })

    it('hands the signal of the core to the request, so the call ends when the core stops waiting', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ first_name: 'Peter' })
      const signal = new AbortController().signal

      await plugin.fetchProfile(ctx, '3000000000000001', signal)
      await plugin.fetchProfile(ctx, '3000000000000001')

      expect(get.mock.calls[0]?.[0]).toMatchObject({ signal })
      expect(get.mock.calls[1]?.[0]).not.toHaveProperty('signal')
    })

    it('has no profile when the app may not read it: Meta answers an empty object', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({})
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toBeNull()
    })

    it('trims each part of the name before joining them', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ first_name: ' Peter ', last_name: ' Chang ' })
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toEqual({ name: 'Peter Chang' })
      get.mockResolvedValue({ first_name: ' ', last_name: 'Chang' })
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toEqual({ name: 'Chang' })
    })

    it('keeps the one name Meta gave', async () => {
      const { plugin, get } = build()
      get.mockResolvedValue({ first_name: 'Peter', last_name: '' })
      expect(await plugin.fetchProfile(ctx, '3000000000000001')).toEqual({ name: 'Peter' })
    })
  })
})

// What the owner reads when connecting fails: a name of a closed list, chosen from the numbers of Meta's
// answer, never from its words (which can echo the token)
describe('MessengerPlugin, the reason a connection fails', () => {
  const realPlugin = (): MessengerPlugin =>
    new MessengerPlugin(
      new MetaGraphClient({ appSecret: 's', verifyToken: 'v', graphVersion: 'v23.0' })
    )
  const answer = (status: number, code: number): Response =>
    new Response(
      JSON.stringify({
        error: { message: 'Invalid token EAAB-page-token', code, type: 'OAuthException' }
      }),
      { status, headers: { 'content-type': 'application/json' } }
    )
  afterEach(() => jest.restoreAllMocks())

  it.each([
    [400, 190, ChannelConnectFailureReasons.TOKEN_REJECTED],
    [400, 200, ChannelConnectFailureReasons.PERMISSION_MISSING],
    [400, 100, ChannelConnectFailureReasons.REQUEST_REJECTED],
    [400, 4, ChannelConnectFailureReasons.PROVIDER_BUSY],
    [500, 1, ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE]
  ])(
    'says it for Meta answering HTTP %i with the code %i, and nothing of its words',
    async (status, code, reason) => {
      jest
        .spyOn(globalThis, 'fetch')
        .mockImplementation(() => Promise.resolve(answer(status, code)))

      const failure: unknown = await realPlugin()
        .connect({ storeId: 's', credentials })
        .catch((error: unknown) => error)

      expect(failure).toBeInstanceOf(PluginError)
      expect(failure).toMatchObject({ reason })
      expect(
        JSON.stringify([(failure as PluginError).message, (failure as PluginError).reason])
      ).not.toContain('EAAB-page-token')
    }
  )

  it('says the token is not one when nothing usable was pasted, without asking Meta', async () => {
    const fetchMock = jest.spyOn(globalThis, 'fetch')

    await expect(
      realPlugin().connect({ storeId: 's', credentials: { accessToken: '   ' } })
    ).rejects.toMatchObject({ reason: ChannelConnectFailureReasons.TOKEN_MALFORMED })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// The whole path with the real client and a fake Graph: what Meta would receive
describe('MessengerPlugin, a file over the wire', () => {
  let fetchMock: jest.SpyInstance<Promise<Response>, Parameters<typeof fetch>>
  let received: { url: string; headers: Record<string, string>; body: string } | undefined

  beforeEach(() => {
    received = undefined
    fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader()
      const chunks: Buffer[] = []
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        chunks.push(Buffer.from(part.value))
      }
      received = {
        url: typeof url === 'string' ? url : url instanceof URL ? url.href : url.url,
        headers: init?.headers as Record<string, string>,
        body: Buffer.concat(chunks).toString('latin1')
      }
      return new Response(JSON.stringify({ recipient_id: '99', message_id: 'mid.9' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    })
  })
  afterEach(() => jest.restoreAllMocks())

  const request = (contentType: string, bytes: string, fileSize = Buffer.byteLength(bytes)) => ({
    channelIdentity: '99',
    fileSize,
    openFile: () => Promise.resolve(Readable.from([Buffer.from(bytes)])),
    contentType,
    filename: 'factura.pdf',
    idempotencyKey: 'k'
  })

  it('uploads a pdf as a file in one call to the Page', async () => {
    const result = await buildReal().sendMedia(ctx, request('application/pdf', '%PDF-1.4 body'))

    expect(result).toMatchObject({ externalId: 'mid.9', status: 'sent' })
    expect(received?.url).toBe('https://graph.facebook.com/v23.0/1090000000000001/messages')
    expect(received?.headers['authorization']).toBe('Bearer EAAB-page-token')
    expect(received?.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(received?.body).toContain('name="recipient"\r\n\r\n{"id":"99"}')
    expect(received?.body).toContain(
      'name="message"\r\n\r\n{"attachment":{"type":"file","payload":{}}}'
    )
    expect(received?.body).toContain(
      'name="filedata"; filename="factura.pdf"\r\nContent-Type: application/pdf\r\n\r\n%PDF-1.4 body'
    )
    // Nothing of the token reaches the form; the name of the file does, in plain characters
    expect(received?.body).not.toContain('EAAB-page-token')
  })

  it('does not call Meta for a file larger than the channel takes', async () => {
    await expect(
      buildReal().sendMedia(ctx, request('application/pdf', 'x', 25 * 1024 * 1024 + 1))
    ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_FILE_TOO_LARGE })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('stops a file that is not the size that was recorded', async () => {
    await expect(
      buildReal().sendMedia(ctx, request('application/pdf', 'abcdef', 3))
    ).rejects.toBeInstanceOf(PluginError)
  })
})
