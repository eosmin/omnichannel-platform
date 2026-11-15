import type { PinoLogger } from 'nestjs-pino'

import {
  ChannelCapability,
  MessageType,
  RemoteChannelCommands,
  RemoteChannelErrorCodes,
  RemoteChannelLimits,
  RemoteChannelSendTypes
} from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  type PluginManifest,
  pluginManifestSchema,
  PluginRegistry,
  RemoteChannelPlugin,
  type RemoteCommandSecrets,
  type RemoteSecretSource,
  remoteChannelEventsBodySchema,
  verifyRemoteCommand
} from '@platform/plugins/runtime'
import { ChannelEventTypes, type ChannelContext, PluginError } from '@platform/plugins/sdk'

import { loopbackExchange, type ReferencePlugin } from './remote-channel-reference-plugin'

// The contract suite of a channel plugin that runs OUTSIDE the platform (TDD_10 §6.7.9), which replaces the suite of §9 for it.
// It checks the adapter the platform builds from a manifest (`RemoteChannelPlugin`) against a running service: the commands it
// signs and what it says in them, how it reads the answers, and what it does when the service refuses, stalls or hangs up. The
// service is anything with the shape of `ReferencePlugin`; the reference plugin of the suite is the first to pass, and a plugin
// author who wants the same checks runs it with a service of their own that exposes `script` (the way to make it refuse or
// stall) and `received` (what it was told).

export const REFERENCE_PLUGIN_ID = 'reference_chat'
export const STORE_ID = 'store-reference-1'
export const CONNECTION_ID = 'account-reference-1'

const MS = 1000
const NOW_MS = 1_800_000_000_000

// The address the manifest declares is a public https one, as the validator requires; the adapter of the suite never connects to it
// (its exchange goes to the loopback address of the reference service)
export const DECLARED_COMMANDS_URL = 'https://reference.example.com/platform/commands'

export const referenceManifest = (
  commandsUrl: string,
  over: Record<string, unknown> = {}
): PluginManifest =>
  pluginManifestSchema.parse({
    id: REFERENCE_PLUGIN_ID,
    version: '1.0.0',
    name: 'Reference Chat',
    description: 'The reference channel of the contract suite: it runs outside the platform',
    author: { name: 'The suite', email: 'reference@example.com' },
    type: 'channel',
    pricing: { model: 'free' },
    capabilities: [
      ChannelCapability.TEXT,
      ChannelCapability.IMAGE,
      ChannelCapability.DOCUMENT,
      ChannelCapability.DELIVERY_RECEIPTS,
      ChannelCapability.READ_RECEIPTS,
      ChannelCapability.TYPING_INDICATOR,
      ChannelCapability.CAPTION_PER_FILE
    ],
    // The address is the loopback of the reference service: the manifest validator does not resolve it, and the adapter of the
    // suite reaches it through `loopbackExchange`
    channel: { label: 'Reference', commandsUrl, messagingWindow: { hours: 24 } },
    ui: { settings: 'https://reference.example.com/settings' },
    scopes: ['channel:connections', 'channel:events'],
    ...over
  })

export interface ContractClock {
  nowMs: number
}

export interface Harness {
  adapter: RemoteChannelPlugin
  service: ReferencePlugin
  // What the adapter reads as the current secrets: the test changes it between calls
  secrets: { value: RemoteCommandSecrets | null }
  clock: ContractClock
}

const context: ChannelContext = {
  storeId: STORE_ID,
  connectionId: CONNECTION_ID,
  credentials: {},
  metadata: {}
}

async function failureOf(work: Promise<unknown>): Promise<PluginError> {
  try {
    await work
  } catch (error) {
    if (error instanceof PluginError) return error
    throw error
  }
  throw new Error('the call was expected to fail')
}

export function testRemoteChannelContract(
  startService: (clock: ContractClock) => Promise<ReferencePlugin>,
  currentSecret = 'secret-one'
): void {
  describe('remote channel contract', () => {
    let harness: Harness
    let deliveries = 0

    beforeEach(async () => {
      const clock: ContractClock = { nowMs: NOW_MS }
      const service = await startService(clock)
      const secrets: Harness['secrets'] = {
        value: { current: currentSecret, previous: null, rotatedAt: null }
      }
      const source: RemoteSecretSource = {
        secretsOf: () => Promise.resolve(secrets.value),
        secretsForDisconnect: () => Promise.resolve(secrets.value)
      }
      const adapter = new RemoteChannelPlugin(referenceManifest(DECLARED_COMMANDS_URL), {
        secrets: source,
        // The loopback, with a short deadline so that a stalled service is read as slow within the test
        exchange: (_declared, options) =>
          loopbackExchange(service.url, {
            ...options,
            timeoutMs: Math.min(options.timeoutMs, 400)
          }),
        now: () => clock.nowMs,
        deliveryId: () => `delivery-${(deliveries += 1)}`
      })
      harness = { adapter, service, secrets, clock }
    })
    afterEach(async () => {
      await harness.service.stop()
    })

    const send = (key = 'm-1', content = 'hello') =>
      harness.adapter.sendMessage(context, {
        channelIdentity: 'customer-1',
        content,
        idempotencyKey: key
      })

    describe('the signature of a command', () => {
      it('is the one a plugin verifies with the shared secret, over the exact bytes of the body', async () => {
        await send()

        const [command] = harness.service.received
        expect(command?.signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/)
        expect(
          verifyRemoteCommand(
            command?.signature ?? '',
            command?.rawBody ?? '',
            [currentSecret],
            NOW_MS / MS
          )
        ).toBe(true)
        // Another secret, another body, or a body with one byte changed is not that signature
        expect(
          verifyRemoteCommand(command?.signature ?? '', command?.rawBody ?? '', ['x'], NOW_MS / MS)
        ).toBe(false)
        expect(
          verifyRemoteCommand(
            command?.signature ?? '',
            `${command?.rawBody ?? ''} `,
            [currentSecret],
            NOW_MS / MS
          )
        ).toBe(false)
      })

      it('carries a delivery id for each attempt', async () => {
        await send('m-1')
        await send('m-2')

        const ids = harness.service.received.map(command => command.delivery)
        expect(new Set(ids).size).toBe(2)
        expect(ids.every(id => id.startsWith('delivery-'))).toBe(true)
      })

      it('is refused by a plugin that holds another secret, and the platform reads that as a refusal that will not change', async () => {
        harness.service.secrets = ['not-the-secret']

        const failure = await failureOf(send())

        expect(harness.service.refused).toBe(1)
        expect(harness.service.received).toHaveLength(0)
        expect(failure.code).toBe(ErrorCodes.CHANNEL_MESSAGE_FAILED)
        expect(failure.retryable).toBe(false)
        expect(failure.refused).toBe(true)
        // What the plugin said is not repeated to the agent
        expect(failure.message).not.toContain(RemoteChannelErrorCodes.REJECTED)
      })

      it('is refused by a plugin whose clock is more than 5 minutes from the platform, either way', async () => {
        const tolerance = RemoteChannelLimits.SIGNATURE_TOLERANCE_SECONDS * MS
        harness.service.clock.now = () => harness.clock.nowMs + tolerance + MS
        await expect(send('late-1')).rejects.toBeInstanceOf(PluginError)
        harness.service.clock.now = () => harness.clock.nowMs - tolerance - MS
        await expect(send('late-2')).rejects.toBeInstanceOf(PluginError)

        harness.service.clock.now = () => harness.clock.nowMs + tolerance - MS
        await expect(send('inside-1')).resolves.toMatchObject({ status: 'sent' })
        expect(harness.service.refused).toBe(2)
      })

      it('goes with both secrets while a rotation is open, so a plugin that knows either one verifies', async () => {
        harness.secrets.value = {
          current: 'secret-two',
          previous: currentSecret,
          rotatedAt: new Date(NOW_MS - 60 * MS)
        }
        // A plugin that has not taken the new one yet
        harness.service.secrets = [currentSecret]
        await expect(send('old-1')).resolves.toMatchObject({ status: 'sent' })
        // And one that has dropped the old one
        harness.service.secrets = ['secret-two']
        await expect(send('new-1')).resolves.toMatchObject({ status: 'sent' })
        expect(harness.service.refused).toBe(0)
      })

      it('goes with the new secret alone once the ten minutes of the rotation have passed', async () => {
        harness.secrets.value = {
          current: 'secret-two',
          previous: currentSecret,
          rotatedAt: new Date(NOW_MS - (RemoteChannelLimits.ROTATION_GRACE_SECONDS + 1) * MS)
        }
        harness.service.secrets = [currentSecret]

        await expect(send()).rejects.toBeInstanceOf(PluginError)
        harness.service.secrets = ['secret-two']
        await expect(send('after-1')).resolves.toMatchObject({ status: 'sent' })
      })

      it('is never made for a store with no active installation: nothing is sent', async () => {
        harness.secrets.value = null

        const failure = await failureOf(send())

        expect(failure.code).toBe(ErrorCodes.CHANNEL_NOT_CONNECTED)
        expect(failure.retryable).toBe(false)
        expect(harness.service.received).toHaveLength(0)
      })
    })

    describe('message.send', () => {
      it('says who, where and what, and takes the provider id the plugin gives back', async () => {
        const result = await harness.adapter.sendMessage(context, {
          channelIdentity: 'customer-1',
          content: 'hello',
          replyToExternalId: 'ref-0',
          idempotencyKey: 'message-1'
        })

        expect(result).toMatchObject({ externalId: 'ref-1', status: 'sent' })
        expect(harness.service.received).toHaveLength(1)
        expect(harness.service.received[0]).toMatchObject({
          command: RemoteChannelCommands.MESSAGE_SEND,
          // The store and the connection are those of the context, never the credentials of anybody
          storeId: STORE_ID,
          connectionId: CONNECTION_ID,
          idempotencyKey: 'message-1',
          data: {
            messageId: 'message-1',
            channelIdentity: 'customer-1',
            type: RemoteChannelSendTypes.TEXT,
            content: 'hello',
            replyToExternalId: 'ref-0'
          }
        })
        expect(harness.service.received[0]?.rawBody).not.toContain('credentials')
      })

      it('sends a file as an address the plugin can read for ten minutes, with its own text', async () => {
        const ttls: number[] = []
        const result = await harness.adapter.sendMedia(context, {
          channelIdentity: 'customer-1',
          contentType: 'image/png; charset=binary',
          fileSize: 10,
          openFile: () => Promise.reject(new Error('a remote plugin is never given the bytes')),
          signedUrl: ttl => {
            ttls.push(ttl)
            return Promise.resolve('https://files.example.com/signed/photo.png?sig=abc')
          },
          filename: 'photo.png',
          caption: 'the photo',
          idempotencyKey: 'file-1'
        })

        expect(result.status).toBe('sent')
        expect(ttls).toEqual([RemoteChannelLimits.MEDIA_URL_TTL_SECONDS])
        expect(harness.service.received[0]?.data).toMatchObject({
          type: RemoteChannelSendTypes.IMAGE,
          content: 'the photo',
          media: {
            url: 'https://files.example.com/signed/photo.png?sig=abc',
            contentType: 'image/png',
            filename: 'photo.png'
          }
        })
      })

      it('refuses a file when the caller has no storage to sign for, without calling the plugin', async () => {
        const failure = await failureOf(
          harness.adapter.sendMedia(context, {
            channelIdentity: 'customer-1',
            contentType: 'image/png',
            fileSize: 10,
            openFile: () => Promise.reject(new Error('unused')),
            filename: null,
            idempotencyKey: 'file-2'
          })
        )

        expect(failure.refused).toBe(true)
        expect(harness.service.received).toHaveLength(0)
      })

      it('is idempotent: the same key twice is one message, and the second answer is the first', async () => {
        const first = await send('same-key')
        const second = await send('same-key')

        expect(second.externalId).toBe(first.externalId)
        expect(harness.service.duplicates).toBe(1)
        expect(harness.service.received.map(command => command.idempotencyKey)).toEqual([
          'same-key',
          'same-key'
        ])
        // Another key is another message
        expect((await send('other-key')).externalId).not.toBe(first.externalId)
      })

      it('keeps the key of a resend the same as the key of the send it repeats', async () => {
        await send('message-9')
        await send('message-9')

        const keys = harness.service.received.map(command => command.data['messageId'])
        expect(keys).toEqual(['message-9', 'message-9'])
      })

      it('maps the codes of a refusal to the platform’s own words, and keeps what the plugin says about trying again', async () => {
        harness.service.script({
          status: 409,
          body: { error: { code: RemoteChannelErrorCodes.WINDOW_CLOSED, message: 'secret detail' } }
        })
        const closed = await failureOf(send('w-1'))
        expect(closed.code).toBe(ErrorCodes.CHANNEL_WINDOW_EXPIRED)
        expect(closed.retryable).toBe(false)
        expect(closed.message).not.toContain('secret detail')

        harness.service.script({
          status: 409,
          body: { error: { code: RemoteChannelErrorCodes.NOT_CONNECTED } }
        })
        expect((await failureOf(send('w-2'))).code).toBe(ErrorCodes.CHANNEL_NOT_CONNECTED)

        // `retryable` of the plugin wins over the status
        harness.service.script({
          status: 429,
          body: { error: { code: RemoteChannelErrorCodes.RATE_LIMITED, retryable: false } }
        })
        expect((await failureOf(send('w-3'))).retryable).toBe(false)
        harness.service.script({ status: 400, body: { error: { code: 'x', retryable: true } } })
        expect((await failureOf(send('w-4'))).retryable).toBe(true)
      })

      it('tries again after a 429 or a 5xx, and does not after another 4xx; a 5xx may have sent it', async () => {
        harness.service.script({ status: 429, body: {} })
        const throttled = await failureOf(send('r-1'))
        expect(throttled.retryable).toBe(true)
        expect(throttled.refused).toBe(true)

        harness.service.script({ status: 503, body: {} })
        const broken = await failureOf(send('r-2'))
        expect(broken.retryable).toBe(true)
        expect(broken.outcomeUnknown).toBe(true)

        harness.service.script({ status: 422, body: { error: { code: 'recipient_invalid' } } })
        const invalid = await failureOf(send('r-3'))
        expect(invalid.retryable).toBe(false)
        expect(invalid.refused).toBe(true)
      })

      it('does not follow a redirect: a 3xx is a refusal', async () => {
        harness.service.script({ status: 302, body: {} })

        const failure = await failureOf(send())

        expect(failure.retryable).toBe(false)
        expect(failure.refused).toBe(true)
      })

      it('says the outcome is not known when the plugin hangs up, stalls, or answers 200 with nonsense', async () => {
        harness.service.script({ hangUp: true })
        const hungUp = await failureOf(send('u-1'))
        expect(hungUp.outcomeUnknown).toBe(true)
        expect(hungUp.retryable).toBe(true)

        harness.service.script({ delayMs: 1500 })
        const stalled = await failureOf(send('u-2'))
        expect(stalled.outcomeUnknown).toBe(true)

        harness.service.script({ status: 200, body: { nothing: 'useful' } })
        const nonsense = await failureOf(send('u-3'))
        expect(nonsense.outcomeUnknown).toBe(true)
        // Sending it again could send it twice
        expect(nonsense.retryable).toBe(false)
      })

      it('reads at most the ceiling of an answer: a plugin that streams is cut off', async () => {
        harness.service.script({
          status: 200,
          oversizeBytes: RemoteChannelLimits.MAX_RESPONSE_BYTES + 1024
        })

        const failure = await failureOf(send())

        expect(failure.retryable).toBe(false)
        expect(failure.outcomeUnknown).toBe(true)
      })

      it('refuses to send a body past the ceiling of a request, without calling the plugin', async () => {
        const failure = await failureOf(
          send('big-1', 'x'.repeat(RemoteChannelLimits.MAX_REQUEST_BYTES))
        )

        expect(failure.refused).toBe(true)
        expect(harness.service.received).toHaveLength(0)
      })

      it('says only the platform’s words when the answer says more than the table allows', async () => {
        harness.service.script({
          status: 200,
          body: { externalId: 'ref-x', status: 'sent', extra: '<script>alert(1)</script>' }
        })

        const result = await send()

        expect(result).toEqual({
          externalId: 'ref-x',
          status: 'sent',
          sentAt: new Date(NOW_MS).toISOString()
        })
      })
    })

    describe('connection.health', () => {
      it('reads healthy from the plugin, and stamps the time of the check itself', async () => {
        const health = await harness.adapter.healthCheck(context)

        expect(health).toEqual({ healthy: true, checkedAt: new Date(NOW_MS).toISOString() })
        expect(harness.service.received[0]?.command).toBe(RemoteChannelCommands.CONNECTION_HEALTH)
      })

      it('carries what the plugin says when it is not healthy, and counts a failed check as a failure', async () => {
        harness.service.script({ status: 200, body: { healthy: false, error: 'login expired' } })
        expect(await harness.adapter.healthCheck(context)).toMatchObject({
          healthy: false,
          error: 'login expired'
        })

        harness.service.script({ status: 500, body: {} })
        await expect(harness.adapter.healthCheck(context)).rejects.toBeInstanceOf(PluginError)
        harness.service.script({ status: 200, body: { unknown: true } })
        await expect(harness.adapter.healthCheck(context)).rejects.toBeInstanceOf(PluginError)
      })
    })

    describe('typing and read hooks', () => {
      it('sends typing start and stop, and the read mark with the provider id of the message', async () => {
        await harness.adapter.sendTypingIndicator?.(context, {
          channelIdentity: 'customer-1',
          active: true
        })
        await harness.adapter.sendTypingIndicator?.(context, {
          channelIdentity: 'customer-1',
          active: false
        })
        await harness.adapter.markAsRead?.(context, {
          channelIdentity: 'customer-1',
          externalId: 'ext-5'
        })

        expect(harness.service.received.map(command => [command.command, command.data])).toEqual([
          [RemoteChannelCommands.TYPING_SEND, { channelIdentity: 'customer-1', state: 'start' }],
          [RemoteChannelCommands.TYPING_SEND, { channelIdentity: 'customer-1', state: 'stop' }],
          [
            RemoteChannelCommands.MESSAGE_MARK_READ,
            { channelIdentity: 'customer-1', externalId: 'ext-5' }
          ]
        ])
      })

      it('are present only when the manifest declares the capability', () => {
        const without = new RemoteChannelPlugin(
          referenceManifest(DECLARED_COMMANDS_URL, { capabilities: [ChannelCapability.TEXT] }),
          {
            secrets: {
              secretsOf: () => Promise.resolve(null),
              secretsForDisconnect: () => Promise.resolve(null)
            }
          }
        )

        expect(without.sendTypingIndicator).toBeUndefined()
        expect(without.markAsRead).toBeUndefined()
        expect(harness.adapter.sendTypingIndicator).toBeDefined()
        expect(harness.adapter.markAsRead).toBeDefined()
      })
    })

    describe('connection.disconnect', () => {
      it('tells the plugin once and never fails the caller, even when the plugin is down', async () => {
        await harness.adapter.disconnect(context)
        expect(harness.service.received.map(command => command.command)).toEqual([
          RemoteChannelCommands.CONNECTION_DISCONNECT
        ])

        harness.service.script({ hangUp: true })
        await expect(harness.adapter.disconnect(context)).resolves.toBeUndefined()
        harness.service.script({ status: 500, body: {} })
        await expect(harness.adapter.disconnect(context)).resolves.toBeUndefined()
      })
    })

    describe('what the platform never does for a remote plugin', () => {
      it('does not connect from the platform: the account is linked in the settings page of the plugin', async () => {
        await expect(
          harness.adapter.connect({ storeId: STORE_ID, credentials: {} })
        ).rejects.toMatchObject({
          statusCode: 409,
          metadata: { settingsUrl: 'https://reference.example.com/settings' }
        })
      })

      it('reads no webhook of a provider: its events arrive normalised at the plugin API', async () => {
        expect(harness.adapter.receivesProviderWebhooks).toBe(false)
        expect(harness.adapter.validateWebhookSignature()).toBe(false)
        await expect(harness.adapter.handleWebhook()).resolves.toEqual([])
      })

      it('passes only a well-formed public https address of a file on to the fetch', () => {
        expect(harness.adapter.acceptsMediaLink('https://cdn.example.com/a.png')).toBe(true)
        for (const ref of [
          'http://cdn.example.com/a.png',
          'https://127.0.0.1/a.png',
          'https://user:pass@cdn.example.com/a.png',
          'ftp://cdn.example.com/a.png',
          'not a url'
        ]) {
          expect(harness.adapter.acceptsMediaLink(ref)).toBe(false)
        }
      })
    })

    describe('the registry', () => {
      const logger = new Proxy({}, { get: () => jest.fn() }) as unknown as PinoLogger

      const adapterOf = (manifest: PluginManifest) =>
        new RemoteChannelPlugin(manifest, {
          secrets: {
            secretsOf: () => Promise.resolve(null),
            secretsForDisconnect: () => Promise.resolve(null)
          }
        })

      it('takes the adapter, shows it only to the stores that installed it, and drops it with the last installation', () => {
        const registry = new PluginRegistry(logger)
        registry.syncRemote([
          { plugin: adapterOf(referenceManifest(DECLARED_COMMANDS_URL)), storeIds: [STORE_ID] }
        ])

        expect(registry.list(STORE_ID).map(plugin => plugin.id)).toContain(REFERENCE_PLUGIN_ID)
        expect(registry.list('another-store').map(plugin => plugin.id)).not.toContain(
          REFERENCE_PLUGIN_ID
        )
        expect(registry.isRemote(REFERENCE_PLUGIN_ID)).toBe(true)

        registry.syncRemote([])
        expect(registry.has(REFERENCE_PLUGIN_ID)).toBe(false)
      })

      it('replaces the adapter when the manifest is a newer one', () => {
        const registry = new PluginRegistry(logger)
        const entry = (manifest: PluginManifest) => ({
          plugin: adapterOf(manifest),
          storeIds: [STORE_ID]
        })
        registry.syncRemote([entry(referenceManifest(DECLARED_COMMANDS_URL))])
        registry.syncRemote([entry(referenceManifest(DECLARED_COMMANDS_URL, { version: '1.1.0' }))])

        expect(registry.get(REFERENCE_PLUGIN_ID).version).toBe('1.1.0')
      })

      it('refuses an adapter that declares a capability it has no method for, and keeps the others', () => {
        const registry = new PluginRegistry(logger)
        const refused = registry.syncRemote([
          {
            plugin: Object.assign(adapterOf(referenceManifest(DECLARED_COMMANDS_URL)), {
              sendMessage: undefined as never
            }),
            storeIds: [STORE_ID]
          }
        ])

        expect(refused).toHaveLength(1)
        expect(registry.has(REFERENCE_PLUGIN_ID)).toBe(false)
      })
    })
  })
}

// The events a remote plugin posts to `POST /plugin-api/channel/events` (TDD_10 §6.7.5), as the reference plugin builds them
// for every type of `ChannelEventTypes` it may report. The suite checks the shape the platform will accept; what the platform does
// with each one (the connection is the installation's, a status event is about a message of its own, the capability exists)
// is the integration suite's (`tests/api/plugin-channel.spec.ts`), which uses the same builders.
export function referenceEvents(connectionId: string, at = new Date()): Record<string, object> {
  const timestamp = at.toISOString()
  const base = { connectionId, channelIdentity: 'customer-1', timestamp }
  return {
    received: {
      ...base,
      type: ChannelEventTypes.MESSAGE_RECEIVED,
      channelProfile: { displayName: 'A customer' },
      message: { externalId: 'in-1', type: MessageType.TEXT, content: 'hello', timestamp }
    },
    // The plugin's own account sent it from another device: the platform shows it as the agent's side
    echo: {
      ...base,
      type: ChannelEventTypes.MESSAGE_ECHO,
      message: {
        externalId: 'out-1',
        type: MessageType.TEXT,
        content: 'sent from the phone',
        timestamp
      }
    },
    reaction: {
      ...base,
      type: ChannelEventTypes.MESSAGE_REACTION,
      reaction: { targetExternalId: 'in-1', emoji: '👍', eventId: 'reaction-1' }
    },
    edited: {
      ...base,
      type: ChannelEventTypes.MESSAGE_EDITED,
      edit: { targetExternalId: 'in-1', content: 'hello again', eventId: 'edit-1' }
    },
    deleted: {
      ...base,
      type: ChannelEventTypes.MESSAGE_DELETED,
      deletion: { targetExternalId: 'in-1', eventId: 'deletion-1' }
    },
    delivered: {
      ...base,
      type: ChannelEventTypes.MESSAGE_DELIVERED,
      status: { externalId: 'ref-1' }
    },
    read: { ...base, type: ChannelEventTypes.MESSAGE_READ, status: { externalId: 'ref-1' } },
    failed: {
      ...base,
      type: ChannelEventTypes.MESSAGE_FAILED,
      status: { externalId: 'ref-1', error: { code: 'rejected', message: 'the provider refused' } }
    },
    typing: { ...base, type: ChannelEventTypes.CUSTOMER_TYPING }
  }
}

export function testReferenceEventsContract(): void {
  describe('the events of a remote plugin', () => {
    const events = referenceEvents(CONNECTION_ID)

    it.each(Object.keys(events))('accepts the %s event the reference plugin builds', name => {
      const parsed = remoteChannelEventsBodySchema.safeParse({ events: [events[name]] })
      expect(parsed.success ? [] : parsed.error.issues).toEqual([])
    })

    it('takes fifty events in a request and refuses fifty-one, or none', () => {
      const one = events['received']
      expect(remoteChannelEventsBodySchema.safeParse({ events: Array(50).fill(one) }).success).toBe(
        true
      )
      expect(remoteChannelEventsBodySchema.safeParse({ events: Array(51).fill(one) }).success).toBe(
        false
      )
      expect(remoteChannelEventsBodySchema.safeParse({ events: [] }).success).toBe(false)
    })

    it('refuses what a plugin has no business saying, or says too long', () => {
      const received = events['received'] as { message: object }
      const bad = [
        { ...received, storeId: 'another-store' },
        { ...received, type: 'not_an_event' },
        { ...received, channelIdentity: 'x'.repeat(129) },
        { ...received, timestamp: new Date(Date.now() - 31 * 86_400_000).toISOString() },
        { ...received, timestamp: new Date(Date.now() + 10 * 60_000).toISOString() },
        {
          ...received,
          message: { ...received.message, content: 'x'.repeat(4097) }
        },
        {
          ...received,
          message: {
            ...received.message,
            media: [
              { ref: 'http://cdn.example.com/a.png', contentType: 'image/png', filename: null }
            ]
          }
        },
        {
          ...received,
          message: {
            ...received.message,
            media: [{ ref: 'https://10.0.0.5/a.png', contentType: 'image/png', filename: null }]
          }
        }
      ]
      for (const event of bad) {
        expect(remoteChannelEventsBodySchema.safeParse({ events: [event] }).success).toBe(false)
      }
      expect(
        remoteChannelEventsBodySchema.safeParse({ events: [received], storeId: 'x' }).success
      ).toBe(false)
    })
  })
}
