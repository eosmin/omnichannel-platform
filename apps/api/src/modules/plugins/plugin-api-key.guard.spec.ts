import type { ExecutionContext } from '@nestjs/common'

import { PluginApiKeyRefusalFloorMs } from '@platform/core/auth'
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
// The barrel of http reads the environment when it loads (CI has no DATABASE_URL for unit specs): the guard only needs the class
// as the token of its limiter, and the specs hand it a stub
jest.mock('@platform/core/http', () => ({ PluginKeyProbeLimiter: class PluginKeyProbeLimiter {} }))
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

// The probe limiter as the guard sees it: free unless a test says an address has to wait
function probes(waitFor: Record<string, number> = {}): {
  retryAfter: jest.Mock
  recordFailure: jest.Mock
  countRefusal: jest.Mock
} {
  return {
    retryAfter: jest.fn((address: string) => Promise.resolve(waitFor[address] ?? 0)),
    recordFailure: jest.fn().mockResolvedValue(undefined),
    countRefusal: jest.fn()
  }
}

function build(
  row: Record<string, unknown> | null,
  limiter: ReturnType<typeof probes> = probes()
): PluginApiKeyGuard {
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
    {} as never,
    limiter as never
  )
}

const handlerStub = jest.fn()
const ADDRESS = '203.0.113.7'

function contextFor(token: string | undefined, ip = ADDRESS): ExecutionContext {
  const request: Record<string, unknown> = {
    ip,
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` }
  }
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

// Step 7.3, PR S3: the failures of a key are limited per address BEFORE the key is looked up, and every refusal looks the same
describe('PluginApiKeyGuard, the limit of the keys that do not open the door', () => {
  beforeEach(() => {
    mockResolveInstallation.mockReset().mockResolvedValue(null)
    mockResolvePluginStatus.mockReset().mockResolvedValue('approved')
  })

  async function failureFor(
    guard: PluginApiKeyGuard,
    token: string | undefined,
    ip = ADDRESS
  ): Promise<unknown> {
    try {
      await guard.canActivate(contextFor(token, ip))
    } catch (error) {
      return error
    }
    return undefined
  }

  it('answers 429 with the time to wait, with no lookup of the key, for an address that is over the limit', async () => {
    const limiter = probes({ [ADDRESS]: 17 })

    expect(await failureFor(build(null, limiter), 'plg_live_made_up')).toMatchObject({
      code: ErrorCodes.RATE_LIMIT_EXCEEDED,
      statusCode: HttpStatusCodes.TOO_MANY_REQUESTS
    })

    expect(mockResolveInstallation).not.toHaveBeenCalled()
    expect(mockResolvePluginStatus).not.toHaveBeenCalled()
    expect(limiter.countRefusal).toHaveBeenCalledTimes(1)
    // A call refused for the wait is not a new failure: the block does not stretch itself
    expect(limiter.recordFailure).not.toHaveBeenCalled()
  })

  it('refuses a call with no key at all before anything else when the address is over the limit', async () => {
    const limiter = probes({ [ADDRESS]: 5 })

    expect(await failureFor(build(null, limiter), undefined)).toMatchObject({
      code: ErrorCodes.RATE_LIMIT_EXCEEDED
    })
    expect(mockResolveInstallation).not.toHaveBeenCalled()
  })

  it('does not touch a valid key that comes from another address', async () => {
    mockResolveInstallation.mockResolvedValue(FOUND)
    const limiter = probes({ [ADDRESS]: 30 })

    await expect(
      build(installationRow(), limiter).canActivate(contextFor('plg_live_secret', '198.51.100.9'))
    ).resolves.toBe(true)

    expect(limiter.retryAfter).toHaveBeenCalledWith('198.51.100.9')
    expect(limiter.recordFailure).not.toHaveBeenCalled()
  })

  it('counts nothing against the address for a key that opens the door', async () => {
    mockResolveInstallation.mockResolvedValue(FOUND)
    const limiter = probes()

    await build(installationRow(), limiter).canActivate(contextFor('plg_live_secret'))

    expect(limiter.recordFailure).not.toHaveBeenCalled()
  })

  it.each([
    ['no header', undefined],
    ['a token without the shape of a key', 'not_a_key'],
    ['a key that resolves to nothing', 'plg_live_made_up']
  ])('counts a failure against the address for %s', async (_label, token) => {
    const limiter = probes()

    await failureFor(build(null, limiter), token)

    expect(limiter.recordFailure).toHaveBeenCalledWith(ADDRESS)
  })

  it('counts nothing for a key that exists but is not active: it is no guess, and its retries must not lock out its siblings', async () => {
    mockResolveInstallation.mockResolvedValue(FOUND)
    const limiter = probes()

    const failure = await failureFor(build(installationRow('disabled'), limiter), 'plg_live_secret')

    expect(failure).toMatchObject({ code: ErrorCodes.PLUGIN_API_KEY_INVALID })
    expect(limiter.recordFailure).not.toHaveBeenCalled()
  })

  it('answers every kind of failed key with the same code, status and message', async () => {
    mockResolveInstallation.mockResolvedValue(FOUND)
    const answers = await Promise.all([
      failureFor(build(null), undefined),
      failureFor(build(null), 'not_a_key'),
      failureFor(build(null), 'plg_live_made_up'),
      failureFor(build(installationRow('disabled')), 'plg_live_secret')
    ])

    const shapes = answers.map(answer => {
      const { code, statusCode, message } = answer as {
        code: string
        statusCode: number
        message: string
      }
      return { code, statusCode, message }
    })
    expect(new Set(shapes.map(shape => JSON.stringify(shape))).size).toBe(1)
    expect(shapes[0]).toMatchObject({
      code: ErrorCodes.PLUGIN_API_KEY_INVALID,
      statusCode: HttpStatusCodes.UNAUTHORIZED
    })
  })

  it('takes at least the floor to refuse a key, however far the lookup went', async () => {
    mockResolveInstallation.mockResolvedValue(FOUND)
    const timed = async (guard: PluginApiKeyGuard, token: string | undefined): Promise<number> => {
      const started = Date.now()
      await failureFor(guard, token)
      return Date.now() - started
    }

    const elapsed = await Promise.all([
      timed(build(null), undefined),
      timed(build(null), 'plg_live_made_up'),
      timed(build(installationRow('disabled')), 'plg_live_secret')
    ])

    // Timers may fire a millisecond early: the floor is judged with that slack
    for (const ms of elapsed) expect(ms).toBeGreaterThanOrEqual(PluginApiKeyRefusalFloorMs - 5)
  })
})
