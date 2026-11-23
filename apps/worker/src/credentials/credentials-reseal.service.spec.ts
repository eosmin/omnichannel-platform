import { randomBytes } from 'node:crypto'

import type { PinoLogger } from 'nestjs-pino'

import { CredentialCipher, DecryptionFailure, SealedWith } from '@platform/core/crypto'
import {
  CREDENTIALS_RESEAL_MISMATCH,
  CredentialsReseal,
  SealedTargetIds
} from '@platform/core/domain'

import { CredentialsResealService, type CredentialsResealUnit } from './credentials-reseal.service'

// The part of the re-seal that no honest database run reaches (the run against the database is tests/api/credentials-reseal.spec.ts): a new
// value that does not open to the same content is never written, a write that finds the row changed is a conflict and not a loss, a run
// without a previous key reads nothing, and a run stops at the cap and the next one goes on.
describe('CredentialsResealService (what the database run cannot show)', () => {
  const oldKey = randomBytes(32)
  const newKey = randomBytes(32)
  const logger = { setContext: () => undefined, error: () => undefined } as unknown as PinoLogger
  const unit: CredentialsResealUnit = work => work()
  const audit = { log: jest.fn() }

  // Only the table of the webhooks holds rows; every other target reads nothing
  function prismaWith(rows: { id: string; secret: Uint8Array<ArrayBuffer> }[], swapped: number) {
    const updateMany = jest.fn().mockResolvedValue({ count: swapped })
    const findMany = jest.fn().mockImplementation((args: { where?: { id?: { gt: string } } }) => {
      const gt = args.where?.id?.gt
      return Promise.resolve(
        rows.filter(r => gt === undefined || r.id > gt).slice(0, CredentialsReseal.PAGE_SIZE)
      )
    })
    const empty = { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
    return {
      client: {
        webhook: { findMany, updateMany },
        channelConnection: empty,
        carrierConnection: empty,
        pluginInstallation: empty,
        invitation: empty,
        dataSubjectRequest: empty
      },
      updateMany,
      findMany,
      empty
    }
  }
  const make = (prisma: unknown, cipher: CredentialCipher): CredentialsResealService =>
    new CredentialsResealService(prisma as never, cipher, audit as never, logger)

  beforeEach(() => audit.log.mockReset())

  it('declares exactly the closed list of sealed columns', () => {
    const service = make(prismaWith([], 1), new CredentialCipher(newKey))
    expect([...service.targetIds].sort()).toEqual(Object.values(SealedTargetIds).sort())
  })

  it('writes nothing and counts a failure when the value sealed again does not open to the same content', async () => {
    const sealed = new Uint8Array(new CredentialCipher(oldKey).seal({ secret: 's-1' }))
    const prisma = prismaWith([{ id: 'w-1', secret: sealed }], 1)
    class Faulty extends CredentialCipher {
      override open(value: Uint8Array, aad?: string): Record<string, unknown> {
        return { ...super.open(value, aad), secret: 'changed' }
      }
    }

    const report = await make(prisma, new Faulty(newKey, oldKey)).run('org-1', unit)

    expect(prisma.updateMany).not.toHaveBeenCalled()
    expect(report.resealed).toBe(0)
    expect(report.failed).toEqual({ [CREDENTIALS_RESEAL_MISMATCH]: 1 })
    expect(audit.log).not.toHaveBeenCalled()
  })

  it('counts a conflict, audits nothing and loses nothing when the row changed meanwhile, and names the old bytes and the organization in the swap', async () => {
    const sealed = new Uint8Array(new CredentialCipher(oldKey).seal({ secret: 's-1' }))
    const prisma = prismaWith([{ id: 'w-1', secret: sealed }], 0)

    const report = await make(prisma, new CredentialCipher(newKey, oldKey)).run('org-1', unit)

    expect(report).toMatchObject({ resealed: 0, conflicts: 1, failed: {} })
    expect(audit.log).not.toHaveBeenCalled()
    const where = (prisma.updateMany.mock.calls[0] as [{ where: Record<string, unknown> }])[0].where
    expect(Buffer.from(where['secret'] as Uint8Array).equals(Buffer.from(sealed))).toBe(true)
    expect(where['store']).toEqual({ organizationId: 'org-1' })
  })

  it('reads nothing at all without a previous key (fails closed)', async () => {
    const prisma = prismaWith([{ id: 'w-1', secret: new Uint8Array() }], 1)
    const service = make(prisma, new CredentialCipher(newKey))
    expect(service.enabled).toBe(false)
    const report = await service.run('org-1', unit)
    expect(report).toMatchObject({ enabled: false, scanned: 0 })
    expect(prisma.findMany).not.toHaveBeenCalled()
    expect(prisma.empty.findMany).not.toHaveBeenCalled()
  })

  it('stops at the cap, says truncated, and a second run goes on and ends clean', async () => {
    const old = new CredentialCipher(oldKey)
    const cipher = new CredentialCipher(newKey, oldKey)
    const total = CredentialsReseal.MAX_VALUES_PER_TARGET + 1
    const rows = Array.from({ length: total }, (_, i) => ({
      id: `w-${String(i).padStart(6, '0')}`,
      secret: new Uint8Array(old.seal({ secret: `s-${i}` }))
    }))
    const prisma = prismaWith(rows, 1)
    // The swap of a row changes what the next read returns
    prisma.updateMany.mockImplementation(
      (args: { where: { id: string }; data: { secret: Uint8Array<ArrayBuffer> } }) => {
        const row = rows.find(r => r.id === args.where.id)
        if (row !== undefined) row.secret = args.data.secret
        return Promise.resolve({ count: 1 })
      }
    )
    const service = make(prisma, cipher)

    const first = await service.run('org-1', unit)
    expect(first.truncated).toBe(true)
    expect(first.resealed).toBe(CredentialsReseal.MAX_VALUES_PER_TARGET)

    const second = await service.run('org-1', unit)
    expect(second.truncated).toBe(false)
    expect(second.resealed).toBe(1)
    expect(second.current).toBe(CredentialsReseal.MAX_VALUES_PER_TARGET)
  })

  it('a target that hit its cap does not stop the targets after it: the next one is read past its first page', async () => {
    const old = new CredentialCipher(oldKey)
    const cipher = new CredentialCipher(newKey, oldKey)
    const mk = (prefix: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `${prefix}-${String(i).padStart(6, '0')}`,
        secret: new Uint8Array(old.seal({ secret: `s-${i}` }))
      }))
    // The webhooks come before the installations of the plugins in the list of targets
    const webhooks = mk('w', CredentialsReseal.MAX_VALUES_PER_TARGET + 1)
    const installs = mk('p', CredentialsReseal.PAGE_SIZE * 2 + 5)
    const after = (gt: string | undefined) => (r: { id: string }) => gt === undefined || r.id > gt
    const prisma = {
      client: {
        webhook: {
          findMany: jest.fn((a: { where?: { id?: { gt: string } } }) =>
            Promise.resolve(
              webhooks.filter(after(a.where?.id?.gt)).slice(0, CredentialsReseal.PAGE_SIZE)
            )
          ),
          updateMany: jest.fn(
            (a: { where: { id: string }; data: { secret: Uint8Array<ArrayBuffer> } }) => {
              const row = webhooks.find(r => r.id === a.where.id)
              if (row !== undefined) row.secret = a.data.secret
              return Promise.resolve({ count: 1 })
            }
          )
        },
        pluginInstallation: {
          findMany: jest.fn((a: { where?: { id?: { gt: string } } }) =>
            Promise.resolve(
              installs
                .filter(after(a.where?.id?.gt))
                .slice(0, CredentialsReseal.PAGE_SIZE)
                .map(r => ({
                  id: r.id,
                  webhookSecret: r.secret,
                  commandSecret: null,
                  commandSecretPrevious: null
                }))
            )
          ),
          updateMany: jest.fn(
            (a: { where: { id: string }; data: { webhookSecret?: Uint8Array<ArrayBuffer> } }) => {
              const row = installs.find(r => r.id === a.where.id)
              if (row !== undefined && a.data.webhookSecret !== undefined) {
                row.secret = a.data.webhookSecret
              }
              return Promise.resolve({ count: 1 })
            }
          )
        },
        channelConnection: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
        carrierConnection: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
        invitation: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
        dataSubjectRequest: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() }
      }
    }

    const report = await make(prisma, cipher).run('org-1', unit)

    expect(report.truncated).toBe(true)
    // The installations (after the capped webhooks) were sealed again in full, past their first page
    expect(
      installs.every(r => cipher.openRotating(r.secret).sealedWith === SealedWith.CURRENT)
    ).toBe(true)
    expect(report.resealed).toBe(CredentialsReseal.MAX_VALUES_PER_TARGET + installs.length)
  })

  it('values that never open do not starve the good rows behind them, and the log names only the first failures', async () => {
    const old = new CredentialCipher(oldKey)
    const cipher = new CredentialCipher(newKey, oldKey)
    const stranger = new CredentialCipher(randomBytes(32))
    // More rows that never open than the cap of writes, all BEFORE the good ones in id order
    const bad = Array.from({ length: CredentialsReseal.MAX_VALUES_PER_TARGET + 20 }, (_, i) => ({
      id: `a-${String(i).padStart(6, '0')}`,
      secret: new Uint8Array(stranger.seal({ secret: 'x' }))
    }))
    const good = Array.from({ length: 3 }, (_, i) => ({
      id: `b-${i}`,
      secret: new Uint8Array(old.seal({ secret: `g-${i}` }))
    }))
    const rows = [...bad, ...good]
    const prisma = prismaWith(rows, 1)
    prisma.updateMany.mockImplementation(
      (args: { where: { id: string }; data: { secret: Uint8Array<ArrayBuffer> } }) => {
        const row = rows.find(r => r.id === args.where.id)
        if (row !== undefined) row.secret = args.data.secret
        return Promise.resolve({ count: 1 })
      }
    )
    const errors = jest.fn()
    const noisy = { setContext: () => undefined, error: errors } as unknown as PinoLogger

    const report = await new CredentialsResealService(
      prisma as never,
      cipher,
      audit as never,
      noisy
    ).run('org-1', unit)

    expect(report.resealed).toBe(3)
    expect(report.failed).toEqual({ [DecryptionFailure.KEY_MISMATCH]: bad.length })
    expect(report.truncated).toBe(false)
    // The first lines name the rows; one more says how many were left out
    expect(errors).toHaveBeenCalledTimes(CredentialsReseal.MAX_LOGGED_FAILURES + 1)
  })
})
