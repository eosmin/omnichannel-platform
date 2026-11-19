import type { ExecutionContext } from '@nestjs/common'

import { ErrorCodes, HttpStatusCodes } from '@platform/core/errors'

import { PluginApiKeyGuard } from './plugin-api-key.guard'

// The row of the plugin an installation points at belongs to another organization or is hidden by the policy of `plugins`: read
// through the context of the store it comes back null. The guard must answer 401 (the answer of a key that does not exist), never a
// 500 from reading a field of null, and it must not need the nested row to know the status of the plugin.
const mockResolveInstallation = jest.fn()
const mockResolvePluginStatus = jest.fn()
jest.mock('@platform/core/database', () => ({
  PrismaService: class PrismaService {},
  contextOf: (row: { storeId: string; organizationId: string }) => ({
    storeIds: [row.storeId],
    organizationIds: [row.organizationId]
  }),
  resolvePluginInstallation: (...args: unknown[]): unknown => mockResolveInstallation(...args),
  resolvePluginInstallationPluginStatus: (...args: unknown[]): unknown =>
    mockResolvePluginStatus(...args)
}))
jest.mock('./plugin-denial-audit', () => ({ auditPluginDenial: () => Promise.resolve() }))

const STORE = { id: 'store-b', organizationId: 'org-b', name: 'Store B' }
const FOUND = { id: 'inst-1', storeId: STORE.id, organizationId: STORE.organizationId }

function installationRow(status = 'active'): Record<string, unknown> {
  // As the read inside the context of the store answers it: no `plugin`, because the guard no longer asks for it there
  return {
    id: FOUND.id,
    pluginId: 'plugin-of-org-a',
    scopes: [],
    status,
    rateLimitPerMinute: 60,
    store: STORE
  }
}

function build(row: Record<string, unknown> | null): PluginApiKeyGuard {
  const findFirst = jest.fn().mockResolvedValue(row)
  const prisma = {
    client: { pluginInstallation: { findFirst } },
    tenantTransaction: (_context: unknown, work: () => Promise<unknown>) => work()
  }
  const reflector = { getAllAndOverride: () => [], getAllAndMerge: () => [] }
  const throttle = { increment: () => Promise.resolve({ isBlocked: false }) }
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
  return new PluginApiKeyGuard(
    prisma as never,
    reflector as never,
    throttle as never,
    logger as never,
    {} as never,
    {} as never
  )
}

const handlerStub = jest.fn()

function contextFor(token: string): ExecutionContext {
  const request: Record<string, unknown> = { headers: { authorization: `Bearer ${token}` } }
  return {
    switchToHttp: () => ({ getRequest: () => request }),
    getHandler: () => handlerStub,
    getClass: () => class Controller {}
  } as unknown as ExecutionContext
}

async function failureOf(guard: PluginApiKeyGuard): Promise<unknown> {
  try {
    await guard.canActivate(contextFor('plg_live_secret'))
  } catch (error) {
    return error
  }
  return undefined
}

describe('PluginApiKeyGuard under row-level security', () => {
  beforeEach(() => {
    mockResolveInstallation.mockReset().mockResolvedValue(FOUND)
    mockResolvePluginStatus.mockReset().mockResolvedValue('approved')
  })

  it('opens the door when the plugin is approved even if its row is hidden from the context of the store', async () => {
    await expect(build(installationRow()).canActivate(contextFor('plg_live_secret'))).resolves.toBe(
      true
    )
  })

  it.each(['suspended', 'rejected', 'submitted'])(
    'answers 401, the answer of an unknown key, for a plugin that is %s',
    async status => {
      mockResolvePluginStatus.mockResolvedValue(status)
      expect(await failureOf(build(installationRow()))).toMatchObject({
        code: ErrorCodes.PLUGIN_API_KEY_INVALID,
        statusCode: HttpStatusCodes.UNAUTHORIZED
      })
    }
  )

  it('answers 401 and never a 500 when no plugin status comes back for the key', async () => {
    mockResolvePluginStatus.mockResolvedValue(null)
    expect(await failureOf(build(installationRow()))).toMatchObject({
      code: ErrorCodes.PLUGIN_API_KEY_INVALID,
      statusCode: HttpStatusCodes.UNAUTHORIZED
    })
  })

  it('answers the same 401 for an installation that is not active', async () => {
    expect(await failureOf(build(installationRow('disabled')))).toMatchObject({
      code: ErrorCodes.PLUGIN_API_KEY_INVALID,
      statusCode: HttpStatusCodes.UNAUTHORIZED
    })
  })

  it('answers the same 401 for a key that resolves to no installation, and asks for no plugin status', async () => {
    mockResolveInstallation.mockResolvedValue(null)
    expect(await failureOf(build(null))).toMatchObject({
      code: ErrorCodes.PLUGIN_API_KEY_INVALID,
      statusCode: HttpStatusCodes.UNAUTHORIZED
    })
    expect(mockResolvePluginStatus).not.toHaveBeenCalled()
  })
})
