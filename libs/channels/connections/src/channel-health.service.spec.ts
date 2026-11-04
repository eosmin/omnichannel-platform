import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'
import { ChannelHealthErrors } from '@platform/core/domain'
import type { DomainEvents } from '@platform/core/event-bus'
import type { ChannelPlugin } from '@platform/plugins/sdk'

import { type ChannelContextFactory, CredentialsUnreadableError } from './channel-context.factory'
import { ChannelHealthService } from './channel-health.service'

const row = {
  id: 'row-1',
  storeId: 'store-1',
  pluginId: 'plugin-1',
  connectionId: 'acct-1',
  status: 'active',
  credentials: new Uint8Array(),
  metadata: {}
}

function serviceWith(contextFor: () => unknown) {
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const service = new ChannelHealthService(
    {} as PrismaService,
    { contextFor } as unknown as ChannelContextFactory,
    {} as DomainEvents,
    logger as unknown as PinoLogger
  )
  return { service, logger }
}

describe('ChannelHealthService.check', () => {
  it('says unhealthy, without throwing, when the credentials cannot be read', async () => {
    const healthCheck = jest.fn()
    const { service, logger } = serviceWith(() => {
      throw new CredentialsUnreadableError()
    })

    const health = await service.check(row, { healthCheck } as unknown as ChannelPlugin)

    expect(health).toEqual({ healthy: false, error: ChannelHealthErrors.CREDENTIALS_UNREADABLE })
    // The provider was never asked, and the log has the name of the error only
    expect(healthCheck).not.toHaveBeenCalled()
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/decrypt|key/i)
  })

  it('still lets any other failure of building the context be what it is', async () => {
    const { service } = serviceWith(() => {
      throw new Error('boom')
    })

    await expect(service.check(row, {} as ChannelPlugin)).rejects.toThrow('boom')
  })
})
