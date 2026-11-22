import type { Queue } from 'bullmq'
import type { PinoLogger } from 'nestjs-pino'

import type { AuditService } from '@platform/core/audit-module'
import { type DsrConfig, sealDsrIntake } from '@platform/core/compliance'
import type { JobContext, PrismaService } from '@platform/core/database'
import type { DigestLinks } from '@platform/core/notifications'
import type { SendEmailJob } from '@platform/core/queues'

import { DsrIntakeWorker } from './dsr-intake.worker'

// The arguments of a call of a mock, typed by the caller (`mock.calls` is `any` for a bare jest.fn)
const argOf = <T>(mock: jest.Mock, call: number, arg: number): T =>
  (mock.mock.calls as unknown[][])[call]?.[arg] as T

const CONFIG: DsrConfig = {
  enabled: true,
  hashKey: 'h'.repeat(64),
  encryptionKeyHex: 'a'.repeat(64)
}
const LINKS: DigestLinks = { frontendUrl: 'https://app.example.com' }
const STORE = { id: 's', store_id: 'store-1', organization_id: 'org-1' }
const intake = {
  storeKey: 'k'.repeat(24),
  type: 'access' as const,
  email: ' Ana@Example.com ',
  locale: 'es' as const
}

function build(options: {
  enabled?: boolean
  store?: unknown[]
  customers?: unknown[]
  open?: number
  mailFails?: boolean
}) {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 })
  const create = jest.fn().mockResolvedValue({ id: 'req-1' })
  const createToken = jest.fn().mockResolvedValue({})
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue(options.customers ?? [{ id: 'c1' }]),
    dataSubjectRequest: { count: jest.fn().mockResolvedValue(options.open ?? 0), create },
    verificationToken: { create: createToken }
  }
  const prisma = {
    client: {
      $queryRaw: jest.fn().mockResolvedValue(options.store ?? [STORE]),
      dataSubjectRequest: { updateMany }
    },
    transaction: jest.fn((work: (t: typeof tx) => Promise<unknown>) => work(tx))
  } as unknown as PrismaService
  const jobContext = {
    forStore: jest.fn((_id: string, work: () => Promise<unknown>) => work())
  } as unknown as JobContext
  const log = jest.fn()
  const add =
    options.mailFails === true
      ? jest.fn().mockRejectedValue(new Error('redis down'))
      : jest.fn().mockResolvedValue(undefined)
  const worker = new DsrIntakeWorker(
    prisma,
    jobContext,
    { log } as unknown as AuditService,
    { add } as unknown as Queue<SendEmailJob>,
    LINKS,
    { ...CONFIG, enabled: options.enabled ?? true },
    { setContext: jest.fn(), info: jest.fn() } as unknown as PinoLogger
  )
  return { worker, tx, create, createToken, log, add, updateMany }
}

const sealed = (): string => sealDsrIntake(intake, CONFIG.encryptionKeyHex)

describe('DsrIntakeWorker', () => {
  it('writes the request with the address hashed and sealed, a token with only its hash, and queues the mail once', async () => {
    const { worker, create, createToken, add, log } = build({})
    await expect(worker.handle(sealed())).resolves.toBe('created')
    const data = argOf<{ data: Record<string, unknown> }>(create, 0, 0).data
    expect(data).toMatchObject({
      storeId: 'store-1',
      organizationId: 'org-1',
      status: 'pending_verification',
      subjectCustomerIds: ['c1']
    })
    expect(JSON.stringify(data)).not.toContain('example.com')
    expect(data).not.toHaveProperty('subjectEmail')
    expect(Buffer.isBuffer(data.notifyToEncrypted)).toBe(true)
    const token = argOf<{ data: { tokenHash: string; subject: string } }>(createToken, 0, 0).data
    expect(token.subject).toBe('req-1')
    const mail = argOf<SendEmailJob & { data: { url: string } }>(add, 0, 1)
    expect(add).toHaveBeenCalledTimes(1)
    expect(mail.to).toBe('ana@example.com')
    const raw = new URL(mail.data.url).hash.replace('#token=', '')
    expect(raw).toHaveLength(43)
    expect(JSON.stringify(token)).not.toContain(raw)
    expect(JSON.stringify(log.mock.calls as unknown[][])).not.toContain('example.com')
  })

  it.each([
    ['the flow is off', { enabled: false }, 'dropped'],
    ['no store has the key', { store: [] }, 'dropped'],
    ['the address belongs to no customer', { customers: [] }, 'no_customer'],
    ['the person already has this kind of request open', { open: 1 }, 'duplicate']
  ])('writes and sends nothing when %s', async (_name, options, outcome) => {
    const { worker, create, createToken, add, log } = build(options)
    await expect(worker.handle(sealed())).resolves.toBe(outcome)
    expect(create).not.toHaveBeenCalled()
    expect(createToken).not.toHaveBeenCalled()
    expect(add).not.toHaveBeenCalled()
    expect(log).not.toHaveBeenCalled()
  })

  it('drops a payload that does not open', async () => {
    const { worker, create } = build({})
    await expect(worker.handle('garbage')).resolves.toBe('dropped')
    expect(create).not.toHaveBeenCalled()
  })

  it('closes a request whose mail could not be queued, clears the address and its hash, and fails so the job is retried', async () => {
    const { worker, updateMany } = build({ mailFails: true })
    await expect(worker.handle(sealed())).rejects.toThrow('redis down')
    expect(argOf<unknown>(updateMany, 0, 0)).toMatchObject({
      where: { id: 'req-1', storeId: 'store-1', status: 'pending_verification' },
      data: {
        status: 'rejected',
        notifyToEncrypted: null,
        subjectEmailHash: null
      }
    })
  })

  it('keeps a failed mail job (it holds the link and the address) for an hour and no longer', async () => {
    const { worker, add } = build({})
    await worker.handle(sealed())
    expect(argOf<Record<string, unknown>>(add, 0, 2)).toEqual({
      removeOnComplete: true,
      removeOnFail: { age: 3600 }
    })
  })
})
