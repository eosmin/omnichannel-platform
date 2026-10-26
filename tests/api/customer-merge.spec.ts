import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelType, PaymentMethod } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createConversation, createCustomer, createCustomerIdentity, createTag } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface CustomerBody {
  id: string
  name: string | null
  email: string | null
  phone: string | null
  isCaution: boolean
  identities: { id: string; channelType: string }[]
  addresses: { id: string; isDefault: boolean }[]
  tags: { id: string }[]
}

const OK = 200
const BAD_REQUEST = 400
const NOT_FOUND = 404
const CONFLICT = 409
const DAY_MS = 86_400_000

describe('Merging customers', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext

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
  const storeId = (): string => ctx.storeA.id

  // The same person, twice: Ana on WhatsApp and Ana on Instagram, each with a conversation, an order,
  // an address and a note
  let counter = 0
  async function twoAnas() {
    // A number of its own in each scenario: a handle belongs to one customer of the store
    counter += 1
    const digits = `7${String(counter).padStart(3, '0')}4567`
    const survivor = await owner.customer.create({
      data: {
        storeId: storeId(),
        name: 'Ana',
        phone: `+503 ${digits}`,
        phoneNormalized: `503${digits}`
      }
    })
    const absorbed = await owner.customer.create({
      data: {
        storeId: storeId(),
        name: `Ana Instagram ${digits}`,
        email: 'ana@example.com',
        isCaution: true,
        cautionReason: 'devolvió un pedido'
      }
    })
    const whatsapp = await createCustomerIdentity(owner, {
      storeId: storeId(),
      customerId: survivor.id,
      channelType: ChannelType.WHATSAPP,
      handle: `503${digits}`
    })
    const instagram = await createCustomerIdentity(owner, {
      storeId: storeId(),
      customerId: absorbed.id,
      channelType: ChannelType.INSTAGRAM
    })
    const conversation = await createConversation(owner, {
      storeId: storeId(),
      customerId: absorbed.id,
      customerIdentityId: instagram.id,
      channelType: ChannelType.INSTAGRAM
    })
    const order = await owner.order.create({
      data: {
        storeId: storeId(),
        customerId: absorbed.id,
        orderNumber: `${prefix}-${absorbed.id.slice(0, 8)}`,
        subtotalCents: 1000,
        totalCents: 1000,
        paymentMethod: PaymentMethod.CASH,
        createdBy: ctx.adminA.id
      }
    })
    const address = await owner.address.create({
      data: { customerId: absorbed.id, line1: 'Calle 9', city: 'Santa Ana', isDefault: true }
    })
    const survivorAddress = await owner.address.create({
      data: { customerId: survivor.id, line1: 'Calle 1', city: 'San Salvador', isDefault: true }
    })
    const note = await owner.customerNote.create({
      data: { customerId: absorbed.id, authorId: ctx.adminA.id, content: 'escribe por IG' }
    })
    const media = await owner.media.create({
      data: {
        storeId: storeId(),
        customerId: absorbed.id,
        purpose: 'message',
        key: `${prefix}/media/${digits}`,
        filename: 'foto.jpg',
        contentType: 'image/jpeg',
        fileSize: 1024
      }
    })
    const shared = await createTag(owner, { storeId: storeId() })
    const onlyAbsorbed = await createTag(owner, { storeId: storeId() })
    await owner.customer.update({
      where: { id: survivor.id },
      data: { tags: { connect: [{ id: shared.id }] } }
    })
    await owner.customer.update({
      where: { id: absorbed.id },
      data: { tags: { connect: [{ id: shared.id }, { id: onlyAbsorbed.id }] } }
    })
    return {
      survivor,
      absorbed,
      whatsapp,
      instagram,
      conversation,
      order,
      address,
      survivorAddress,
      note,
      media,
      shared,
      onlyAbsorbed
    }
  }

  const merge = (survivorId: string, absorbedId: string, fieldChoices: object = {}) =>
    asAdmin().post(ApiRoutes.customers.merge(survivorId)).send({ absorbedId, fieldChoices })

  it('joins two identities on different channels into one customer, and hides the other', async () => {
    const s = await twoAnas()

    const response = await merge(s.survivor.id, s.absorbed.id)

    expect(response.status).toBe(OK)
    const merged = response.body as CustomerBody
    expect(merged.id).toBe(s.survivor.id)
    expect(merged.identities.map(identity => identity.channelType).sort()).toEqual([
      ChannelType.INSTAGRAM,
      ChannelType.WHATSAPP
    ])
    // The survivor's name and phone stay, the gap in the e-mail is filled, the caution is kept
    expect(merged).toMatchObject({
      name: 'Ana',
      phone: s.survivor.phone,
      email: 'ana@example.com',
      isCaution: true
    })
    expect(merged.tags.map(tag => tag.id).sort()).toEqual([s.shared.id, s.onlyAbsorbed.id].sort())
    // One default address: the survivor's
    expect(merged.addresses.filter(address => address.isDefault).map(a => a.id)).toEqual([
      s.survivorAddress.id
    ])
    expect(
      (await owner.conversation.findUnique({ where: { id: s.conversation.id } }))?.customerId
    ).toBe(s.survivor.id)
    expect((await owner.order.findUnique({ where: { id: s.order.id } }))?.customerId).toBe(
      s.survivor.id
    )
    expect((await owner.customerNote.findUnique({ where: { id: s.note.id } }))?.customerId).toBe(
      s.survivor.id
    )
    expect((await owner.media.findUnique({ where: { id: s.media.id } }))?.customerId).toBe(
      s.survivor.id
    )
    expect((await asAdmin().get(ApiRoutes.customers.byId(s.absorbed.id))).status).toBe(NOT_FOUND)
    // Gone from the list, and the survivor is still in it
    const absorbedGone = await asAdmin()
      .get(ApiRoutes.customers.list)
      .query({ q: s.absorbed.name ?? '' })
    const survivorListed = await asAdmin()
      .get(ApiRoutes.customers.list)
      .query({ q: s.survivor.name ?? '' })
    expect(absorbedGone.body).toMatchObject({ data: [] })
    expect((survivorListed.body as { data: { id: string }[] }).data.map(row => row.id)).toContain(
      s.survivor.id
    )
  })

  it('moves the consent records with the customer, and brings them back on unmerge', async () => {
    const s = await twoAnas()
    const consent = await owner.consentRecord.create({
      data: {
        storeId: storeId(),
        customerId: s.absorbed.id,
        purpose: 'marketing',
        legalBasis: 'consent',
        granted: true,
        source: 'test'
      }
    })

    await merge(s.survivor.id, s.absorbed.id)
    const moved = await owner.consentRecord.findUniqueOrThrow({ where: { id: consent.id } })
    const mergeRow = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: s.survivor.id }
    })
    await asAdmin().post(ApiRoutes.customers.unmerge(s.survivor.id)).send({ mergeId: mergeRow.id })
    const back = await owner.consentRecord.findUniqueOrThrow({ where: { id: consent.id } })

    expect(moved.customerId).toBe(s.survivor.id)
    expect(back.customerId).toBe(s.absorbed.id)
  })

  it('takes the fields the user chose from the absorbed customer', async () => {
    const s = await twoAnas()

    const response = await merge(s.survivor.id, s.absorbed.id, { name: 'absorbed' })

    expect((response.body as CustomerBody).name).toBe(s.absorbed.name)
  })

  it('refuses to merge a customer with itself, with another store, or with one already merged', async () => {
    const s = await twoAnas()
    const foreign = await createCustomer(owner, { storeId: ctx.storeA2.id })

    const same = await merge(s.survivor.id, s.survivor.id)
    const other = await merge(s.survivor.id, foreign.id)
    await merge(s.survivor.id, s.absorbed.id)
    const again = await merge(s.survivor.id, s.absorbed.id)

    expect(same.status).toBe(BAD_REQUEST)
    expect((same.body as ErrorBody).error.code).toBe(ErrorCodes.CUSTOMER_MERGE_SAME_ID)
    expect(other.status).toBe(NOT_FOUND)
    expect(again.status).toBe(NOT_FOUND)
  })

  it('is undone: the other customer comes back with everything it had', async () => {
    const s = await twoAnas()
    const merged = await merge(s.survivor.id, s.absorbed.id, { name: 'absorbed' })
    expect(merged.status).toBe(OK)
    const mergeRow = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: s.survivor.id }
    })

    const response = await asAdmin()
      .post(ApiRoutes.customers.unmerge(s.survivor.id))
      .send({ mergeId: mergeRow.id })

    expect(response.status).toBe(OK)
    const restored = response.body as CustomerBody
    expect(restored.id).toBe(s.absorbed.id)
    expect(restored).toMatchObject({ name: s.absorbed.name, isCaution: true })
    expect(restored.identities.map(identity => identity.id)).toEqual([s.instagram.id])
    expect(restored.addresses).toEqual([
      {
        id: s.address.id,
        isDefault: true,
        label: null,
        line1: 'Calle 9',
        line2: null,
        city: 'Santa Ana',
        state: null,
        postalCode: null,
        country: 'SV'
      }
    ])
    const survivor = (await asAdmin().get(ApiRoutes.customers.byId(s.survivor.id)))
      .body as CustomerBody
    expect(survivor).toMatchObject({ name: 'Ana', email: null })
    expect(survivor.identities.map(identity => identity.id)).toEqual([s.whatsapp.id])
    expect(survivor.tags.map(tag => tag.id)).toEqual([s.shared.id])
    expect(survivor.addresses.filter(address => address.isDefault)).toHaveLength(1)
    expect(
      (await owner.conversation.findUnique({ where: { id: s.conversation.id } }))?.customerId
    ).toBe(s.absorbed.id)
    expect((await owner.order.findUnique({ where: { id: s.order.id } }))?.customerId).toBe(
      s.absorbed.id
    )
    expect((await owner.customerNote.findUnique({ where: { id: s.note.id } }))?.customerId).toBe(
      s.absorbed.id
    )
    expect((await owner.media.findUnique({ where: { id: s.media.id } }))?.customerId).toBe(
      s.absorbed.id
    )
    expect(
      (await owner.customerMerge.findUniqueOrThrow({ where: { id: mergeRow.id } })).unmergedAt
    ).not.toBeNull()
    // A merge is undone once
    const twice = await asAdmin()
      .post(ApiRoutes.customers.unmerge(s.survivor.id))
      .send({ mergeId: mergeRow.id })
    expect(twice.status).toBe(NOT_FOUND)
  })

  it('leaves the absorbed customer with a default address after the unmerge', async () => {
    // The absorbed customer has the only default; the survivor has no address at all
    const survivor = await owner.customer.create({
      data: { storeId: storeId(), name: 'Sin direcciones' }
    })
    const absorbed = await owner.customer.create({
      data: { storeId: storeId(), name: 'Con direccion' }
    })
    const address = await owner.address.create({
      data: { customerId: absorbed.id, line1: 'Calle X', city: 'Santa Ana', isDefault: true }
    })
    await merge(survivor.id, absorbed.id)
    const mergeRow = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: survivor.id }
    })
    // After the merge the survivor makes another address its default: X stops being one
    const added = await asAdmin()
      .post(ApiRoutes.customers.addresses(survivor.id))
      .send({ line1: 'Calle Y', city: 'San Miguel', isDefault: true })
    expect(added.status).toBe(201)

    const response = await asAdmin()
      .post(ApiRoutes.customers.unmerge(survivor.id))
      .send({ mergeId: mergeRow.id })

    expect(response.status).toBe(OK)
    const back = await owner.address.findUniqueOrThrow({ where: { id: address.id } })
    expect(back).toMatchObject({ customerId: absorbed.id, isDefault: true })
  })

  it('keeps what happened to the survivor after the merge', async () => {
    const s = await twoAnas()
    await merge(s.survivor.id, s.absorbed.id)
    const mergeRow = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: s.survivor.id }
    })
    // After the merge the survivor is renamed (a field the merge did not change) and its e-mail
    // edited (a field it did)
    await asAdmin()
      .patch(ApiRoutes.customers.byId(s.survivor.id))
      .send({ name: 'Ana María', email: 'otra@example.com' })
    const conversationOfTheNewIdentity = await createConversation(owner, {
      storeId: storeId(),
      customerId: s.survivor.id,
      customerIdentityId: s.instagram.id,
      channelType: ChannelType.INSTAGRAM
    })

    await asAdmin().post(ApiRoutes.customers.unmerge(s.survivor.id)).send({ mergeId: mergeRow.id })

    const survivor = (await asAdmin().get(ApiRoutes.customers.byId(s.survivor.id)))
      .body as CustomerBody
    expect(survivor).toMatchObject({ name: 'Ana María', email: 'otra@example.com' })
    // A conversation that the Instagram identity opened meanwhile goes back with the identity
    expect(
      (await owner.conversation.findUnique({ where: { id: conversationOfTheNewIdentity.id } }))
        ?.customerId
    ).toBe(s.absorbed.id)
  })

  it('cannot be undone after 30 days, or once the survivor was absorbed itself', async () => {
    const old = await twoAnas()
    await merge(old.survivor.id, old.absorbed.id)
    const oldMerge = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: old.survivor.id }
    })
    await owner.customerMerge.update({
      where: { id: oldMerge.id },
      data: { unmergeUntil: new Date(Date.now() - DAY_MS) }
    })
    const expired = await asAdmin()
      .post(ApiRoutes.customers.unmerge(old.survivor.id))
      .send({ mergeId: oldMerge.id })

    const chain = await twoAnas()
    expect((await merge(chain.survivor.id, chain.absorbed.id)).status).toBe(OK)
    const chainMerge = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: chain.survivor.id }
    })
    const third = await createCustomer(owner, { storeId: storeId() })
    expect((await merge(third.id, chain.survivor.id)).status).toBe(OK)
    const blocked = await asAdmin()
      .post(ApiRoutes.customers.unmerge(chain.survivor.id))
      .send({ mergeId: chainMerge.id })

    expect(expired.status).toBe(CONFLICT)
    expect((expired.body as ErrorBody).error.code).toBe(ErrorCodes.CUSTOMER_UNMERGE_WINDOW_EXPIRED)
    // The survivor was absorbed in turn: the user is told to undo that merge first, and by whom
    expect(blocked.status).toBe(CONFLICT)
    expect((blocked.body as ErrorBody).error).toMatchObject({
      code: ErrorCodes.RESOURCE_CONFLICT,
      metadata: { mergedIntoId: third.id }
    })
  })

  it('undoes a merge once when it is asked twice at the same moment', async () => {
    const s = await twoAnas()
    await merge(s.survivor.id, s.absorbed.id)
    const mergeRow = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: s.survivor.id }
    })
    const undo = () =>
      asAdmin().post(ApiRoutes.customers.unmerge(s.survivor.id)).send({ mergeId: mergeRow.id })

    const [one, other] = await Promise.all([undo(), undo()])

    expect([one.status, other.status].sort()).toEqual([OK, NOT_FOUND])
  })

  it('puts back the caution flag as a whole, never one column of it', async () => {
    const s = await twoAnas()
    await merge(s.survivor.id, s.absorbed.id)
    const mergeRow = await owner.customerMerge.findFirstOrThrow({
      where: { survivorId: s.survivor.id }
    })
    // The reason is edited after the merge (the caution endpoints of Step 4.12 do this)
    await owner.customer.update({
      where: { id: s.survivor.id },
      data: { cautionReason: 'reason edited after the merge' }
    })

    await asAdmin().post(ApiRoutes.customers.unmerge(s.survivor.id)).send({ mergeId: mergeRow.id })

    const survivor = await owner.customer.findUniqueOrThrow({ where: { id: s.survivor.id } })
    expect(survivor).toMatchObject({
      isCaution: true,
      cautionReason: 'reason edited after the merge'
    })
  })

  it("keeps the survivor's old caution columns when neither customer is in caution", async () => {
    const survivor = await owner.customer.create({
      data: { storeId: storeId(), name: 'Con historial', cautionReason: 'cleared flag, old reason' }
    })
    const absorbed = await owner.customer.create({ data: { storeId: storeId(), name: 'Otro' } })

    await merge(survivor.id, absorbed.id)

    const merged = await owner.customer.findUniqueOrThrow({ where: { id: survivor.id } })
    expect(merged).toMatchObject({
      isCaution: false,
      cautionReason: 'cleared flag, old reason'
    })
  })

  it('is audited with who did it', async () => {
    const s = await twoAnas()
    await merge(s.survivor.id, s.absorbed.id)

    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entry = await owner.auditLog.findFirst({
        where: { action: AuditAction.CUSTOMER_MERGED, resourceId: s.survivor.id }
      })
      if (entry !== null) {
        expect(entry.userId).toBe(ctx.adminA.id)
        return
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    throw new Error('the merge was not audited')
  })

  it('holds when the same pair is merged in both directions at once', async () => {
    const s = await twoAnas()

    const [one, other] = await Promise.all([
      merge(s.survivor.id, s.absorbed.id),
      merge(s.absorbed.id, s.survivor.id)
    ])

    // One wins; the other finds its customer already absorbed. Nobody deadlocks or ends up hidden twice.
    expect([one.status, other.status].sort()).toEqual([OK, NOT_FOUND])
    const hidden = await owner.customer.count({
      where: { id: { in: [s.survivor.id, s.absorbed.id] }, mergedIntoId: { not: null } }
    })
    expect(hidden).toBe(1)
  })
})
