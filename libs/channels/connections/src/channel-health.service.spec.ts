import type { PinoLogger } from 'nestjs-pino'

import type { PrismaService } from '@platform/core/database'
import { ChannelHealthErrors } from '@platform/core/domain'
import { ChannelConnectFailureReasons, ErrorCodes } from '@platform/core/errors'
import type { DomainEvents } from '@platform/core/event-bus'
import { type ChannelPlugin, PluginError } from '@platform/plugins/sdk'

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

  describe('when the plugin throws', () => {
    const ask = async (failure: Error) => {
      const { service, logger } = serviceWith(() => ({}))
      const plugin = { healthCheck: () => Promise.reject(failure) } as unknown as ChannelPlugin
      return { health: await service.check(row, plugin), logger }
    }

    it.each([
      [ChannelConnectFailureReasons.TOKEN_REJECTED, ChannelHealthErrors.TOKEN_REJECTED],
      [ChannelConnectFailureReasons.PERMISSION_MISSING, ChannelHealthErrors.PERMISSION_MISSING],
      [ChannelConnectFailureReasons.OTHER_ACCOUNT, ChannelHealthErrors.OTHER_ACCOUNT],
      [ChannelConnectFailureReasons.ACCOUNT_NOT_LINKED, ChannelHealthErrors.ACCOUNT_NOT_LINKED]
    ])(
      'says what is wrong for the reason %s, so the owner knows what to fix',
      async (reason, error) => {
        const { health } = await ask(
          new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { reason })
        )

        expect(health).toEqual({ healthy: false, error })
      }
    )

    it.each([
      ChannelConnectFailureReasons.PROVIDER_BUSY,
      ChannelConnectFailureReasons.PROVIDER_UNAVAILABLE,
      ChannelConnectFailureReasons.PROVIDER_ANSWER_UNEXPECTED,
      ChannelConnectFailureReasons.REQUEST_REJECTED
    ])(
      'keeps the plain failure for the reason %s: it does not say the owner must act',
      async reason => {
        const { health } = await ask(new PluginError(ErrorCodes.CHANNEL_MESSAGE_FAILED, { reason }))

        expect(health).toEqual({ healthy: false, error: ChannelHealthErrors.CHECK_FAILED })
      }
    )

    it('keeps the plain failure for an error that is not a plugin error, and never stores or logs its text', async () => {
      const { health, logger } = await ask(new Error('Bearer SECRET-TOKEN'))

      expect(health).toEqual({ healthy: false, error: ChannelHealthErrors.CHECK_FAILED })
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('SECRET-TOKEN')
    })

    it('does not believe a reason that is not of the list', async () => {
      const forged = new PluginError(ErrorCodes.CHANNEL_CREDENTIALS_INVALID)
      Object.defineProperty(forged, 'reason', { value: 'token_rejected; drop table' })

      const { health } = await ask(forged)

      expect(health).toEqual({ healthy: false, error: ChannelHealthErrors.CHECK_FAILED })
    })
  })
})
