import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import {
  lockStoreForDelete,
  lockStoreForWrite,
  PrismaService,
  type PrismaTransaction
} from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelType } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { CustomerIdentityService } from '@platform/core/messaging'

import { CustomersService } from '../../apps/api/src/modules/customers/customers.service'
import { createConversation, createCustomer, createCustomerIdentity } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: { tables?: string[] } }
}

const OK = 200
const CREATED = 201
const CONFLICT = 409
const NO_CONTENT = 204
const NOT_FOUND = 404
// For what must finish: a slow machine is not a reason to fail
const FINISH_MS = 10_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))
// Did it finish within `ms`? Only for what must finish; what must wait is seen waiting (isBlocked)
const settled = async (pending: Promise<unknown>, ms: number): Promise<boolean> =>
  Promise.race([pending.then(() => true), sleep(ms).then(() => false)])

// The proof that a request waits for a lock, and not only that it was slow: a backend that the
// transaction we hold (its pid) is blocking. A waiter of someone else does not count.
async function waitingForLock(owner: OwnerClient, holderPid: number): Promise<boolean> {
  const rows = await owner.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity
    WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`
  return (rows[0]?.n ?? 0) > 0
}

// The backend that runs a transaction, so that what it blocks can be told from what other
// connections wait for
async function backendPid(tx: PrismaTransaction): Promise<number> {
  const rows = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid()::int AS pid`
  return rows[0]?.pid ?? 0
}

// How many backends wait for a lock held by another one
async function blockedBackends(owner: OwnerClient): Promise<number> {
  const rows = await owner.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM pg_stat_activity WHERE cardinality(pg_blocking_pids(pid)) > 0`
  return rows[0]?.n ?? 0
}

// A held transaction that fails before it is ready fails the test with its own error, instead of
// leaving it waiting for a signal that never comes
function opened(started: Promise<number>, transaction: Promise<unknown>): Promise<number> {
  return Promise.race([
    started,
    transaction.then(() => {
      throw new Error('the held transaction ended before it was ready')
    })
  ])
}

// MVP_TRIM_CHECKLIST.md section 10, item 23: deleting a store and writing data of it at the same
// moment. Each test holds one side of the race open, so that the other must wait for it: no timing
// luck decides the outcome.
describe('Writing data of a store while the store is deleted', () => {
  // True when the request is seen waiting for a lock before it finishes
  async function isBlocked(pending: Promise<unknown>, holderPid: number): Promise<boolean> {
    let finished = false
    void pending.then(
      () => {
        finished = true
      },
      () => {
        finished = true
      }
    )
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (finished) return false
      if (await waitingForLock(owner, holderPid)) return !finished
      await sleep(100)
    }
    return false
  }

  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  async function createStore(): Promise<string> {
    counter += 1
    const response = await asAdmin()
      .post(ApiRoutes.organizations.stores)
      .send({ name: `${prefix}-lock-${counter}` })
    expect(response.status).toBe(CREATED)
    return (response.body as { id: string }).id
  }

  // Every transaction held open is released after the test, whatever the test did: a failed
  // assertion must not leave a lock behind that hangs the clean-up
  const holds: (() => void)[] = []
  afterEach(() => {
    for (const release of holds) release()
    holds.length = 0
  })

  // A transaction that stays open until it is told to end
  function hold() {
    let release: () => void = () => undefined
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    let ready: (pid: number) => void = () => undefined
    const started = new Promise<number>(resolve => {
      ready = resolve
    })
    holds.push(release)
    return { gate, release, ready, started }
  }

  it('makes the delete wait for a write in flight, and then refuses it: the store holds data', async () => {
    const storeId = await createStore()
    const prisma = app.get(PrismaService, { strict: false })
    const writer = hold()
    const writing = prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await tx.customer.create({ data: { storeId, name: 'a customer in flight' } })
      writer.ready(await backendPid(tx))
      await writer.gate
    })
    const holderPid = await opened(writer.started, writing)

    const deleting = asAdmin().delete(ApiRoutes.organizations.storeById(storeId))
    const blocked = await isBlocked(deleting, holderPid)
    writer.release()
    await writing
    const response = await deleting

    expect(blocked).toBe(true)
    expect(response.status).toBe(CONFLICT)
    expect((response.body as ErrorBody).error.metadata?.tables).toEqual(['customers'])
    expect(await owner.customer.count({ where: { storeId } })).toBe(1)
  })

  it('makes a write that comes after the delete find no store, instead of writing into the cascade', async () => {
    const storeId = await createStore()
    const prisma = app.get(PrismaService, { strict: false })
    const deleter = hold()
    const deleting = prisma.transaction(async tx => {
      await lockStoreForDelete(tx, storeId)
      deleter.ready(await backendPid(tx))
      await deleter.gate
      await tx.store.deleteMany({ where: { id: storeId } })
    })
    const holderPid = await opened(deleter.started, deleting)

    const writing = app
      .get(CustomersService, { strict: false })
      .create(storeId, { name: 'a customer too late' })
      .then(
        () => null,
        (error: unknown) => error
      )
    const blocked = await isBlocked(writing, holderPid)
    deleter.release()
    await deleting
    const error = await writing

    expect(blocked).toBe(true)
    expect(error).toMatchObject({ code: ErrorCodes.RESOURCE_NOT_FOUND })
    expect(await owner.store.findUnique({ where: { id: storeId } })).toBeNull()
    expect(await owner.customer.count({ where: { storeId } })).toBe(0)
  })

  it('makes a known handle wait for the delete too, since it renames the identity', async () => {
    const storeId = await createStore()
    const service = app.get(CustomerIdentityService, { strict: false })
    await service.findOrCreateByIdentity({
      storeId,
      channelType: ChannelType.WHATSAPP,
      channelIdentity: '50370004444'
    })
    const prisma = app.get(PrismaService, { strict: false })
    const deleter = hold()
    const deleting = prisma.transaction(async tx => {
      await lockStoreForDelete(tx, storeId)
      deleter.ready(await backendPid(tx))
      await deleter.gate
    })
    const holderPid = await opened(deleter.started, deleting)

    const resolving = service.findOrCreateByIdentity({
      storeId,
      channelType: ChannelType.WHATSAPP,
      channelIdentity: '50370004444',
      profile: { displayName: 'Renamed' }
    })
    const blocked = await isBlocked(resolving, holderPid)
    deleter.release()
    await deleting
    const resolved = await resolving

    expect(blocked).toBe(true)
    // Once the delete (which here deleted nothing) let go, the rename went through
    const identity = await owner.customerIdentity.findUniqueOrThrow({
      where: { id: resolved.identityId }
    })
    expect(identity.displayName).toBe('Renamed')
  })

  it('returns the survivor for a handle that the real merge is moving at that moment', async () => {
    const storeId = ctx.storeA.id
    const service = app.get(CustomerIdentityService, { strict: false })
    const survivor = await createCustomer(owner, { storeId })
    const absorbed = await createCustomer(owner, { storeId })
    const identity = await createCustomerIdentity(owner, {
      storeId,
      customerId: absorbed.id,
      channelType: ChannelType.WHATSAPP,
      handle: '50370005555'
    })
    const conversation = await createConversation(owner, {
      storeId,
      customerId: absorbed.id,
      customerIdentityId: identity.id,
      channelType: ChannelType.WHATSAPP
    })
    // A lock on the conversation of the absorbed customer: the merge reaches it after it has locked
    // both customers and moved the identity, and waits there with the merge half done
    const prisma = app.get(PrismaService, { strict: false })
    const holder = hold()
    const holding = prisma.transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM conversations WHERE id = ${conversation.id} FOR UPDATE`
      holder.ready(await backendPid(tx))
      await holder.gate
    })
    const holderPid = await opened(holder.started, holding)
    const merging = asAdmin()
      .post(ApiRoutes.customers.merge(survivor.id))
      .send({ absorbedId: absorbed.id, fieldChoices: {} })
    expect(await isBlocked(merging, holderPid)).toBe(true)

    const resolving = service.findOrCreateByIdentity({
      storeId,
      channelType: ChannelType.WHATSAPP,
      channelIdentity: '50370005555'
    })
    // Two backends wait now: the merge for us, and the resolution for the merge
    let waiting = 0
    for (let attempt = 0; attempt < 50 && waiting < 2; attempt += 1) {
      waiting = await blockedBackends(owner)
      if (waiting < 2) await sleep(100)
    }
    holder.release()
    await holding
    const merged = await merging
    const resolved = await resolving

    expect(waiting).toBeGreaterThanOrEqual(2)
    expect(merged.status).toBe(OK)
    expect(resolved.customerId).toBe(survivor.id)
  })

  it('lets the store be renamed while a customer is being written', async () => {
    const storeId = await createStore()
    const prisma = app.get(PrismaService, { strict: false })
    const writer = hold()
    const writing = prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      writer.ready(await backendPid(tx))
      await writer.gate
    })
    await opened(writer.started, writing)

    const renaming = asAdmin()
      .patch(ApiRoutes.organizations.storeById(storeId))
      .send({ name: `${prefix}-renamed` })
    const finishedWhileWriting = await settled(renaming, FINISH_MS)
    writer.release()
    await writing
    const renamed = await renaming

    // Only a delete has to wait for a writer: a rename does not touch the key of the store
    expect(finishedWhileWriting).toBe(true)
    expect(renamed.status).toBe(OK)
    expect((await owner.store.findUniqueOrThrow({ where: { id: storeId } })).name).toBe(
      `${prefix}-renamed`
    )
  })

  it('answers 404 to the second of two deletes of the same store', async () => {
    const storeId = await createStore()
    const remove = () => asAdmin().delete(ApiRoutes.organizations.storeById(storeId))

    const [one, other] = await Promise.all([remove(), remove()])

    expect([one.status, other.status].sort()).toEqual([NO_CONTENT, NOT_FOUND])
  })

  it('deletes an empty store when nothing is writing', async () => {
    const storeId = await createStore()

    const response = await asAdmin().delete(ApiRoutes.organizations.storeById(storeId))

    expect(response.status).toBe(NO_CONTENT)
  })
})
