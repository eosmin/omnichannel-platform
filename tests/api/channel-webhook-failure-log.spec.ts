import type { Counter } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'

import { ErrorCodes } from '@platform/core/errors'
import type { PluginRegistry } from '@platform/plugins/runtime'
import { PluginError } from '@platform/plugins/sdk'

import { ChannelWebhookController } from '../../apps/api/src/modules/channels/channel-webhook.controller'
import type { InboundEventQueue } from '../../apps/api/src/modules/channels/inbound-event-queue.service'

// What a webhook body that a plugin cannot read may leave in the log: the error is acknowledged
// (the signature was good), and a parser error can echo a piece of the customer's payload, so only
// the name, the code and the provider numbers are logged, never the message or the stack.
const PAYLOAD_ECHO = 'customer text 600-0000 that a parser echoed'

function controllerWith(handleWebhook: () => Promise<unknown>) {
  const logs: Array<[object, string]> = []
  const logger = {
    setContext: jest.fn(),
    warn: jest.fn(),
    error: jest.fn((bindings: object, message: string) => {
      logs.push([bindings, message])
    })
  }
  const enqueue = jest.fn().mockResolvedValue(undefined)
  const plugin = {
    validateWebhookSignature: () => true,
    handleWebhook
  }
  const registry = {
    connectManifestOf: () => ({ receivesProviderWebhooks: true }),
    find: () => plugin
  }
  const counter = { inc: jest.fn() }
  const controller = new ChannelWebhookController(
    registry as unknown as PluginRegistry,
    { enqueue } as unknown as InboundEventQueue,
    counter as unknown as Counter<string>,
    counter as unknown as Counter<string>,
    logger as unknown as PinoLogger
  )
  return { controller, logs, enqueue }
}

async function receive(controller: ChannelWebhookController): Promise<unknown> {
  return controller.handleWebhook('channel', { rawBody: Buffer.from('{}'), body: {} } as never, {})
}

describe('ChannelWebhookController, a body the plugin cannot read', () => {
  it('logs the name, the code and the provider numbers of a plugin error, never its stack', async () => {
    const error = new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { providerCode: 100 })
    error.stack = `PluginError: ${PAYLOAD_ECHO}`
    const { controller, logs, enqueue } = controllerWith(() => Promise.reject(error))

    await expect(receive(controller)).resolves.toEqual({ received: true })

    expect(enqueue).toHaveBeenCalledWith('channel', [])
    expect(logs).toHaveLength(1)
    const [bindings] = logs[0] as [Record<string, unknown>, string]
    expect(bindings).toMatchObject({
      pluginId: 'channel',
      errorName: 'PluginError',
      errorCode: ErrorCodes.CHANNEL_MESSAGE_FAILED,
      providerCode: 100
    })
    expect(bindings).not.toHaveProperty('err')
    expect(JSON.stringify(logs)).not.toContain(PAYLOAD_ECHO)
  })

  it('logs only the class name of an error that is not a plugin error', async () => {
    const { controller, logs } = controllerWith(() => Promise.reject(new Error(PAYLOAD_ECHO)))

    await receive(controller)

    expect(logs[0]?.[0]).toMatchObject({ pluginId: 'channel', errorName: 'Error' })
    expect(JSON.stringify(logs)).not.toContain(PAYLOAD_ECHO)
  })
})
