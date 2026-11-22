import { ChannelCapability, OutboundLimits, RemoteChannelLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { PinnedExchangeFailed, PinnedFetchFailed, UnsafeUrlError } from '@platform/core/url-safety'
import { type ChannelPlugin, PluginError } from '@platform/plugins/sdk'

import { pluginManifestSchema } from './plugin-manifest'
import { PluginRegistry } from './plugin-registry'
import {
  type RemoteCommandSecrets,
  RemoteChannelPlugin,
  type RemoteExchange,
  type RemoteFileGet,
  type RemoteSecretSource
} from './remote-channel-plugin'
import { verifyRemoteCommand } from './remote-command-signature'

const NOW_MS = 1_800_000_000_000
const NOW_S = NOW_MS / 1000
const COMMANDS_URL = 'https://acme.com/platform/commands'

const manifest = pluginManifestSchema.parse({
  id: 'acme_chat',
  version: '1.0.0',
  name: 'Acme Chat',
  description: 'A channel that runs outside the platform',
  author: { name: 'Acme', email: 'dev@acme.com' },
  type: 'channel',
  pricing: { model: 'free' },
  capabilities: [
    'text',
    'image',
    'document',
    'delivery_receipts',
    'read_receipts',
    'typing_indicator',
    'caption_per_file'
  ],
  channel: { label: 'Acme', commandsUrl: COMMANDS_URL, messagingWindow: { hours: 24 } },
  ui: { settings: 'https://acme.com/settings' },
  scopes: ['channel:connections', 'channel:events']
})

const NO_SECRETS: RemoteSecretSource = {
  secretsOf: () => Promise.resolve(null),
  secretsForDisconnect: () => Promise.resolve(null)
}

const ctx = { storeId: 'store-1', connectionId: 'acct-9', credentials: {}, metadata: {} }

interface Call {
  url: string
  body: string
  headers: Readonly<Record<string, string>>
  timeoutMs: number
  maxResponseBytes: number | undefined
  anyStatus: boolean | undefined
}

function harness(
  answer: (call: Call) => { status: number; body: string } | Error,
  secrets: RemoteCommandSecrets | null = { current: 'secret-new', previous: null, rotatedAt: null }
) {
  const calls: Call[] = []
  const exchange: RemoteExchange = (url, options) => {
    const call: Call = {
      url,
      body: options.body,
      headers: options.headers,
      timeoutMs: options.timeoutMs,
      maxResponseBytes: options.maxResponseBytes,
      anyStatus: options.anyStatus
    }
    calls.push(call)
    const result = answer(call)
    return result instanceof Error ? Promise.reject(result) : Promise.resolve(result)
  }
  const asked: string[] = []
  const source: RemoteSecretSource = {
    secretsOf: (storeId, pluginId) => {
      asked.push(`${storeId}/${pluginId}`)
      return Promise.resolve(secrets)
    },
    secretsForDisconnect: (storeId, pluginId) => {
      asked.push(`teardown:${storeId}/${pluginId}`)
      return Promise.resolve(secrets)
    }
  }
  let deliveries = 0
  const plugin = new RemoteChannelPlugin(manifest, {
    secrets: source,
    exchange,
    now: () => NOW_MS,
    deliveryId: () => `delivery-${(deliveries += 1)}`
  })
  return { plugin, calls, asked }
}

const ok = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
const refusal = (status: number, error: Record<string, unknown>) => ({
  status,
  body: JSON.stringify({ error })
})

async function failureOf(work: Promise<unknown>): Promise<PluginError> {
  try {
    await work
  } catch (error) {
    if (error instanceof PluginError) return error
    throw error
  }
  throw new Error('expected a PluginError')
}

// What the adapter put on the wire, read back as data
function sent(
  raw: string
): { command: string; data: Record<string, unknown> } & Record<string, unknown> {
  return JSON.parse(raw) as { command: string; data: Record<string, unknown> } & Record<
    string,
    unknown
  >
}

describe('RemoteChannelPlugin: what it declares', () => {
  const { plugin } = harness(() => ok({}))

  it('is the plugin of the manifest, with no webhook route and no way to connect from the platform', async () => {
    expect(plugin.id).toBe('acme_chat')
    expect(plugin.type).toBe('channel')
    expect(plugin.receivesProviderWebhooks).toBe(false)
    // Through the interface: a remote plugin takes no arguments here, and the core calls it with them
    const asChannel: ChannelPlugin = plugin
    expect(asChannel.validateWebhookSignature('{}', {})).toBe(false)
    await expect(asChannel.handleWebhook({})).resolves.toEqual([])
    await expect(plugin.connect({ storeId: 'store-1', credentials: {} })).rejects.toMatchObject({
      statusCode: 409,
      metadata: { settingsUrl: 'https://acme.com/settings' }
    })
  })

  it('passes only the shape of a public https address of a file on to the fetch', () => {
    expect(plugin.acceptsMediaLink?.('https://cdn.acme.com/a.png')).toBe(true)
    for (const ref of ['http://cdn.acme.com/a.png', 'https://10.0.0.1/a.png', 'nothing']) {
      expect(plugin.acceptsMediaLink?.(ref)).toBe(false)
    }
  })

  it('takes the capabilities, window, limits and files from the manifest and never more', () => {
    expect(plugin.capabilities).toEqual(manifest.capabilities)
    expect(plugin.messagingWindow).toEqual({ hours: 24, requiresTemplateWhenClosed: false })
    expect(plugin.media?.kinds).toEqual({
      image: { types: null, maxBytes: expect.any(Number) as number },
      document: { types: null, maxBytes: expect.any(Number) as number }
    })
    expect(plugin.limits.textMaxLength).toBeGreaterThan(0)
  })

  it('has the typing and read methods only when it declared the capabilities', () => {
    expect(plugin.sendTypingIndicator).toBeDefined()
    expect(plugin.markAsRead).toBeDefined()
    const bare = new RemoteChannelPlugin(
      pluginManifestSchema.parse({ ...manifest, capabilities: ['text'] }),
      { secrets: NO_SECRETS }
    )
    expect(bare.sendTypingIndicator).toBeUndefined()
    expect(bare.markAsRead).toBeUndefined()
    expect(bare.media).toBeUndefined()
    expect(bare.capabilities).not.toContain(ChannelCapability.CAPTION_PER_FILE)
  })

  it('has no window when the manifest has none', () => {
    const noWindow = new RemoteChannelPlugin(
      pluginManifestSchema.parse({
        ...manifest,
        channel: { label: 'Acme', commandsUrl: COMMANDS_URL }
      }),
      { secrets: NO_SECRETS }
    )
    expect(noWindow.messagingWindow).toBeNull()
  })
})

describe('RemoteChannelPlugin: the signed request', () => {
  it('posts the command to commandsUrl, signed over "<t>.<raw body>", with a delivery id and the idempotency key', async () => {
    const { plugin, calls, asked } = harness(() =>
      ok({ externalId: 'ext-1', status: 'sent', sentAt: '2026-11-15T10:00:00.000Z' })
    )
    const result = await plugin.sendMessage(ctx, {
      channelIdentity: 'cust-1',
      content: 'hello',
      replyToExternalId: 'ext-0',
      idempotencyKey: 'msg-1'
    })
    expect(result).toEqual({
      externalId: 'ext-1',
      status: 'sent',
      sentAt: '2026-11-15T10:00:00.000Z'
    })
    expect(asked).toEqual(['store-1/acme_chat'])
    const [call] = calls
    expect(call?.url).toBe(COMMANDS_URL)
    expect(sent(call?.body ?? '')).toEqual({
      command: 'message.send',
      storeId: 'store-1',
      connectionId: 'acct-9',
      data: {
        messageId: 'msg-1',
        channelIdentity: 'cust-1',
        type: 'text',
        content: 'hello',
        replyToExternalId: 'ext-0'
      }
    })
    expect(call?.headers['content-type']).toBe('application/json')
    expect(call?.headers['idempotency-key']).toBe('msg-1')
    expect(call?.headers['x-platform-delivery']).toBe('delivery-1')
    expect(call?.anyStatus).toBe(true)
    expect(call?.maxResponseBytes).toBe(RemoteChannelLimits.MAX_RESPONSE_BYTES)
    expect(call?.timeoutMs).toBe(RemoteChannelLimits.COMMAND_TIMEOUT_MS)
    expect(
      verifyRemoteCommand(
        call?.headers['x-platform-command-signature'] ?? '',
        call?.body ?? '',
        ['secret-new'],
        NOW_S
      )
    ).toBe(true)
  })

  it('uses a new delivery id for every attempt', async () => {
    const { plugin, calls } = harness(() => ok({ externalId: 'e', status: 'sent' }))
    const params = { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' }
    await plugin.sendMessage(ctx, params)
    await plugin.sendMessage(ctx, params)
    expect(calls.map(call => call.headers['x-platform-delivery'])).toEqual([
      'delivery-1',
      'delivery-2'
    ])
  })

  it('signs with both secrets while a rotation is open and with the new one alone after ten minutes', async () => {
    const rotatedAt = new Date(NOW_MS - 5 * 60_000)
    const open = harness(() => ok({ externalId: 'e', status: 'sent' }), {
      current: 'secret-new',
      previous: 'secret-old',
      rotatedAt
    })
    await open.plugin.sendMessage(ctx, { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' })
    const signature = open.calls[0]?.headers['x-platform-command-signature'] ?? ''
    expect(signature.split(',')).toHaveLength(3)
    for (const secret of ['secret-new', 'secret-old']) {
      expect(verifyRemoteCommand(signature, open.calls[0]?.body ?? '', [secret], NOW_S)).toBe(true)
    }

    const closed = harness(() => ok({ externalId: 'e', status: 'sent' }), {
      current: 'secret-new',
      previous: 'secret-old',
      rotatedAt: new Date(NOW_MS - RemoteChannelLimits.ROTATION_GRACE_SECONDS * 1000 - 1)
    })
    await closed.plugin.sendMessage(ctx, {
      channelIdentity: 'c',
      content: 'x',
      idempotencyKey: 'm'
    })
    const after = closed.calls[0]?.headers['x-platform-command-signature'] ?? ''
    expect(after.split(',')).toHaveLength(2)
    expect(verifyRemoteCommand(after, closed.calls[0]?.body ?? '', ['secret-old'], NOW_S)).toBe(
      false
    )
  })

  it('sends nothing for a store that has no active installation', async () => {
    const { plugin, calls } = harness(() => ok({}), null)
    const error = await failureOf(
      plugin.sendMessage(ctx, { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' })
    )
    expect(error.code).toBe(ErrorCodes.CHANNEL_NOT_CONNECTED)
    expect(error.retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })

  it('refuses a command whose body is over 256 KB before anything leaves', async () => {
    const { plugin, calls } = harness(() => ok({}))
    const error = await failureOf(
      plugin.sendMessage(ctx, {
        channelIdentity: 'c',
        content: 'x'.repeat(RemoteChannelLimits.MAX_REQUEST_BYTES),
        idempotencyKey: 'm'
      })
    )
    expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    expect(error.retryable).toBe(false)
    expect(error.refused).toBe(true)
    expect(calls).toHaveLength(0)
  })
})

describe('RemoteChannelPlugin: SSRF', () => {
  it('a commandsUrl that leads to a private address is a final refusal and nothing was sent', async () => {
    const { plugin } = harness(() => new UnsafeUrlError('private address'))
    const error = await failureOf(
      plugin.sendMessage(ctx, { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' })
    )
    expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    expect(error.retryable).toBe(false)
    expect(error.refused).toBe(true)
  })

  it('does not follow a redirect: a 3xx is a final failure', async () => {
    const { plugin } = harness(() => ({ status: 302, body: '' }))
    const error = await failureOf(
      plugin.sendMessage(ctx, { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' })
    )
    expect(error.retryable).toBe(false)
  })

  it('passes no resolver of its own: the check is the one of the exchange, made at every call', async () => {
    const { plugin, calls } = harness(() => ok({ externalId: 'e', status: 'sent' }))
    await plugin.sendMessage(ctx, { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' })
    await plugin.sendMessage(ctx, { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' })
    expect(calls).toHaveLength(2)
  })
})

describe('RemoteChannelPlugin: the answers to a send', () => {
  const send = (plugin: RemoteChannelPlugin) =>
    plugin.sendMessage(ctx, { channelIdentity: 'c', content: 'x', idempotencyKey: 'm' })

  it('maps the codes of a refusal', async () => {
    const cases: [string, string][] = [
      ['window_closed', ErrorCodes.CHANNEL_WINDOW_EXPIRED],
      ['not_connected', ErrorCodes.CHANNEL_NOT_CONNECTED],
      ['recipient_invalid', ErrorCodes.CHANNEL_MESSAGE_FAILED],
      ['rate_limited', ErrorCodes.CHANNEL_MESSAGE_FAILED],
      ['rejected', ErrorCodes.CHANNEL_MESSAGE_FAILED],
      ['something_else', ErrorCodes.CHANNEL_MESSAGE_FAILED]
    ]
    for (const [code, mapped] of cases) {
      const { plugin } = harness(() => refusal(422, { code, message: 'no' }))
      const error = await failureOf(send(plugin))
      expect(error.code).toBe(mapped)
      expect(error.refused).toBe(true)
    }
  })

  it('tries again after a network error, a timeout, a 429 or a 5xx and not after another 4xx', async () => {
    for (const answer of [
      new PinnedExchangeFailed('no_answer:ECONNRESET'),
      new PinnedExchangeFailed('too_slow'),
      refusal(429, { code: 'rate_limited', message: 'slow down' }),
      refusal(500, { code: 'rejected', message: 'oops' }),
      { status: 502, body: 'not json' }
    ]) {
      const { plugin } = harness(() => answer)
      expect((await failureOf(send(plugin))).retryable).toBe(true)
    }
    for (const status of [400, 401, 403, 404, 422]) {
      const { plugin } = harness(() => refusal(status, { code: 'rejected', message: 'no' }))
      expect((await failureOf(send(plugin))).retryable).toBe(false)
    }
  })

  it('lets `retryable` win over the status', async () => {
    const four = harness(() => refusal(422, { code: 'rejected', message: 'm', retryable: true }))
    expect((await failureOf(send(four.plugin))).retryable).toBe(true)
    const five = harness(() => refusal(503, { code: 'rejected', message: 'm', retryable: false }))
    expect((await failureOf(send(five.plugin))).retryable).toBe(false)
  })

  it('does not say the provider took nothing when the outcome is not known', async () => {
    for (const answer of [
      new PinnedExchangeFailed('too_slow'),
      new PinnedExchangeFailed('no_answer:ECONNRESET'),
      refusal(500, { code: 'rejected', message: 'm' })
    ]) {
      const error = await failureOf(send(harness(() => answer).plugin))
      expect(error.outcomeUnknown).toBe(true)
      expect(error.refused).toBe(false)
    }
  })

  it('marks a doubt of a send as idempotent: the same key goes again and the plugin promised not to send twice', async () => {
    for (const answer of [
      new PinnedExchangeFailed('too_slow'),
      new PinnedExchangeFailed('no_answer:ECONNRESET'),
      refusal(500, { code: 'rejected', message: 'm' }),
      refusal(503, { code: 'rejected', message: 'm' })
    ]) {
      const error = await failureOf(send(harness(() => answer).plugin))
      expect(error.outcomeUnknown).toBe(true)
      expect(error.idempotent).toBe(true)
    }
  })

  it('does not call idempotent a refusal, a throttle or an answer that cannot be read', async () => {
    for (const answer of [
      refusal(429, { code: 'rate_limited', message: 'm' }),
      refusal(422, { code: 'rejected', message: 'm' }),
      ok({}),
      { status: 200, body: 'nope' }
    ]) {
      expect((await failureOf(send(harness(() => answer).plugin))).idempotent).toBe(false)
    }
  })

  it('does not carry what the plugin said in the error', async () => {
    const { plugin } = harness(() =>
      refusal(422, { code: 'rejected', message: 'token plg_live_secret was refused' })
    )
    const error = await failureOf(send(plugin))
    expect(JSON.stringify(error)).not.toContain('plg_live_secret')
    expect(error.message).not.toContain('plg_live_secret')
  })

  it('takes the id of a message up to the shared bound, the one the worker stores, and refuses a longer one', async () => {
    // The literal pins the contract: the worker stores up to 512 characters of an id
    expect(OutboundLimits.EXTERNAL_ID_MAX_LENGTH).toBe(512)
    const longest = 'x'.repeat(512)
    const fits = harness(() => ok({ externalId: longest, status: 'sent' }))
    expect((await send(fits.plugin)).externalId).toBe(longest)
    const tooLong = harness(() => ok({ externalId: `${longest}x`, status: 'sent' }))
    const error = await failureOf(send(tooLong.plugin))
    expect(error.outcomeUnknown).toBe(true)
  })

  it('takes an answer that is not what the table says as a failure whose outcome is not known', async () => {
    for (const body of [
      ok({}),
      ok({ externalId: 7, status: 'sent' }),
      ok({ externalId: 'e', status: 'queued' })
    ]) {
      const { plugin } = harness(() => body)
      const error = await failureOf(send(plugin))
      expect(error.retryable).toBe(false)
      expect(error.outcomeUnknown).toBe(true)
    }
    const { plugin } = harness(() => ({ status: 200, body: 'nope' }))
    expect((await failureOf(send(plugin))).outcomeUnknown).toBe(true)
  })

  it('a certificate that does not fit, or a name that does not exist, is final and nothing reached the plugin', async () => {
    for (const reason of ['no_answer:CERT_HAS_EXPIRED', 'not_resolved:ENOTFOUND']) {
      const error = await failureOf(send(harness(() => new PinnedExchangeFailed(reason)).plugin))
      expect(error.retryable).toBe(false)
      expect(error.refused).toBe(true)
    }
  })

  it('a connection that was refused or a name that did not resolve is tried again, and the failure is definitive (N-39-02)', async () => {
    for (const reason of ['no_answer:ECONNREFUSED', 'not_resolved:EAI_AGAIN']) {
      const error = await failureOf(send(harness(() => new PinnedExchangeFailed(reason)).plugin))
      expect(error.retryable).toBe(true)
      expect(error.outcomeUnknown).toBe(false)
      expect(error.refused).toBe(true)
    }
  })

  it('keeps the doubt when the code does not prove the socket never opened: tried again, not refused', async () => {
    for (const reason of [
      'no_answer:EHOSTUNREACH',
      'no_answer:ENETUNREACH',
      'no_answer:ECONNRESET',
      'no_answer:ETIMEDOUT',
      'no_answer'
    ]) {
      const error = await failureOf(send(harness(() => new PinnedExchangeFailed(reason)).plugin))
      expect(error.retryable).toBe(true)
      expect(error.refused).toBe(false)
    }
  })

  it('an answer too long to read is mapped by its status: a gateway page that refuses is a refusal', async () => {
    const refused = await failureOf(
      send(harness(() => new PinnedExchangeFailed('too_large', 403)).plugin)
    )
    expect(refused.refused).toBe(true)
    expect(refused.retryable).toBe(false)
    const ok2xx = await failureOf(
      send(harness(() => new PinnedExchangeFailed('too_large', 200)).plugin)
    )
    expect(ok2xx.outcomeUnknown).toBe(true)
  })

  it('uses the moment of the answer when the plugin gives no sentAt', async () => {
    const { plugin } = harness(() => ok({ externalId: 'e', status: 'sent' }))
    expect((await send(plugin)).sentAt).toBe(new Date(NOW_MS).toISOString())
  })
})

describe('RemoteChannelPlugin: files', () => {
  const file = {
    channelIdentity: 'cust-1',
    contentType: 'image/png; charset=binary',
    fileSize: 10,
    openFile: () => Promise.reject(new Error('the bytes are never read')),
    filename: 'photo.png',
    caption: 'look',
    replyToExternalId: 'ext-0',
    idempotencyKey: 'msg-1-0'
  }

  it('hands the plugin a signed address (10 minutes) and the text of the file, never the bytes', async () => {
    const { plugin, calls } = harness(() => ok({ externalId: 'e', status: 'sent' }))
    const sign = jest.fn((ttl: number) => Promise.resolve(`https://files.example/o?ttl=${ttl}`))
    await plugin.sendMedia(ctx, { ...file, signedUrl: sign })
    expect(sign).toHaveBeenCalledWith(RemoteChannelLimits.MEDIA_URL_TTL_SECONDS)
    expect(sent(calls[0]?.body ?? '').data).toEqual({
      messageId: 'msg-1-0',
      channelIdentity: 'cust-1',
      type: 'image',
      content: 'look',
      replyToExternalId: 'ext-0',
      media: {
        url: 'https://files.example/o?ttl=600',
        contentType: 'image/png',
        filename: 'photo.png'
      }
    })
  })

  it('marks a doubt of a media send as idempotent too', async () => {
    const { plugin } = harness(() => refusal(502, { code: 'rejected', message: 'm' }))
    const error = await failureOf(
      plugin.sendMedia(ctx, { ...file, signedUrl: () => Promise.resolve('https://f.example/x') })
    )
    expect(error.outcomeUnknown).toBe(true)
    expect(error.idempotent).toBe(true)
  })

  it('names the kind of the file by its content type', async () => {
    const kinds: [string, string][] = [
      ['video/mp4', 'video'],
      ['audio/ogg', 'audio'],
      ['application/pdf', 'document'],
      ['image/jpeg', 'image']
    ]
    for (const [contentType, type] of kinds) {
      const { plugin, calls } = harness(() => ok({ externalId: 'e', status: 'sent' }))
      await plugin.sendMedia(ctx, {
        ...file,
        contentType,
        signedUrl: () => Promise.resolve('https://f.example/x')
      })
      expect(sent(calls[0]?.body ?? '').data['type']).toBe(type)
    }
  })

  it('fails the file, for good, when the caller could not sign an address', async () => {
    const { plugin, calls } = harness(() => ok({}))
    const error = await failureOf(plugin.sendMedia(ctx, file))
    expect(error.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
    expect(error.retryable).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

describe('RemoteChannelPlugin: health, disconnect, typing and read', () => {
  it('connection.health: reads healthy, unhealthy with its text, and the platform gives the time', async () => {
    const good = harness(() => ok({ healthy: true }))
    expect(await good.plugin.healthCheck(ctx)).toEqual({
      healthy: true,
      checkedAt: new Date(NOW_MS).toISOString()
    })
    expect(sent(good.calls[0]?.body ?? '')).toMatchObject({
      command: 'connection.health',
      data: {}
    })
    expect(good.calls[0]?.headers['idempotency-key']).toBeUndefined()
    const bad = harness(() => ok({ healthy: false, error: 'session expired' }))
    expect(await bad.plugin.healthCheck(ctx)).toEqual({
      healthy: false,
      error: 'session expired',
      checkedAt: new Date(NOW_MS).toISOString()
    })
  })

  it('connection.health: a failure to answer is thrown, so it counts as a failed check', async () => {
    for (const answer of [
      new PinnedExchangeFailed('too_slow'),
      { status: 500, body: '' },
      ok({ nope: true })
    ]) {
      const { plugin } = harness(() => answer)
      await expect(plugin.healthCheck(ctx)).rejects.toBeInstanceOf(PluginError)
    }
  })

  it('connection.disconnect is best effort: it never throws and is sent once', async () => {
    const down = harness(() => new PinnedExchangeFailed('no_answer:ECONNREFUSED'))
    await expect(down.plugin.disconnect(ctx)).resolves.toBeUndefined()
    expect(down.calls).toHaveLength(1)
    // Signed with the secrets of teardown, so it still goes out when the installation was just revoked
    expect(down.asked).toEqual(['teardown:store-1/acme_chat'])
    expect(sent(down.calls[0]?.body ?? '').command).toBe('connection.disconnect')
    const none = harness(() => ok({}), null)
    await expect(none.plugin.disconnect(ctx)).resolves.toBeUndefined()
    expect(none.calls).toHaveLength(0)
  })

  it('typing.send and message.markRead wait 3 seconds, send what the table says and are never retried by the adapter', async () => {
    const { plugin, calls } = harness(() => ok({}))
    await plugin.sendTypingIndicator?.(ctx, {
      channelIdentity: 'cust-1',
      active: true,
      lastInbound: { externalId: 'ext-5', receivedAt: '2026-11-15T10:00:00.000Z' }
    })
    await plugin.sendTypingIndicator?.(ctx, { channelIdentity: 'cust-1', active: false })
    await plugin.markAsRead?.(ctx, { channelIdentity: 'cust-1', externalId: 'ext-5' })
    expect(calls.map(call => sent(call.body))).toEqual([
      {
        command: 'typing.send',
        storeId: 'store-1',
        connectionId: 'acct-9',
        data: { channelIdentity: 'cust-1', state: 'start' }
      },
      {
        command: 'typing.send',
        storeId: 'store-1',
        connectionId: 'acct-9',
        data: { channelIdentity: 'cust-1', state: 'stop' }
      },
      {
        command: 'message.markRead',
        storeId: 'store-1',
        connectionId: 'acct-9',
        data: { channelIdentity: 'cust-1', externalId: 'ext-5' }
      }
    ])
    for (const call of calls) {
      expect(call.timeoutMs).toBe(RemoteChannelLimits.BEST_EFFORT_TIMEOUT_MS)
      expect(call.headers['idempotency-key']).toBeUndefined()
    }
  })

  it('a typing or read command that fails throws, so the hook that called it can log it', async () => {
    const { plugin } = harness(() => new PinnedExchangeFailed('too_slow'))
    await expect(
      plugin.sendTypingIndicator?.(ctx, { channelIdentity: 'c', active: true })
    ).rejects.toBeInstanceOf(PluginError)
  })
})

describe('RemoteChannelPlugin in the registry', () => {
  const logger = { setContext: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() }

  it('passes the contract of a channel plugin with every capability of the manifest, as a private remote plugin', () => {
    const registry = new PluginRegistry(logger as never)
    const { plugin } = harness(() => ok({}))
    registry.register(plugin, { remote: true, storeIds: ['store-1'] })
    expect(registry.isRemote('acme_chat')).toBe(true)
    expect(registry.capabilitiesOf('acme_chat')).toEqual(manifest.capabilities)
    expect(registry.mediaOf('acme_chat')?.kinds).toHaveProperty('image')
    expect(registry.hasCapability('acme_chat', ChannelCapability.CAPTION_PER_FILE)).toBe(true)
    expect(registry.list('store-2').map(p => p.id)).not.toContain('acme_chat')
    expect(registry.list('store-1').map(p => p.id)).toContain('acme_chat')
  })

  it('is replaced by a newer manifest and never takes an official id', () => {
    const registry = new PluginRegistry(logger as never)
    registry.register(harness(() => ok({})).plugin, { remote: true })
    const newer = new RemoteChannelPlugin(
      pluginManifestSchema.parse({ ...manifest, version: '2.0.0' }),
      {
        secrets: NO_SECRETS
      }
    )
    registry.register(newer, { remote: true })
    expect(registry.get('acme_chat').version).toBe('2.0.0')
  })
})

describe('RemoteChannelPlugin.fetchMedia (§6.7.6)', () => {
  interface Fetch {
    url: string
    accept: string
    timeoutMs: number
    headers: Readonly<Record<string, string>> | undefined
  }

  function fetcher(
    answer: () => { stream: unknown; contentType: string; contentLength: number | null } | Error,
    secrets: RemoteCommandSecrets | null = {
      current: 'secret-new',
      previous: null,
      rotatedAt: null
    }
  ) {
    const fetches: Fetch[] = []
    const get: RemoteFileGet = (url, options) => {
      fetches.push({
        url,
        accept: options.accept,
        timeoutMs: options.timeoutMs,
        headers: options.headers
      })
      const result = answer()
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result as never)
    }
    const plugin = new RemoteChannelPlugin(manifest, {
      secrets: {
        secretsOf: () => Promise.resolve(secrets),
        secretsForDisconnect: () => Promise.resolve(secrets)
      },
      get,
      now: () => NOW_MS
    })
    return { plugin, fetches }
  }

  const file = { stream: 'bytes', contentType: 'image/png', contentLength: 12 }

  it('gets the file with a 30 second wait and hands the stream, the type and the length back', async () => {
    const { plugin, fetches } = fetcher(() => file)
    await expect(plugin.fetchMedia(ctx, 'https://cdn.other.com/a.png')).resolves.toEqual(file)
    expect(fetches).toHaveLength(1)
    expect(fetches[0]).toMatchObject({
      url: 'https://cdn.other.com/a.png',
      timeoutMs: RemoteChannelLimits.MEDIA_FETCH_TIMEOUT_MS
    })
  })

  it('never sends the signature to a host that is not the one of commandsUrl, and does not read the secrets for it', async () => {
    const { plugin, fetches } = fetcher(() => file)
    await plugin.fetchMedia(ctx, 'https://cdn.other.com/a.png')
    await plugin.fetchMedia(ctx, 'https://acme.com.evil.net/a.png')
    await plugin.fetchMedia(ctx, 'https://sub.acme.com/a.png')
    for (const fetch of fetches) {
      expect(fetch.headers).toEqual({})
    }
  })

  it('signs an empty body for the host of commandsUrl, as a command is signed, so the plugin can keep its files private', async () => {
    const { plugin, fetches } = fetcher(() => file)
    await plugin.fetchMedia(ctx, 'https://acme.com/files/a.png')
    const signature = fetches[0]?.headers?.['x-platform-command-signature']
    expect(signature).toBeDefined()
    expect(verifyRemoteCommand(signature ?? '', '', ['secret-new'], NOW_S)).toBe(true)
    // Bound to the store: the secret of another one does not verify
    expect(verifyRemoteCommand(signature ?? '', '', ['another-secret'], NOW_S)).toBe(false)
  })

  it('signs with both secrets while a rotation is open', async () => {
    const { plugin, fetches } = fetcher(() => file, {
      current: 'secret-new',
      previous: 'secret-old',
      rotatedAt: new Date(NOW_MS - 60_000)
    })
    await plugin.fetchMedia(ctx, 'https://acme.com/files/a.png')
    const signature = fetches[0]?.headers?.['x-platform-command-signature'] ?? ''
    expect(verifyRemoteCommand(signature, '', ['secret-old'], NOW_S)).toBe(true)
    expect(verifyRemoteCommand(signature, '', ['secret-new'], NOW_S)).toBe(true)
  })

  it('fails for good, and does not ask the host, when the store has no active installation to sign for', async () => {
    const { plugin, fetches } = fetcher(() => file, null)
    const failure = await failureOf(plugin.fetchMedia(ctx, 'https://acme.com/files/a.png'))
    expect(failure.code).toBe(ErrorCodes.CHANNEL_NOT_CONNECTED)
    expect(failure.retryable).toBe(false)
    expect(fetches).toHaveLength(0)
  })

  it('lets an unsafe address through as what it is, so that the file is marked unsafe and not tried again', async () => {
    const { plugin } = fetcher(() => new UnsafeUrlError('its host is not on the public internet'))
    await expect(plugin.fetchMedia(ctx, 'https://10.0.0.1/a.png')).rejects.toBeInstanceOf(
      UnsafeUrlError
    )
  })

  it('says whether trying again may help and nothing of what the server said', async () => {
    const gone = fetcher(() => new PinnedFetchFailed('status 404 secret-in-the-text', false))
    const goneFailure = await failureOf(gone.plugin.fetchMedia(ctx, 'https://cdn.other.com/a.png'))
    expect(goneFailure.retryable).toBe(false)
    expect(JSON.stringify(goneFailure)).not.toContain('secret-in-the-text')
    expect(goneFailure.message).not.toContain('secret-in-the-text')

    const slow = fetcher(() => new PinnedFetchFailed('the server was too slow', true))
    expect(
      (await failureOf(slow.plugin.fetchMedia(ctx, 'https://cdn.other.com/a.png'))).retryable
    ).toBe(true)

    // What is not the file server's is ours: it goes up as what it is and is not dressed as a failed message
    const ours = fetcher(() => new Error('the store of secrets failed'))
    await expect(ours.plugin.fetchMedia(ctx, 'https://cdn.other.com/a.png')).rejects.toThrow(
      'the store of secrets failed'
    )
  })

  it('takes a text that is not an address to the fetch, which refuses it', async () => {
    const { plugin, fetches } = fetcher(() => new UnsafeUrlError('not a url'))
    await expect(plugin.fetchMedia(ctx, 'not a url')).rejects.toBeInstanceOf(UnsafeUrlError)
    expect(fetches[0]?.headers).toEqual({})
  })
})
