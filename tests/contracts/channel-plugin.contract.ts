import type { PinoLogger } from 'nestjs-pino'

import {
  CapabilityOfMediaKind,
  CHANNEL_ID_PATTERN,
  ChannelMediaKinds,
  DeliveryStatus,
  MessageType
} from '@platform/core/domain'
import { PluginRegistry } from '@platform/plugins/runtime'
import {
  ChannelCapability,
  type ChannelContext,
  ChannelEventTypes,
  type ChannelPlugin,
  type SendMessageParams
} from '@platform/plugins/sdk'

// What differs per plugin: captured from the real provider, with personal data replaced. The suite
// itself knows no channel.
export interface PluginTestFixtures {
  // A valid, signed inbound event
  inboundWebhook: { rawBody: string; headers: Record<string, string>; body: unknown }
  // A valid payload that carries no events
  emptyWebhook: unknown
  invalidSignatureHeaders: Record<string, string>
  // Dummy credentials the plugin's schema accepts
  context: ChannelContext
  sendParams: SendMessageParams
}

// The timestamps of the SDK are ISO 8601 (ChannelEvent.timestamp), not whatever Date can parse
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

// This suite is the definition of the SDK: a change that breaks it breaks every plugin.
export function testChannelPluginContract(
  createPlugin: () => ChannelPlugin,
  fixtures: PluginTestFixtures,
  // Only the spec of an official plugin, beside its code, says so: a third-party plugin that takes
  // an official id must fail its own contract
  options: { official?: boolean } = {}
): void {
  describe('ChannelPlugin contract', () => {
    let plugin: ChannelPlugin
    beforeEach(() => {
      plugin = createPlugin()
    })

    it('declares its identity', () => {
      expect(plugin.id).toMatch(CHANNEL_ID_PATTERN)
      expect(plugin.version).toMatch(/^\d+\.\d+\.\d+$/)
      expect(plugin.type).toBe('channel')
      expect(plugin.capabilities.length).toBeGreaterThan(0)
    })

    it('declares capabilities that exist', () => {
      const known: readonly string[] = Object.values(ChannelCapability)
      for (const capability of plugin.capabilities) expect(known).toContain(capability)
    })

    // The registry holds the rules (every method a channel needs, the method behind each
    // capability, the window policy): the suite asks it and does not keep a copy that could drift
    it('is accepted by the plugin registry, which checks what its capabilities require', () => {
      // Any logger method is a no-op: the suite must not depend on which ones the registry calls
      const logger = new Proxy({}, { get: () => jest.fn() }) as unknown as PinoLogger
      expect(() =>
        new PluginRegistry(logger).register(plugin, { official: options.official === true })
      ).not.toThrow()
    })

    // The login of Step 7.8 is optional: a plugin without one passes with nothing, and one that declares it
    // is held to the same shape as at boot, and the core keeps exactly the scopes it declared
    it('keeps the login it declares, if any, exactly as declared', () => {
      const logger = new Proxy({}, { get: () => jest.fn() }) as unknown as PinoLogger
      const registry = new PluginRegistry(logger)
      registry.register(plugin, { official: options.official === true })
      expect(registry.oauthOf(plugin.id)?.scopes ?? []).toEqual(plugin.oauth?.scopes ?? [])
      expect(registry.oauthOf(plugin.id)?.kind).toBe(plugin.oauth?.kind)
    })

    // The files a channel takes are declared once for the platform and for the plugin: a channel with a kind of
    // file as a capability has a rule for it, the registry keeps exactly that, and the plugin that sends a file
    // holds itself to it
    it('declares the files it takes for exactly the kinds of file it has as capabilities', () => {
      const logger = new Proxy({}, { get: () => jest.fn() }) as unknown as PinoLogger
      const registry = new PluginRegistry(logger)
      registry.register(plugin, { official: options.official === true })
      const kinds = Object.keys(registry.mediaOf(plugin.id)?.kinds ?? {}).sort()
      const expected = Object.values(ChannelMediaKinds)
        .filter(kind => plugin.capabilities.includes(CapabilityOfMediaKind[kind]))
        .sort()
      expect(kinds).toEqual(expected)
    })

    it('rejects an invalid webhook signature', () => {
      expect(
        plugin.validateWebhookSignature(
          fixtures.inboundWebhook.rawBody,
          fixtures.invalidSignatureHeaders
        )
      ).toBe(false)
    })

    it('accepts a valid webhook signature', () => {
      expect(
        plugin.validateWebhookSignature(
          fixtures.inboundWebhook.rawBody,
          fixtures.inboundWebhook.headers
        )
      ).toBe(true)
    })

    it('normalizes a webhook into valid ChannelEvent objects with a recipient', async () => {
      const events = await plugin.handleWebhook(fixtures.inboundWebhook.body)

      expect(events.length).toBeGreaterThan(0)
      for (const event of events) {
        expect(Object.values(ChannelEventTypes)).toContain(event.type)
        expect(event.connectionId).toBeTruthy()
        expect(event.channelIdentity).toBeTruthy()
        expect(event.timestamp).toMatch(ISO_8601)
        if (event.message) {
          expect(event.message.externalId).toBeTruthy()
          expect(Object.values(MessageType)).toContain(event.message.type)
        }
      }
    })

    it('handles an empty webhook payload without throwing', async () => {
      await expect(plugin.handleWebhook(fixtures.emptyWebhook)).resolves.toEqual([])
    })

    it('handles garbage without throwing', async () => {
      await expect(plugin.handleWebhook({ unexpected: true })).resolves.toEqual([])
      await expect(plugin.handleWebhook(null)).resolves.toEqual([])
      await expect(plugin.handleWebhook('text')).resolves.toEqual([])
    })

    it('returns a normalized result from sendMessage', async () => {
      // The provider's HTTP is mocked by the fixture setup of each plugin
      const result = await plugin.sendMessage(fixtures.context, fixtures.sendParams)
      expect(result.externalId).toBeTruthy()
      expect(Object.values(DeliveryStatus)).toContain(result.status)
      expect(result.sentAt).toMatch(ISO_8601)
    })
  })
}
