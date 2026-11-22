import type { AuditService } from '@platform/core/audit-module'
import type { DsrConfig } from '@platform/core/compliance'
import { hashToken } from '@platform/core/crypto'
import type { PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'

import { DsrVerifyService } from './dsr-verify.service'

// The arguments of a call of a mock, typed by the caller (`mock.calls` is `any` for a bare jest.fn)
const argOf = <T>(mock: jest.Mock, call: number, arg: number): T =>
  (mock.mock.calls as unknown[][])[call]?.[arg] as T

const TOKEN = 'T'.repeat(43)
const CONFIG: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}
const FOUND = { id: 'req-1', store_id: 'store-1', organization_id: 'org-1' }

function build(options: { found?: unknown; claimed?: number; moved?: number; enabled?: boolean }) {
  const updateToken = jest.fn().mockResolvedValue({ count: options.claimed ?? 1 })
  const updateRequest = jest.fn().mockResolvedValue({ count: options.moved ?? 1 })
  const client = {
    $queryRaw: jest.fn().mockResolvedValue(options.found === undefined ? [FOUND] : options.found),
    verificationToken: { updateMany: updateToken },
    dataSubjectRequest: { updateMany: updateRequest }
  }
  const tenantTransaction = jest.fn(function (_context: unknown, work: () => Promise<unknown>) {
    return work()
  })
  const prisma = { client, tenantTransaction } as unknown as PrismaService
  const log = jest.fn()
  const audit = { log } as unknown as AuditService
  const service = new DsrVerifyService(prisma, audit, {
    ...CONFIG,
    enabled: options.enabled ?? true
  })
  return { service, client, updateToken, updateRequest, log, tenantTransaction }
}

const invalid = { code: ErrorCodes.DSR_VERIFICATION_INVALID }

describe('DsrVerifyService', () => {
  it('claims the token and moves the request to manual review in one context, then audits ids only', async () => {
    const { service, updateToken, updateRequest, log, tenantTransaction } = build({})
    await expect(service.verify({ token: TOKEN })).resolves.toEqual({ verified: true })
    expect(tenantTransaction).toHaveBeenCalledWith(
      { storeIds: ['store-1'], organizationIds: ['org-1'] },
      expect.any(Function)
    )
    expect(argOf<{ where: unknown }>(updateToken, 0, 0).where).toMatchObject({
      tokenHash: hashToken(TOKEN),
      usedAt: null
    })
    expect(argOf<unknown>(updateRequest, 0, 0)).toMatchObject({
      where: { id: 'req-1', storeId: 'store-1', status: 'pending_verification' },
      data: { status: 'manual_review' }
    })
    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(argOf<unknown>(log, 0, 0))).not.toContain(TOKEN)
  })

  it.each([
    ['the flow is off', { enabled: false }],
    ['the token is unknown, used or expired', { found: [] }],
    ['a second caller already claimed the token', { claimed: 0 }],
    ['the request no longer waits', { moved: 0 }]
  ])('answers the one uniform error when %s, and audits nothing', async (_name, options) => {
    const { service, log } = build(options)
    await expect(service.verify({ token: TOKEN })).rejects.toMatchObject(invalid)
    expect(log).not.toHaveBeenCalled()
  })

  it('does not even look the token up when the flow is off', async () => {
    const { service, client } = build({ enabled: false })
    await expect(service.verify({ token: TOKEN })).rejects.toMatchObject(invalid)
    expect(client.$queryRaw).not.toHaveBeenCalled()
  })
})
