import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import {
  ConsentPurposes,
  ConsentSources,
  COOKIE_POLICY_VERSION,
  LegalBases
} from '@platform/core/compliance'
import type { OwnerClient } from '@platform/core/database-testing'

import { createCustomer } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, anonymousApi, api, apiWithoutStore } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

interface ConsentBody {
  items: { id: string; purpose: string; granted: boolean; current: boolean; legalBasis: string }[]
}
interface RecordedBody {
  consent: { id: string; granted: boolean; purpose: string; legalBasis: string }
  changed: boolean
}

describe('The consents of a customer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let viewer: Actor
  let editor: Actor

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    viewer = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'consentViewer',
      permissions: [Permissions.CUSTOMERS_VIEW]
    })
    editor = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'consentEditor',
      permissions: [Permissions.CUSTOMERS_EDIT]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const record = (actor: Actor, body: Record<string, unknown>) =>
    api(app, actor, ctx.storeA).post(ApiRoutes.compliance.consent).send(body)
  const list = (actor: Actor, customerId: string) =>
    api(app, actor, ctx.storeA).get(`${ApiRoutes.compliance.consent}?customerId=${customerId}`)
  const newCustomer = () => createCustomer(owner, { storeId: ctx.storeA.id })

  it('records an agreement with the basis of the purpose, never one the body names', async () => {
    const customer = await newCustomer()
    const res = await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: true
    })
    expect(res.status).toBe(OK)
    const body = res.body as RecordedBody
    expect(body.changed).toBe(true)
    expect(body.consent.legalBasis).toBe(LegalBases.CONTRACT)
    const row = await owner.consentRecord.findUniqueOrThrow({ where: { id: body.consent.id } })
    expect(row).toMatchObject({
      storeId: ctx.storeA.id,
      customerId: customer.id,
      granted: true,
      revokedAt: null,
      source: ConsentSources.STAFF,
      // The address and browser of the person who clicked are not the customer's
      ipAddress: null,
      userAgent: null
    })
    expect(row.grantedAt).not.toBeNull()

    const forged = await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: true,
      legalBasis: LegalBases.CONSENT
    })
    expect(forged.status).toBe(BAD_REQUEST)
  })

  it('keeps a history: a withdrawal is a new row and the newest one is the current answer', async () => {
    const customer = await newCustomer()
    const grant = await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: true
    })
    const withdraw = await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: false
    })
    expect((withdraw.body as RecordedBody).changed).toBe(true)
    expect(await owner.consentRecord.count({ where: { customerId: customer.id } })).toBe(2)
    // The agreement is still there, as it was
    const first = await owner.consentRecord.findUniqueOrThrow({
      where: { id: (grant.body as RecordedBody).consent.id }
    })
    expect(first).toMatchObject({ granted: true, revokedAt: null })

    const read = await list(viewer, customer.id)
    expect(read.status).toBe(OK)
    const items = (read.body as ConsentBody).items
    expect(items).toHaveLength(2)
    expect(items[0]).toMatchObject({ granted: false, current: true })
    expect(items[1]).toMatchObject({ granted: true, current: false })

    // Granting again after a withdrawal is a third row
    const again = await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: true
    })
    expect((again.body as RecordedBody).changed).toBe(true)
    expect(await owner.consentRecord.count({ where: { customerId: customer.id } })).toBe(3)
  })

  it('writes nothing, and audits nothing, when the latest answer is the same', async () => {
    const customer = await newCustomer()
    const body = {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: false
    }
    const first = await record(editor, body)
    const second = await record(editor, body)
    expect((first.body as RecordedBody).changed).toBe(true)
    expect((second.body as RecordedBody).changed).toBe(false)
    expect((second.body as RecordedBody).consent.id).toBe((first.body as RecordedBody).consent.id)
    expect(await owner.consentRecord.count({ where: { customerId: customer.id } })).toBe(1)
    const entries = await waitForAuditEntries(owner, {
      storeId: ctx.storeA.id,
      resourceId: (first.body as RecordedBody).consent.id,
      action: AuditAction.CONSENT_RECORDED
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.userId).toBe(editor.id)
    expect(entries[0]?.metadata).toMatchObject({
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: false
    })
  })

  it('stops the messages of an order: the reader looks at the newest row', async () => {
    const customer = await newCustomer()
    await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: false
    })
    const latest = await owner.consentRecord.findFirstOrThrow({
      where: { customerId: customer.id, purpose: ConsentPurposes.ORDER_MESSAGES },
      orderBy: { createdAt: 'desc' }
    })
    // What `order-messages` reads (`granted: false` or `revokedAt` set refuses the send)
    expect(!latest.granted || latest.revokedAt !== null).toBe(true)
  })

  it('needs the permission of each side: view to read, edit to write', async () => {
    const customer = await newCustomer()
    const body = { customerId: customer.id, purpose: ConsentPurposes.ORDER_MESSAGES, granted: true }
    expect((await record(viewer, body)).status).toBe(FORBIDDEN)
    expect((await list(editor, customer.id)).status).toBe(FORBIDDEN)
    expect(await owner.consentRecord.count({ where: { customerId: customer.id } })).toBe(0)
  })

  it('refuses a purpose it does not know and a body that is not whole', async () => {
    const customer = await newCustomer()
    for (const bad of [
      { customerId: customer.id, purpose: 'marketing', granted: true },
      { customerId: customer.id, purpose: ConsentPurposes.ORDER_MESSAGES },
      { customerId: 'not-a-uuid', purpose: ConsentPurposes.ORDER_MESSAGES, granted: true }
    ]) {
      expect((await record(editor, bad)).status).toBe(BAD_REQUEST)
    }
    expect(await owner.consentRecord.count({ where: { customerId: customer.id } })).toBe(0)
  })

  it('answers 404 for a customer of another store, on both routes', async () => {
    const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })
    const res = await record(editor, {
      customerId: foreign.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: false
    })
    expect(res.status).toBe(NOT_FOUND)
    expect((await list(viewer, foreign.id)).status).toBe(NOT_FOUND)
    expect(await owner.consentRecord.count({ where: { customerId: foreign.id } })).toBe(0)
  })

  it('refuses to write to an erased customer and shows no history of one', async () => {
    const customer = await newCustomer()
    await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: true
    })
    await owner.customer.update({ where: { id: customer.id }, data: { erasedAt: new Date() } })
    const res = await record(editor, {
      customerId: customer.id,
      purpose: ConsentPurposes.ORDER_MESSAGES,
      granted: false
    })
    expect(res.status).toBe(CONFLICT)
    expect(await owner.consentRecord.count({ where: { customerId: customer.id } })).toBe(1)
    const read = await list(viewer, customer.id)
    expect(read.status).toBe(OK)
    expect((read.body as ConsentBody).items).toEqual([])
  })

  it('does not lose an answer when two come at once', async () => {
    const customer = await newCustomer()
    const body = { customerId: customer.id, purpose: ConsentPurposes.ORDER_MESSAGES, granted: true }
    const results = await Promise.all([
      record(editor, body),
      record(editor, body),
      record(editor, body)
    ])
    expect(results.map(r => r.status)).toEqual([OK, OK, OK])
    // One row: the lock of the customer makes the second and third see the first
    expect(await owner.consentRecord.count({ where: { customerId: customer.id } })).toBe(1)
  })
})

describe('The answer to the cookie banner', () => {
  const prefix = newRunPrefix()
  const visitors: string[] = []
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await owner.cookieConsent.deleteMany({ where: { visitorId: { in: visitors } } })
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const visitor = (): string => {
    const id = randomUUID()
    visitors.push(id)
    return id
  }
  const answer = (
    visitorId: string,
    categories = { functional: true, analytics: false, marketing: false }
  ) => ({
    visitorId,
    categories,
    policyVersion: COOKIE_POLICY_VERSION
  })
  const post = (body: Record<string, unknown>) =>
    anonymousApi(app).post(ApiRoutes.compliance.cookieConsent).send(body)

  it('records the choice of an anonymous visitor, with a hash of the address and no account', async () => {
    const id = visitor()
    const res = await post(answer(id))
    expect(res.status).toBe(OK)
    expect(res.body).toEqual({ recorded: true })
    const rows = await owner.cookieConsent.findMany({ where: { visitorId: id } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: null,
      policyVersion: COOKIE_POLICY_VERSION,
      categories: { functional: true, analytics: false, marketing: false }
    })
    // A keyed hash, not an address
    expect(rows[0]?.ipHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('keeps the history: a changed choice is a new row, the same one again is nothing', async () => {
    const id = visitor()
    await post(answer(id))
    expect((await post(answer(id))).body).toEqual({ recorded: false })
    const changed = await post(answer(id, { functional: true, analytics: true, marketing: false }))
    expect(changed.body).toEqual({ recorded: true })
    expect(await owner.cookieConsent.count({ where: { visitorId: id } })).toBe(2)
  })

  it('takes the account from the token, never from the body', async () => {
    const id = visitor()
    const res = await apiWithoutStore(app, ctx.adminA)
      .post(ApiRoutes.compliance.cookieConsent)
      .send({ ...answer(id), userId: ctx.adminB.id })
    // An unknown field is refused: the body cannot name the account
    expect(res.status).toBe(BAD_REQUEST)
    const ok = await apiWithoutStore(app, ctx.adminA)
      .post(ApiRoutes.compliance.cookieConsent)
      .send(answer(id))
    expect(ok.status).toBe(OK)
    const row = await owner.cookieConsent.findFirstOrThrow({ where: { visitorId: id } })
    expect(row.userId).toBe(ctx.adminA.id)
  })

  it('refuses a policy version the server does not know, a missing category and a bad id', async () => {
    const id = visitor()
    for (const bad of [
      { ...answer(id), policyVersion: '1999-01-01' },
      { visitorId: id, categories: { functional: true }, policyVersion: COOKIE_POLICY_VERSION },
      { ...answer('not-a-uuid') },
      {
        ...answer(id),
        categories: { functional: true, analytics: false, marketing: false, necessary: false }
      }
    ]) {
      expect((await post(bad)).status).toBe(BAD_REQUEST)
    }
    expect(await owner.cookieConsent.count({ where: { visitorId: id } })).toBe(0)
  })
})
