import type { PinoLogger } from 'nestjs-pino'

import { ErrorCodes, PluginChecks } from '@platform/core/errors'
import { PluginError } from '@platform/plugins/sdk'

import { ChannelConnectionsService } from './channel-connections.service'

// The barrel of the connections lib loads the environment (env.ts), which a unit spec has no business
// reading: only the helpers the service calls are replaced, with the behavior the connect path needs
jest.mock('@platform/channels/connections', () => ({
  CONNECTION_ROW_SELECT: {},
  ChannelContextFactory: class {},
  ChannelHealthService: class {},
  errorName: (error: unknown) => (error instanceof Error ? error.name : 'unknown'),
  providerText: () => '',
  ProviderTimeoutError: class ProviderTimeoutError extends Error {},
  withTimeout: <T>(work: Promise<T>) => work
}))

const TOKEN = 'EAAB-secret-token-value'
const STORE = '00000000-0000-4000-8000-000000000001'
const PLUGIN = 'messenger'

function build(connect: () => Promise<unknown>): {
  service: ChannelConnectionsService
  warn: jest.Mock<void, [Record<string, unknown>, string]>
} {
  const warn = jest.fn<void, [Record<string, unknown>, string]>()
  const logger = { setContext: jest.fn(), warn } as unknown as PinoLogger
  const prisma = { client: { $queryRaw: jest.fn().mockResolvedValue([{ id: 'installation' }]) } }
  const registry = { isVisibleTo: () => true, get: () => ({ connect }) }
  const service = new ChannelConnectionsService(
    prisma as never,
    registry as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    logger
  )
  return { service, warn }
}

const actor = { userId: 'u' } as never

describe('ChannelConnectionsService.connect, a refused connection', () => {
  it('logs the numbers of the provider answer, never the token, and the user still sees CHANNEL_CREDENTIALS_INVALID', async () => {
    // What a Graph that answers (#100) Invalid parameter becomes in the plugin: numbers only
    const refusal = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
      retryable: false,
      providerCode: 100,
      providerSubcode: 33
    })
    const { service, warn } = build(() => Promise.reject(refusal))

    await expect(
      service.connect(STORE, PLUGIN, { credentials: { accessToken: TOKEN } }, actor)
    ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID })

    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toEqual({
      pluginId: PLUGIN,
      storeId: STORE,
      errorName: 'PluginError',
      errorCode: ErrorCodes.CHANNEL_CREDENTIALS_INVALID,
      providerCode: 100,
      providerSubcode: 33
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
  })

  it('logs the name of the local check that refused', async () => {
    const refusal = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, {
      retryable: false,
      failedCheck: PluginChecks.SUBSCRIPTION_NOT_CONFIRMED
    })
    const { service, warn } = build(() => Promise.reject(refusal))

    await expect(
      service.connect(STORE, PLUGIN, { credentials: { accessToken: TOKEN } }, actor)
    ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID })

    expect(warn.mock.calls[0]?.[0]).toMatchObject({
      failedCheck: PluginChecks.SUBSCRIPTION_NOT_CONFIRMED
    })
  })

  it('logs only the name of an error that carries the token in its message', async () => {
    const { service, warn } = build(() => Promise.reject(new TypeError(`bad ${TOKEN}`)))

    await expect(
      service.connect(STORE, PLUGIN, { credentials: { accessToken: TOKEN } }, actor)
    ).rejects.toMatchObject({ code: ErrorCodes.CHANNEL_CREDENTIALS_INVALID })

    expect(warn.mock.calls[0]?.[0]).toEqual({
      pluginId: PLUGIN,
      storeId: STORE,
      errorName: 'TypeError'
    })
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN)
  })
})
