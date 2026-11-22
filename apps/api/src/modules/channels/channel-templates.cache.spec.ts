import type { PinoLogger } from 'nestjs-pino'

import type { ChannelContextFactory } from '@platform/channels/connections'
import type { EventContext, PrismaService } from '@platform/core/database'
import { ChannelConnectionStatus, OutboundLimits, TemplateStatuses } from '@platform/core/domain'
import type { PluginRegistry } from '@platform/plugins/runtime'

import { ChannelTemplatesService } from './channel-templates.service'

// A unit spec reads no environment (CI has no DATABASE_URL): the modules that load it are replaced by what the service uses
jest.mock('@platform/channels/connections', () => ({
  CONNECTION_ROW_SELECT: {},
  ChannelContextFactory: class {},
  CredentialsUnreadableError: class extends Error {},
  errorName: (error: unknown) => (error instanceof Error ? error.name : 'Error'),
  providerText: (text: string) => text,
  withTimeout: (work: Promise<unknown>) => work
}))
jest.mock('@platform/core/database', () => ({ EventContext: class {}, PrismaService: class {} }))
jest.mock('@platform/core/messaging', () => ({
  canSee: jest.fn(),
  invalidInput: jest.fn(),
  requireAnyPermission: jest.fn()
}))
jest.mock('@platform/plugins/runtime', () => ({ PluginRegistry: class {} }))
jest.mock('@platform/plugins/sdk', () => ({ ChannelCapability: { TEMPLATES: 'templates' } }))

const STORE = 'store-1'
const PLUGIN = 'plugin-1'

function build(row: { id: string; status: string }) {
  const listTemplates = jest
    .fn()
    .mockResolvedValue([
      { name: 'hello', language: 'es', status: TemplateStatuses.APPROVED, body: 'Hi' }
    ])
  const findFirst = jest.fn().mockResolvedValue({
    ...row,
    storeId: STORE,
    pluginId: PLUGIN,
    connectionId: 'c',
    credentials: null,
    metadata: {}
  })
  const service = new ChannelTemplatesService(
    { client: { channelConnection: { findFirst } } } as unknown as PrismaService,
    { inStore: (_store: string, run: () => unknown) => run() } as unknown as EventContext,
    {
      find: () => ({ listTemplates }),
      hasCapability: () => true
    } as unknown as PluginRegistry,
    { contextFor: () => ({}) } as unknown as ChannelContextFactory,
    { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger
  )
  return { service, listTemplates }
}

describe('the short cache of the template list of a connection', () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date('2026-11-22T12:00:00Z')))
  afterEach(() => jest.useRealTimers())

  it('asks the provider once for the same connection inside the window, and again after it', async () => {
    const { service, listTemplates } = build({
      id: 'row-1',
      status: ChannelConnectionStatus.ACTIVE
    })

    await service.list(STORE, PLUGIN, 'row-1')
    await service.list(STORE, PLUGIN, 'row-1')
    expect(listTemplates).toHaveBeenCalledTimes(1)

    jest.setSystemTime(Date.now() + OutboundLimits.TEMPLATE_LIST_CACHE_TTL_MS + 1)
    await service.list(STORE, PLUGIN, 'row-1')
    expect(listTemplates).toHaveBeenCalledTimes(2)
  })

  it('does not keep an empty list: the next ask goes to the provider again', async () => {
    const { service, listTemplates } = build({
      id: 'row-1',
      status: ChannelConnectionStatus.ACTIVE
    })
    listTemplates.mockResolvedValueOnce([])

    expect(await service.list(STORE, PLUGIN, 'row-1')).toEqual([])
    expect(await service.list(STORE, PLUGIN, 'row-1')).toHaveLength(1)
    expect(listTemplates).toHaveBeenCalledTimes(2)
  })

  it('keeps the lists of two connections apart', async () => {
    const one = build({ id: 'row-1', status: ChannelConnectionStatus.ACTIVE })
    await one.service.list(STORE, PLUGIN, 'row-1')
    const two = build({ id: 'row-2', status: ChannelConnectionStatus.ACTIVE })
    await two.service.list(STORE, PLUGIN, 'row-2')

    expect(one.listTemplates).toHaveBeenCalledTimes(1)
    expect(two.listTemplates).toHaveBeenCalledTimes(1)
  })

  it('never serves a list for a connection that is disconnected now, and keeps no failure', async () => {
    const { service, listTemplates } = build({
      id: 'row-1',
      status: ChannelConnectionStatus.DISCONNECTED
    })

    await expect(service.list(STORE, PLUGIN, 'row-1')).rejects.toThrow()
    await expect(service.list(STORE, PLUGIN, 'row-1')).rejects.toThrow()
    expect(listTemplates).not.toHaveBeenCalled()
  })

  it('does not let the cache of one store answer for another that asks for the same row id', async () => {
    const { service, listTemplates } = build({
      id: 'row-1',
      status: ChannelConnectionStatus.ACTIVE
    })

    await service.list(STORE, PLUGIN, 'row-1')
    await service.list('store-2', PLUGIN, 'row-1')
    expect(listTemplates).toHaveBeenCalledTimes(2)
  })
})
