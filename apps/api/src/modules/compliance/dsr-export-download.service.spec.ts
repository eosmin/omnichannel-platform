import type { PinoLogger } from 'nestjs-pino'

import type { AuditService } from '@platform/core/audit-module'
import { ComplianceConfig, type DsrConfig, sealDsrExportPassword } from '@platform/core/compliance'
import { CredentialCipher, hashToken } from '@platform/core/crypto'
import type { PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'
import { ExportContentTypes } from '@platform/core/exports'
import type { StorageService } from '@platform/core/storage-module'

import { DsrExportDownloadService } from './dsr-export-download.service'

// The arguments of a call of a mock, typed by the caller (`mock.calls` is `any` for a bare jest.fn)
const argOf = <T>(mock: jest.Mock, call: number, arg: number): T =>
  (mock.mock.calls as unknown[][])[call]?.[arg] as T

const TOKEN = 'D'.repeat(43)
const PASSWORD = 'zip-password-of-this-request-abcdef'
const cipher = new CredentialCipher(Buffer.alloc(32, 7))
const sealed = Buffer.from(sealDsrExportPassword(cipher, 'req-1', PASSWORD))
const REQUEST = {
  resultKey: 'compliance/dsr/req-1.zip',
  resultPasswordSealed: sealed,
  type: 'access'
}
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
  objectMissing?: boolean
  conflict?: boolean
  cipher?: CredentialCipher
}) {
  const findRequest = jest
    .fn()
    .mockResolvedValue(options.request === undefined ? REQUEST : options.request)
  const client = {
    // 1: the lookup of the request by the hash (no context yet); 2: the lock of the request; 3: the claim, which answers the hashes it spent
    $queryRaw: jest
      .fn()
      .mockResolvedValueOnce(options.found === undefined ? [FOUND] : options.found)
      .mockResolvedValueOnce([{ locked: 1 }])
      .mockResolvedValueOnce(
        (options.claimed ?? 1) === 1
          ? [{ token_hash: hashToken(TOKEN) }, { token_hash: 'sibling' }]
          : []
      ),
    dataSubjectRequest: { findFirst: findRequest }
  }
  const tenantTransaction = jest.fn(function (_context: unknown, work: () => Promise<unknown>) {
    return options.conflict === true
      ? Promise.reject(
          Object.assign(new Error('Transaction failed due to a write conflict or a deadlock'), {
            code: 'P2034'
          })
        )
      : work()
  })
  const prisma = { client, tenantTransaction } as unknown as PrismaService
  const log = jest.fn()
  const audit = { log } as unknown as AuditService
  const downloadUrl =
    options.signFails === true
      ? jest.fn().mockRejectedValue(new Error('storage down'))
      : jest.fn().mockResolvedValue(SIGNED)
  const head = jest
    .fn()
    .mockResolvedValue(options.objectMissing === true ? null : { contentLength: 10 })
  const storage = { downloadUrl, head } as unknown as StorageService
  const logged = jest.fn()
  const logger = {
    setContext: jest.fn(),
    error: logged,
    warn: logged,
    info: logged
  } as unknown as PinoLogger
  const service = new DsrExportDownloadService(
    prisma,
    audit,
    storage,
    options.cipher ?? cipher,
    { ...CONFIG, enabled: options.enabled ?? true },
    logger
  )
  return { service, client, findRequest, log, logged, tenantTransaction, downloadUrl, head }
}

const invalid = { code: ErrorCodes.DSR_EXPORT_LINK_INVALID }

describe('DsrExportDownloadService', () => {
  it('claims the token in the context of the request, signs a short link to its file and audits ids only', async () => {
    const { service, client, findRequest, downloadUrl, log, tenantTransaction } = build({})
    await expect(service.download({ token: TOKEN })).resolves.toEqual({
      url: SIGNED,
      filename: ComplianceConfig.DSR_EXPORT_FILENAME,
      expiresInSeconds: ComplianceConfig.DSR_EXPORT_DOWNLOAD_URL_SECONDS,
      password: PASSWORD
    })
    expect(tenantTransaction).toHaveBeenCalledWith(
      { storeIds: ['store-1'], organizationIds: ['org-1'] },
      expect.any(Function)
    )
    // The lock and the claim, in the context, with the hash of the token, the request and the kind of token as values (never the token itself)
    const calls = client.$queryRaw.mock.calls as unknown[][]
    expect(calls).toHaveLength(3)
    expect(calls[1]?.slice(1)).toEqual(['dsr-export-download:req-1'])
    expect(calls[2]?.slice(1)).toEqual(
      expect.arrayContaining([hashToken(TOKEN), 'req-1', 'dsr_export_download'])
    )
    expect(JSON.stringify(calls[2]?.slice(1))).not.toContain(TOKEN)
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
    expect(entry).not.toContain(PASSWORD)
    expect(entry).toContain('"system":true')
  })

  it('spends the links of the request in ONE statement decided by the token it was given, and a token that is not live spends nothing', async () => {
    const { service, client } = build({ claimed: 0 })
    await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
    const sql = (client.$queryRaw.mock.calls[2] as unknown[][])[0]?.join('?') ?? ''
    expect(sql).toContain('UPDATE verification_tokens')
    expect(sql).toContain('EXISTS')
    expect(sql).toContain('RETURNING token_hash')
  })

  it.each([
    ['Prisma P2034', { code: 'P2034' }],
    ['a deadlock of the driver', { cause: { originalCode: '40P01' } }]
  ])(
    'answers the uniform error, never another, when two calls collide (%s)',
    async (_name, shape) => {
      const { service, log, downloadUrl } = build({ conflict: true })
      const error = Object.assign(new Error('boom'), shape)
      // the mock rejects with P2034; this case also covers the other shapes by swapping the error
      const failing = build({ conflict: false })
      ;(failing.tenantTransaction as jest.Mock).mockRejectedValueOnce(error)
      await expect(failing.service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
      await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
      expect(log).not.toHaveBeenCalled()
      expect(downloadUrl).not.toHaveBeenCalled()
    }
  )

  it('asks the bucket BEFORE the claim and outside the transaction: a missing file spends nothing and takes no lock', async () => {
    const { service, client, tenantTransaction } = build({ objectMissing: true })
    await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
    // only the lookup of the request ran as raw SQL (no lock, no claim), and only the read of the request opened a context
    expect(client.$queryRaw).toHaveBeenCalledTimes(1)
    expect(tenantTransaction).toHaveBeenCalledTimes(1)
  })

  it('refuses a file that changed between the check of the bucket and the claim, and signs nothing', async () => {
    const { service, findRequest, downloadUrl, log } = build({})
    findRequest
      .mockReset()
      .mockResolvedValueOnce({ ...REQUEST, resultKey: 'compliance/dsr/old.zip' })
      .mockResolvedValueOnce({ ...REQUEST, resultKey: 'compliance/dsr/new.zip' })
    await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
    expect(downloadUrl).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it.each([
    ['the flow is off (nothing is looked up)', { enabled: false }],
    [
      'the token is unknown, used, expired or of another request (the lookup finds nothing)',
      { found: [] }
    ],
    ['the request has no file any more', { request: null }],
    ['the file has no key', { request: { ...REQUEST, resultKey: null } }],
    [
      'the export has no sealed password (made before the ZIP was encrypted)',
      { request: { ...REQUEST, resultPasswordSealed: null } }
    ]
  ])(
    'never asks the bucket when %s, so the bucket tells nothing about the token',
    async (_name, options) => {
      const { service, head } = build(options)
      await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
      expect(head).not.toHaveBeenCalled()
    }
  )

  it.each([
    ['the flow is off', { enabled: false }],
    ['the token is unknown, used or expired', { found: [] }],
    ['a second caller already claimed the token', { claimed: 0 }],
    ['the request has no file any more', { request: null }],
    ['the object is gone from the bucket', { objectMissing: true }],
    ['the file has no key', { request: { ...REQUEST, resultKey: null } }],
    ['the export has no sealed password', { request: { ...REQUEST, resultPasswordSealed: null } }]
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

  it('answers the uniform error, gives the token back and logs no password when the sealed password does not open', async () => {
    const wrongKey = new CredentialCipher(Buffer.alloc(32, 9))
    const { service, downloadUrl, log, logged } = build({ cipher: wrongKey })
    const failure = await service.download({ token: TOKEN }).catch((error: unknown) => error)
    expect(failure).toMatchObject(invalid)
    expect(downloadUrl).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
    const lines = JSON.stringify(logged.mock.calls)
    expect(lines).not.toContain(PASSWORD)
    expect(lines).not.toContain(TOKEN)
    expect(JSON.stringify(failure)).not.toContain(PASSWORD)
  })

  it('does not open the password of another request (the sealed value is bound to its request)', async () => {
    const other = Buffer.from(sealDsrExportPassword(cipher, 'req-2', PASSWORD))
    const { service } = build({ request: { ...REQUEST, resultPasswordSealed: other } })
    await expect(service.download({ token: TOKEN })).rejects.toMatchObject(invalid)
  })
})
