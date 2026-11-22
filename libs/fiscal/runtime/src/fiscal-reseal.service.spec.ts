import { randomBytes } from 'node:crypto'

import type { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'

import { FiscalResealService, type FiscalResealUnit } from './fiscal-reseal.service'

// The part of the re-seal that no honest database run reaches: a new value that does not open to the same content is never written, a write
// that finds the row changed is a conflict and not a loss, and a run without a previous key reads nothing.
describe('FiscalResealService (what the database run cannot show)', () => {
  const oldKey = randomBytes(32)
  const newKey = randomBytes(32)
  const logger = { setContext: () => undefined, error: () => undefined } as unknown as PinoLogger
  const unit: FiscalResealUnit = work => work()
  const audit = { log: jest.fn() }

  function prismaWith(sealed: Uint8Array, updated: number) {
    const updateMany = jest.fn().mockResolvedValue({ count: updated })
    const findMany = jest
      .fn()
      .mockImplementation((args: { where?: { id?: unknown } }) =>
        Promise.resolve(
          args.where?.id === undefined ? [{ id: 'row-1', dataEncrypted: sealed }] : []
        )
      )
    const empty = { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
    return {
      client: {
        customerFiscalData: { findMany, updateMany },
        fiscalDocument: empty,
        fiscalIssuer: empty,
        fiscalContingency: empty
      },
      updateMany,
      findMany
    }
  }

  beforeEach(() => audit.log.mockReset())

  it('writes nothing and counts a failure when the value sealed again does not open to the same content', async () => {
    const sealedOld = new CredentialCipher(oldKey).seal({ taxId: 'T-1' })
    const prisma = prismaWith(new Uint8Array(sealedOld), 1)
    class Faulty extends CredentialCipher {
      override open(sealed: Uint8Array): Record<string, unknown> {
        const real = super.open(sealed)
        return { ...real, taxId: 'changed' }
      }
    }
    const service = new FiscalResealService(
      prisma as never,
      new Faulty(newKey, oldKey),
      audit as never,
      logger
    )

    const report = await service.run('org-1', unit)

    expect(prisma.updateMany).not.toHaveBeenCalled()
    expect(report.resealed).toBe(0)
    expect(Object.values(report.failed).reduce((a, b) => a + b, 0)).toBe(1)
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('counts a conflict, writes no entry and loses nothing when the row changed meanwhile', async () => {
    const sealedOld = new CredentialCipher(oldKey).seal({ taxId: 'T-1' })
    const prisma = prismaWith(new Uint8Array(sealedOld), 0)
    const service = new FiscalResealService(
      prisma as never,
      new CredentialCipher(newKey, oldKey),
      audit as never,
      logger
    )

    const report = await service.run('org-1', unit)

    expect(report).toMatchObject({ resealed: 0, conflicts: 1, failed: {} })
    expect(audit.log).not.toHaveBeenCalled()
    // The swap named the old bytes, so a row that moved is not overwritten
    const calls = prisma.updateMany.mock.calls as [
      { where: { dataEncrypted: Uint8Array; store: unknown } }
    ][]
    const where = calls[0]?.[0].where as { dataEncrypted: Uint8Array; store: unknown }
    expect(Buffer.from(where.dataEncrypted).equals(Buffer.from(sealedOld))).toBe(true)
    expect(where.store).toEqual({ organizationId: 'org-1' })
  })

  it('reads nothing at all without a previous key', async () => {
    const prisma = prismaWith(new Uint8Array(), 1)
    const service = new FiscalResealService(
      prisma as never,
      new CredentialCipher(newKey),
      audit as never,
      logger
    )
    const report = await service.run('org-1', unit)
    expect(report.enabled).toBe(false)
    expect(prisma.findMany).not.toHaveBeenCalled()
  })
})
