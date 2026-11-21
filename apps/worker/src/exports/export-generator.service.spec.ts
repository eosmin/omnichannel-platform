import { UnrecoverableError } from 'bullmq'

import { Permissions } from '@platform/core/auth'
import { ErrorCodes } from '@platform/core/errors'
import { ExportStatus, ExportTypes } from '@platform/core/queues'

import { ExportGenerator } from './export-generator.service'

const STORE = '0b8e7a52-6d1f-4a63-8c4e-2f9d3b7a1e55'
const USER = '6f1c2b7e-3c1a-4d57-9a38-0d5f7a6b1c11'
const EXPORT = '9d3b7a1e-55aa-4c63-8c4e-2f9d3b7a1e01'

const row = {
  id: EXPORT,
  storeId: STORE,
  requestedBy: USER,
  type: ExportTypes.CUSTOMERS,
  format: 'csv',
  filters: {},
  status: ExportStatus.PENDING
}

// The update that turns the row ready, and the one that fails it for the permission (`expect` matchers are typed any)
const like = (value: object): unknown => expect.objectContaining(value)
const IS_READY = like({ data: like({ status: ExportStatus.READY }) })
const IS_DENIED = like({
  data: like({ status: ExportStatus.FAILED, error: ErrorCodes.PERMISSION_DENIED })
})

function membershipOf(...names: string[]): unknown {
  return { role: { permissions: names.map(name => ({ name })) } }
}

// The generator with every collaborator faked: `reads` are the answers of the membership, one for each time the permissions of the
// requester are read (before the file is written, and again before the row turns ready)
function build(reads: unknown[], write: () => Promise<{ rowCount: number }>) {
  const membership = { findFirst: jest.fn() }
  for (const read of reads) membership.findFirst.mockResolvedValueOnce(read)
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const prisma = {
    client: {
      export: { findFirst: jest.fn().mockResolvedValue(row), updateMany },
      membership,
      pluginInstallation: { findFirst: jest.fn() }
    },
    transaction: jest.fn((work: (tx: unknown) => unknown) => Promise.resolve(work({})))
  }
  const storage = { delete: jest.fn().mockResolvedValue(undefined) }
  const audit = { log: jest.fn() }
  const events = { publish: jest.fn() }
  const logger = { setContext: jest.fn(), error: jest.fn(), warn: jest.fn() }
  const jobContext = { forStore: jest.fn((_id: string, work: () => unknown) => work()) }
  const subjectMissing = { inc: jest.fn() }
  const generator = new ExportGenerator(
    prisma as never,
    { write: jest.fn(write) } as never,
    {} as never,
    {} as never,
    storage as never,
    audit as never,
    events as never,
    logger as never,
    jobContext as never,
    subjectMissing as never
  )
  return { generator, updateMany, storage, audit, events, membership, logger }
}

describe('the permissions of the requester when the file of an export is finished', () => {
  it('turns the row ready when the requester still holds the permissions after the file is written', async () => {
    const t = build(
      [membershipOf(Permissions.CUSTOMERS_EXPORT), membershipOf(Permissions.CUSTOMERS_EXPORT)],
      () => Promise.resolve({ rowCount: 3 })
    )
    await t.generator.generate(STORE, EXPORT, false)
    expect(t.updateMany).toHaveBeenCalledWith(IS_READY)
    expect(t.storage.delete).not.toHaveBeenCalled()
  })

  it('does not turn the row ready, and deletes the file, when the permission was revoked while the file was written', async () => {
    const t = build([membershipOf(Permissions.CUSTOMERS_EXPORT), null], () =>
      Promise.resolve({ rowCount: 3 })
    )
    await expect(t.generator.generate(STORE, EXPORT, false)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(t.updateMany).not.toHaveBeenCalledWith(IS_READY)
    expect(t.updateMany).toHaveBeenCalledWith(IS_DENIED)
    expect(t.storage.delete).toHaveBeenCalledTimes(1)
    expect(t.audit.log).not.toHaveBeenCalled()
  })

  it('refuses when the second read finds a role without the permission of the kind', async () => {
    const t = build([membershipOf(Permissions.CUSTOMERS_EXPORT), membershipOf()], () =>
      Promise.resolve({ rowCount: 1 })
    )
    await expect(t.generator.generate(STORE, EXPORT, false)).rejects.toBeInstanceOf(
      UnrecoverableError
    )
    expect(t.storage.delete).toHaveBeenCalledTimes(1)
  })

  it('refuses, fails closed, when the second read cannot be made on the last attempt', async () => {
    const t = build([membershipOf(Permissions.CUSTOMERS_EXPORT)], () =>
      Promise.resolve({ rowCount: 1 })
    )
    t.membership.findFirst.mockRejectedValueOnce(new Error('database down'))
    await expect(t.generator.generate(STORE, EXPORT, true)).rejects.toThrow('database down')
    expect(t.updateMany).not.toHaveBeenCalledWith(IS_READY)
    expect(t.storage.delete).toHaveBeenCalledTimes(1)
  })

  it('does not put the id of the person in the log of the refusal', async () => {
    const t = build([membershipOf(Permissions.CUSTOMERS_EXPORT), null], () =>
      Promise.resolve({ rowCount: 1 })
    )
    await t.generator.generate(STORE, EXPORT, false).catch(() => undefined)
    expect(JSON.stringify(t.logger.warn.mock.calls)).not.toContain(USER)
  })
})
