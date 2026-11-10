import { ChannelWebhookController } from '../../apps/api/src/modules/channels/channel-webhook.controller'

// The public door of the providers' webhooks refuses a channel that declares it receives none: that channel
// has doors of its own, which check its site, its origins and the limits of its customers
function controllerWith(manifests: Record<string, { receivesProviderWebhooks: boolean }>) {
  const plugin = { validateWebhookSignature: () => true, handleWebhook: () => Promise.resolve([]) }
  const registry = {
    find: (id: string) => (id in manifests ? plugin : undefined),
    connectManifestOf: (id: string) => manifests[id] ?? null
  }
  const metric = { inc: jest.fn() }
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return new ChannelWebhookController(
    registry as never,
    { enqueue: jest.fn() } as never,
    metric as never,
    metric as never,
    logger as never
  )
}

describe('the generic webhook door', () => {
  const controller = controllerWith({
    provider_chat: { receivesProviderWebhooks: true },
    visitor_chat: { receivesProviderWebhooks: false }
  })
  const request = { rawBody: Buffer.from('{}'), body: {} } as never

  it('lets a channel that receives provider webhooks through', async () => {
    await expect(controller.handleWebhook('provider_chat', request, {})).resolves.toEqual({
      received: true
    })
  })

  it.each(['visitor_chat', 'never_registered', 'Bad Id!'])(
    'answers not found for %s, on the handshake and on the body',
    async pluginId => {
      await expect(controller.handleWebhook(pluginId, request, {})).rejects.toThrow(
        'channel not found'
      )
      expect(() => controller.verifyWebhook(pluginId, {}, { type: jest.fn() } as never)).toThrow(
        'channel not found'
      )
    }
  )
})
