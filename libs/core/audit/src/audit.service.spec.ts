import type { Counter } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import type { PrismaService } from '@platform/core/database'

import { AuditService, toRow } from './audit.service'

const USER_ID = '0b5f3f0e-6c36-4a4f-9d16-5b1d1c2f7a10'
const STORE_ID = '7c1e9a52-3d4b-4f6a-8b1c-2e5d7f9a0b34'

type Create = jest.Mock<Promise<object>, [{ data: Record<string, unknown> }]>
const createMock = (impl: () => Promise<object>): Create =>
  jest.fn<Promise<object>, [{ data: Record<string, unknown> }]>(impl)

interface Harness {
  service: AuditService
  create: Create
  error: jest.Mock
  inc: jest.Mock
}

function build(create: Create = createMock(() => Promise.resolve({}))): Harness {
  const error = jest.fn()
  const inc = jest.fn()
  const service = new AuditService(
    { client: { auditLog: { create } } } as unknown as PrismaService,
    { setContext: jest.fn(), error } as unknown as PinoLogger,
    { inc } as unknown as Counter<string>
  )
  return { service, create, error, inc }
}

describe('toRow', () => {
  it('keeps the actor, the scope and the resource as columns', () => {
    const row = toRow({
      action: AuditAction.CUSTOMER_VIEWED,
      actor: { userId: USER_ID },
      storeId: STORE_ID,
      organizationId: 'org',
      resourceType: 'customer',
      resourceId: 'c1',
      ipAddress: '203.0.113.9',
      userAgent: 'Firefox',
      metadata: { reason: 'support' }
    })

    expect(row).toEqual({
      action: 'customer.viewed',
      userId: USER_ID,
      storeId: STORE_ID,
      organizationId: 'org',
      resourceType: 'customer',
      resourceId: 'c1',
      ipAddress: '203.0.113.9',
      userAgent: 'Firefox',
      metadata: { reason: 'support' }
    })
  })

  it('writes a system action with no user, and nulls for what was not given', () => {
    const row = toRow({ action: AuditAction.ORGANIZATION_CREATED, actor: { system: true } })

    expect(row).toMatchObject({
      userId: null,
      storeId: null,
      organizationId: null,
      resourceType: null,
      resourceId: null,
      ipAddress: null,
      userAgent: null
    })
    expect(row.metadata).toBeUndefined()
  })

  it('cuts the fields a caller controls to the size of their columns', () => {
    const row = toRow({
      action: AuditAction.CUSTOMER_VIEWED,
      actor: { system: true },
      resourceType: 't'.repeat(500),
      resourceId: 'i'.repeat(500),
      ipAddress: '1'.repeat(500),
      userAgent: 'u'.repeat(500)
    })

    expect(row.resourceType).toHaveLength(64)
    expect(row.resourceId).toHaveLength(255)
    expect(row.ipAddress).toHaveLength(45)
    expect(row.userAgent).toHaveLength(255)
  })

  it('replaces metadata that is too big with a note, instead of growing the row', () => {
    const row = toRow({
      action: AuditAction.SETTINGS_CHANGED,
      actor: { system: true },
      metadata: { blob: 'x'.repeat(20_000) }
    })

    const note = row.metadata as { truncated: boolean; bytes: number }
    expect(note.truncated).toBe(true)
    expect(note.bytes).toBeGreaterThan(20_000)
    expect(Object.keys(note).sort()).toEqual(['bytes', 'truncated'])
  })

  it('replaces metadata that cannot be serialized with a note, instead of failing', () => {
    const cycle: Record<string, unknown> = {}
    cycle['self'] = cycle

    expect(
      toRow({ action: AuditAction.SETTINGS_CHANGED, actor: { system: true }, metadata: cycle })
        .metadata
    ).toEqual({ unserializable: true })
    expect(
      toRow({
        action: AuditAction.SETTINGS_CHANGED,
        actor: { system: true },
        metadata: { n: BigInt(1) }
      }).metadata
    ).toEqual({ unserializable: true })
  })
})

describe('AuditService', () => {
  it('writes the entry without making the caller wait for it', async () => {
    const { service, create } = build()

    const result = service.log({ action: AuditAction.USER_LOGOUT, actor: { userId: USER_ID } })
    await service.onModuleDestroy()

    expect(result).toBeUndefined() // log() is not async: nothing to await
    expect(create).toHaveBeenCalledTimes(1)
    expect(create.mock.calls[0]?.[0].data).toMatchObject({
      action: 'user.logout',
      userId: USER_ID
    })
  })

  it('never throws at the caller when the write fails, and logs and counts it', async () => {
    const { service, error, inc } = build(createMock(() => Promise.reject(new Error('db down'))))

    expect(() =>
      service.log({ action: AuditAction.USER_LOGOUT, actor: { userId: USER_ID } })
    ).not.toThrow()
    await service.onModuleDestroy()

    expect(inc).toHaveBeenCalledWith({ reason: 'write_failed' })
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'user.logout', reason: 'write_failed', err: 'db down' }),
      expect.stringContaining('could not be written')
    )
  })

  it('works without the counter (a process with no metrics module)', async () => {
    const service = new AuditService(
      {
        client: { auditLog: { create: () => Promise.reject(new Error('x')) } }
      } as unknown as PrismaService,
      { setContext: jest.fn(), error: jest.fn() } as unknown as PinoLogger
    )

    service.log({ action: AuditAction.USER_LOGOUT, actor: { system: true } })

    await expect(service.onModuleDestroy()).resolves.toBeUndefined()
  })

  it('waits for the writes in flight when the process stops', async () => {
    let finish: () => void = () => undefined
    const create = createMock(
      () =>
        new Promise<object>(resolve => {
          finish = () => resolve({})
        })
    )
    const { service } = build(create)
    service.log({ action: AuditAction.USER_LOGOUT, actor: { system: true } })

    let stopped = false
    const stopping = service.onModuleDestroy().then(() => {
      stopped = true
    })
    await new Promise(resolve => setImmediate(resolve))
    expect(stopped).toBe(false) // Still waiting for the write

    finish()
    await stopping
    expect(stopped).toBe(true)
  })

  it('refuses entries past the limit of writes waiting, counting and logging each one', () => {
    const { service, create, error, inc } = build(
      createMock(() => new Promise<object>(() => undefined))
    )

    for (let i = 0; i < 1000; i += 1) {
      service.log({ action: AuditAction.USER_LOGOUT, actor: { system: true } })
    }
    service.log({ action: AuditAction.USER_LOGOUT, actor: { system: true } })

    expect(create).toHaveBeenCalledTimes(1000)
    expect(inc).toHaveBeenCalledWith({ reason: 'queue_full' })
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'queue_full' }),
      expect.any(String)
    )
  })
})
