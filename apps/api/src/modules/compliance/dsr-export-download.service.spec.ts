import type { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig, type DsrConfig } from '@platform/core/compliance'
import { hashToken } from '@platform/core/crypto'
import type { PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'
import { ExportContentTypes } from '@platform/core/exports'
import type { StorageService } from '@platform/core/storage-module'

import { DsrExportDownloadService } from './dsr-export-download.service'

// The arguments of a call of a mock, typed by the caller (`mock.calls` is `any` for a bare jest.fn)
const argOf = <T>(mock: jest.Mock, call: number, arg: number): T =>
  (mock.mock.calls as unknown[][])[call]?.[arg] as T

const TOKEN = 'D'.repeat(43)
const SIGNED = 'https://bucket.test/signed?sig=abc'
const CONFIG: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}
const FOUND = { id: 'req-1', store_id: 'store-1', organization_id: 'org-1' }

function build(options: {
  found?: unknown
  claimed?: number
  request?: unknown
  enabled?: boolean
  signFails?: boolean
}) {
  const updateToken = jest.fn().mockResolvedValue({ count: options.claimed ?? 1 })
  const findRequest = jest
    .fn()
    .mockResolvedValue(
      options.request === undefined
        ? { resultKey: 'compliance/dsr/req-1.zip', type: 'access' }
        : options.request
    )
  const client = {
    $queryRaw: jest.fn().mockResolvedValue(options.found === undefined ? [FOUND] : options.found),
    verificationToken: { updateMany: updateToken },
    dataSubjectRequest: { findFirst: findRequest }
  }
  const tenantTransaction = jest.fn(function (_context: unknown, work: () => Promise<unknown>) {
    return work()
  })
  const prisma = { client, tenantTransaction } as unknown as PrismaService
  const log = jest.fn()
  const audit = { log } as unknown as AuditService
  const downloadUrl =
    options.signFails === true
      ? jest.fn().mockRejectedValue(new Error('storage down'))
      : jest.fn().mockResolvedValue(SIGNED)
  const storage = { downloadUrl } as unknown as StorageService
  const service = new DsrExportDownloadService(prisma, audit, storage, {
    ...CONFIG,
    enabled: options.enabled ?? true
  })
  return { service, client, updateToken, findRequest, log, tenantTransaction, downloadUrl }
}

const invalid = { code: ErrorCodes.DSR_EXPORT_LINK_INVALID }

describe('DsrExportDownloadService', () => {
  it('claims the token in the context of the request, signs a short link to its file and audits ids only', async () => {
    const { service, updateToken, findRequest, downloadUrl, log, tenantTransaction } = build({})
    await expect(service.download({ token: TOKEN })).resolves.toEqual({
      url: SIGNED,
      filename: ComplianceConfig.DSR_EXPORT_FILENAME,
      expiresInSeconds: ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS
    })
    expect(tenantTransaction).toHaveBeenCalledWith(
      { storeIds: ['store-1'], organizationIds: ['org-1'] },
      expect.any(Function)
    )
    expect(argOf<{ where: unknown }>(updateToken, 0, 0).where).toMatchObject({
      tokenHash: hashToken(TOKEN),
      type: 'dsr_export_download',
      subject: 'req-1',
      usedAt: null
    })
    expect(argOf<{ where: unknown }>(findRequest, 0, 0).where).toMatchObject({
      id: 'req-1',
      storeId: 'store-1',
      status: 'completed'
    })
    expect(argOf<unknown>(downloadUrl, 0, 0)).toEqual({
      key: 'compliance/dsr/req-1.zip',
      contentType: ExportContentTypes.ZIP,
      filename: ComplianceConfig.DSR_EXPORT_FILENAME,
      expiresInSeconds: ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS
    })
    expect(log).toHaveBeenCalledTimes(1)
    const entry = JSON.stringify(argOf<unknown>(log, 0, 0))
    expect(entry).not.toContain(TOKEN)
    expect(entry).not.toContain(SIGNED)
    expect(entry).toContain('"system":true')
  })

  it.each([
    ['the flow is off', { enabled: false }],
    ['the token is unknown, used or expired', { found: [] }],
    ['a second caller already claimed the token', { claimed: 0 }],
    ['the request has no file any more', { request: null }],
    ['the file has no key', { request: { resultKey: null, type: 'access' } }]
  ])(
    'answers the one uniform error when %s, signs nothing and audits nothing',
    async (_name, options) => {
      const { service, log, downloadUrl } = build(options)
      await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
      expect(downloadUrl).not.toHaveBeenCalled()
      expect(log).not.toHaveBeenCalled()
    }
  )

  it('does not even look the token up when the flow is off', async () => {
    const { service, client } = build({ enabled: false })
    await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
    expect(client.$queryRaw).not.toHaveBeenCalled()
  })

  it('lets the failure of the storage rise inside the transaction, so the claim is given back, and audits nothing', async () => {
    const { service, log } = build({ signFails: true })
    await expect(service.download({ token: TOKEN })).rejects.toThrow('storage down')
    expect(log).not.toHaveBeenCalled()
  })
})
