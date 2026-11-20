import type { Redis } from 'ioredis'
import type { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import type { AuditService } from '@platform/core/audit-module'
import { PluginApiDenialReasons } from '@platform/core/domain'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { auditPluginDenial } from './plugin-denial-audit'

const installation = { id: 'inst-1', pluginId: 'plugin-1', storeId: 'store-1' }

function build() {
  const log = jest.fn()
  const logRefused = jest.fn<void, [Record<string, unknown>]>()
  const redis = { set: jest.fn().mockResolvedValue('OK') }
  const logger = { warn: jest.fn() }
  const request = {
    method: 'POST',
    ip: '203.0.113.9',
    route: { path: '/plugin-api/messages' },
    get: () => 'suite-agent'
  } as unknown as AuthenticatedRequest
  return {
    deps: {
      audit: { log, logRefused } as unknown as AuditService,
      redis: redis as unknown as Redis,
      logger: logger as unknown as PinoLogger
    },
    log,
    logRefused,
    request
  }
}

describe('auditPluginDenial', () => {
  it('writes the entry detached from the request, so the 403 that follows cannot roll it back', async () => {
    const { deps, log, logRefused, request } = build()

    await auditPluginDenial(deps, request, {
      reason: PluginApiDenialReasons.SCOPE,
      installation,
      missing: ['media:write']
    })

    expect(log).not.toHaveBeenCalled()
    expect(logRefused).toHaveBeenCalledTimes(1)
    expect(logRefused.mock.calls[0]?.[0]).toMatchObject({
      action: AuditAction.PLUGIN_API_DENIED,
      actor: { system: true },
      storeId: 'store-1',
      resourceId: 'inst-1',
      metadata: { missing: ['media:write'], installationId: 'inst-1' }
    })
  })
})
