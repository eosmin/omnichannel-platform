import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions, RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ChannelIdentityKinds, ChannelIds } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { type ChannelProfile, CustomerIdentityService } from '@platform/core/messaging'
import { PluginRegistry } from '@platform/plugins/runtime'

import { createConversation, createCustomer, createTag } from '../builders'
import { buildChannelPlugin } from '../builders/channel-plugin'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
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
  nationalPhone: string | null
  isCaution: boolean
  identities: { id: string; channelType: string; channelIdentity: string }[]
  addresses: { id: string; line1: string; isDefault: boolean }[]
  tags: { id: string }[]
}
interface PageBody {
  data: { id: string; name: string | null }[]
  nextCursor: string | null
  hasMore: boolean
}

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

describe('The customers of a store', () => {
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
  const identities = () => app.get(CustomerIdentityService, { strict: false })

  async function create(body: Record<string, unknown>): Promise<CustomerBody> {
    const response = await asAdmin().post(ApiRoutes.customers.list).send(body)
    expect(response.status).toBe(CREATED)
    return response.body as CustomerBody
  }

  describe('the national phone', () => {
    it('gives the phone without its country code, and null for a customer with no phone', async () => {
      const withPhone = await create({ name: 'National', phone: '+503 7123 4567' })
      expect(withPhone.nationalPhone).toBe('71234567')
      const read = await asAdmin().get(ApiRoutes.customers.byId(withPhone.id))
      expect((read.body as CustomerBody).nationalPhone).toBe('71234567')
      // The normalized digits are the api's own: the view never lists them
      expect(read.body).not.toHaveProperty('phoneNormalized')
      const without = await create({
        name: 'No phone',
        email: `${randomUUID().slice(0, 8)}@example.com`
      })
      expect(without.nationalPhone).toBeNull()
    })
  })

  describe('a possible duplicate', () => {
    interface Hint {
      id: string
      name: string | null
      email: string | null
      phone: string | null
      matchedOn: string[]
    }
    interface Created extends CustomerBody {
      possibleDuplicates: Hint[]
    }
    const createWith = async (body: Record<string, unknown>): Promise<Created> =>
      (await create(body)) as Created
    const uniqueEmail = (): string => `${randomUUID().slice(0, 8)}@example.com`
    // +503 7 and seven digits, random: no other case of the store can hold the same number
    const uniquePhone = (): { display: string; digits: string } => {
      const seven = String(Math.floor(Math.random() * 9_000_000) + 1_000_000)
      return { display: `+503 7${seven.slice(0, 3)} ${seven.slice(3)}`, digits: `5037${seven}` }
    }
    const inStore = (data: Record<string, unknown>) =>
      owner.customer.create({ data: { storeId: ctx.storeA.id, ...data } as never })

    it('creates the customer anyway and names the ones that share the e-mail or the phone', async () => {
      const email = uniqueEmail()
      const phone = uniquePhone()
      // Stored as it came from a channel or an import, in capitals: the match does not depend on case
      const byEmail = await inStore({ name: 'Ana', email: email.toUpperCase() })
      const byPhone = await createWith({ name: 'Beto', phone: phone.display })
      const neither = await createWith({
        name: 'Carla',
        email: `x${email}`,
        phone: uniquePhone().display
      })

      const twin = await createWith({ name: 'Ana otra vez', email, phone: phone.display })

      expect(twin.id).toBeDefined()
      expect(twin.possibleDuplicates).toHaveLength(2)
      const byId = new Map(twin.possibleDuplicates.map(hint => [hint.id, hint]))
      expect(byId.get(byEmail.id)).toMatchObject({ name: 'Ana', matchedOn: ['email'] })
      expect(byId.get(byPhone.id)).toMatchObject({ name: 'Beto', matchedOn: ['phone'] })
      expect(byId.has(neither.id)).toBe(false)
      // Created: it is a hint, never a refusal
      expect(await owner.customer.findUnique({ where: { id: twin.id } })).not.toBeNull()
    })

    it('names one that shares both, first, with both reasons', async () => {
      const email = uniqueEmail()
      const phone = uniquePhone()
      const onlyEmail = await createWith({ name: 'E', email })
      const both = await createWith({ name: 'Both', email, phone: phone.display })
      const onlyPhone = await createWith({ name: 'P', phone: phone.display })

      const created = await createWith({ name: 'New', email, phone: phone.display })

      expect(created.possibleDuplicates.map(hint => hint.id)).toEqual([
        both.id,
        onlyPhone.id,
        onlyEmail.id
      ])
      expect(created.possibleDuplicates[0]?.matchedOn.sort()).toEqual(['email', 'phone'])
    })

    it('says nothing when the customer is the first with that e-mail and phone', async () => {
      const first = await createWith({
        name: 'Sola',
        email: uniqueEmail(),
        phone: uniquePhone().display
      })

      expect(first.possibleDuplicates).toEqual([])
    })

    it('takes an underscore of an e-mail for what it is, not for a wildcard', async () => {
      const tag = randomUUID().slice(0, 8)
      const stranger = await inStore({ name: 'Stranger', email: `a${tag}Xb@example.com` })
      const dotted = await inStore({ name: 'Dotted', email: `a${tag}.b@example.com` })
      const same = await inStore({ name: 'Same', email: `A${tag}_B@example.com` })

      const created = await createWith({ name: 'Underscore', email: `a${tag}_b@example.com` })

      expect(created.possibleDuplicates.map(hint => hint.id)).toEqual([same.id])
      expect(created.possibleDuplicates.map(hint => hint.id)).not.toContain(stranger.id)
      expect(created.possibleDuplicates.map(hint => hint.id)).not.toContain(dotted.id)
    })

    interface Shared {
      row: Record<string, unknown> // What the existing customer is stored with
      body: Record<string, unknown> // What the new one is created with
    }
    const sharedEmail = (): Shared => {
      const email = uniqueEmail()
      return { row: { email }, body: { email } }
    }
    const sharedPhone = (): Shared => {
      const phone = uniquePhone()
      return {
        row: { phone: phone.display, phoneNormalized: phone.digits },
        body: { phone: phone.display }
      }
    }

    describe.each<[string, () => Shared]>([
      ['e-mail', sharedEmail],
      ['phone', sharedPhone]
    ])('by %s alone', (_label, shared) => {
      it('does not look at another store', async () => {
        const { row, body } = shared()
        await owner.customer.create({
          data: { storeId: ctx.storeB.id, name: 'Elsewhere', ...row } as never
        })

        const created = await createWith({ name: 'New', ...body })

        expect(created.possibleDuplicates).toEqual([])
      })

      it('does not list a customer that a merge absorbed', async () => {
        const { row, body } = shared()
        const survivor = await inStore({ name: 'Survivor' })
        await inStore({ name: 'Absorbed', mergedIntoId: survivor.id, ...row })

        const created = await createWith({ name: 'New', ...body })

        expect(created.possibleDuplicates).toEqual([])
      })

      it('does not list a customer that was erased', async () => {
        const { row, body } = shared()
        await inStore({ name: null, erasedAt: new Date(), ...row })

        const created = await createWith({ name: 'New', ...body })

        expect(created.possibleDuplicates).toEqual([])
      })
    })

    it('shows at most five, and a shared mailbox does not hide the one with the same phone', async () => {
      const email = uniqueEmail()
      const phone = uniquePhone()
      const samePhone = await createWith({ name: 'Same phone', phone: phone.display })
      for (let i = 0; i < 7; i += 1) await createWith({ name: `n${i}`, email })

      const created = await createWith({ name: 'Last', email, phone: phone.display })

      expect(created.possibleDuplicates).toHaveLength(5)
      expect(created.possibleDuplicates[0]?.id).toBe(samePhone.id)
    })

    it('shows nobody to a member who may create customers but not see them, and shows them to one who may', async () => {
      const email = uniqueEmail()
      const existing = await createWith({ name: 'Visible to others', email })
      const creator = await actorWithPermissions(owner, app, {
        prefix,
        name: 'creator-only',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CUSTOMERS_CREATE]
      })
      const both = await actorWithPermissions(owner, app, {
        prefix,
        name: 'creator-viewer',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.CUSTOMERS_CREATE, Permissions.CUSTOMERS_VIEW]
      })

      const blind = await api(app, creator, ctx.storeA)
        .post(ApiRoutes.customers.list)
        .send({ name: 'Blind', email })
      const sighted = await api(app, both, ctx.storeA)
        .post(ApiRoutes.customers.list)
        .send({ name: 'Sighted', email })

      expect(blind.status).toBe(CREATED)
      expect((blind.body as Created).possibleDuplicates).toEqual([])
      expect(sighted.status).toBe(CREATED)
      expect((sighted.body as Created).possibleDuplicates.map(hint => hint.id)).toContain(
        existing.id
      )
    })
  })

  describe('creating and editing', () => {
    it('stores a phone number with its country code, however it was typed', async () => {
      const typed = await create({ name: 'Ana', phone: '7123-4567' })
      const abroad = await create({ name: 'Beto', phone: '+52 55 1234 5678' })

      expect(typed.phone).toBe('+503 7123 4567')
      expect(abroad.phone).toBe('+52 55 1234 5678')
      const row = await owner.customer.findUnique({ where: { id: typed.id } })
      expect(row?.phoneNormalized).toBe('50371234567')
    })

    it('refuses a phone number that is not valid and a customer with nothing to name them', async () => {
      const invalid = await asAdmin().post(ApiRoutes.customers.list).send({ phone: '12345' })
      const empty = await asAdmin().post(ApiRoutes.customers.list).send({ locale: 'es' })
      const extra = await asAdmin().post(ApiRoutes.customers.list).send({ name: 'x', storeId: 'y' })

      for (const response of [invalid, empty, extra]) {
        expect(response.status).toBe(BAD_REQUEST)
        expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
      }
    })

    it('trims the e-mail like every other field, and refuses what is not a country or a locale', async () => {
      const trimmed = await asAdmin()
        .post(ApiRoutes.customers.list)
        .send({ name: 'Espacios', email: ' Espacios@Example.com ' })
      const badLocale = await asAdmin()
        .post(ApiRoutes.customers.list)
        .send({ name: 'Locale', locale: 'x$' })
      const customer = await create({ name: 'Pais' })
      const badCountry = await asAdmin()
        .post(ApiRoutes.customers.addresses(customer.id))
        .send({ line1: 'Calle', city: 'Ciudad', country: '1!' })

      expect(trimmed.status).toBe(CREATED)
      expect((trimmed.body as CustomerBody).email).toBe('espacios@example.com')
      expect(badLocale.status).toBe(BAD_REQUEST)
      expect(badCountry.status).toBe(BAD_REQUEST)
    })

    it('answers 400 to a text with a NUL character, which Postgres cannot store', async () => {
      const customer = await create({ name: 'Nul' })
      const attempts = [
        asAdmin().post(ApiRoutes.customers.list).send({ name: 'a\u0000b' }),
        asAdmin().get(ApiRoutes.customers.list).query({ q: 'a\u0000b' }),
        asAdmin().post(ApiRoutes.customers.notes(customer.id)).send({ content: 'a\u0000b' }),
        asAdmin()
          .post(ApiRoutes.customers.addresses(customer.id))
          .send({ line1: 'a\u0000b', city: 'x' })
      ]

      for (const response of await Promise.all(attempts)) {
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('refuses a name that is not one visible line, however the customer is written', async () => {
      const customer = await create({ name: 'Una linea' })
      const names = [
        'dos\nlineas',
        'Zero\u200bwidth',
        'Ana \u202egnirpS',
        'dos\u2028lineas',
        'dos\tcolumnas'
      ]

      for (const name of names) {
        const attempts = [
          asAdmin().post(ApiRoutes.customers.list).send({ name }),
          asAdmin().patch(ApiRoutes.customers.byId(customer.id)).send({ name })
        ]
        for (const response of await Promise.all(attempts)) {
          expect(response.status).toBe(BAD_REQUEST)
        }
      }
      const kept = await asAdmin().get(ApiRoutes.customers.byId(customer.id))
      expect((kept.body as { name: string }).name).toBe('Una linea')
    })

    it('keeps the e-mail in lower case and clears a field with null', async () => {
      const customer = await create({ name: 'Eva', email: 'Eva@Example.COM', phone: '7000-1119' })
      expect(customer.email).toBe('eva@example.com')

      const response = await asAdmin()
        .patch(ApiRoutes.customers.byId(customer.id))
        .send({ phone: null, name: 'Eva Ruiz' })

      expect(response.status).toBe(OK)
      const updated = response.body as CustomerBody
      expect(updated.phone).toBeNull()
      expect(updated.name).toBe('Eva Ruiz')
      const row = await owner.customer.findUnique({ where: { id: customer.id } })
      expect(row?.phoneNormalized).toBeNull()
    })

    it('keeps at least one way to name or reach the customer when it is edited', async () => {
      const customer = await create({ name: 'Solo nombre' })

      const bare = await asAdmin()
        .patch(ApiRoutes.customers.byId(customer.id))
        .send({ name: null, email: null, phone: null })
      const swapped = await asAdmin()
        .patch(ApiRoutes.customers.byId(customer.id))
        .send({ name: null, email: 'otro@example.com' })

      expect(bare.status).toBe(BAD_REQUEST)
      expect((bare.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(swapped.status).toBe(OK)
      // The refused edit wrote nothing, and the accepted one wrote what it said
      const row = await owner.customer.findUniqueOrThrow({ where: { id: customer.id } })
      expect(row).toMatchObject({ name: null, email: 'otro@example.com', phone: null })
    })

    it('has the same phone number as two customers in two stores', async () => {
      const here = await create({ name: 'Mismo', phone: '+503 7555-0001' })
      const there = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.customers.list)
        .send({ name: 'Mismo', phone: '+503 7555-0001' })

      expect(there.status).toBe(CREATED)
      expect((there.body as CustomerBody).id).not.toBe(here.id)
      const rows = await owner.customer.findMany({
        where: {
          phoneNormalized: '50375550001',
          storeId: { in: [ctx.storeA.id, ctx.storeB.id] }
        },
        select: { storeId: true }
      })
      expect(rows.map(row => row.storeId).sort()).toEqual([ctx.storeA.id, ctx.storeB.id].sort())
    })

    it('lets each role do what its permissions say', async () => {
      const asViewer = api(app, ctx.viewerA, ctx.storeA)
      const asAgent = api(app, ctx.agentA, ctx.storeA)

      expect((await asViewer.get(ApiRoutes.customers.list)).status).toBe(OK)
      expect((await asViewer.post(ApiRoutes.customers.list).send({ name: 'x' })).status).toBe(
        FORBIDDEN
      )
      const own = await create({ name: 'Para borrar' })
      const other = await create({ name: 'Para fusionar' })
      expect((await asAgent.delete(ApiRoutes.customers.byId(own.id))).status).toBe(FORBIDDEN)
      const merge = await asAgent
        .post(ApiRoutes.customers.merge(own.id))
        .send({ absorbedId: other.id })
      expect(merge.status).toBe(FORBIDDEN)
      // A refusal is a refusal before the action, not after it
      const rows = await owner.customer.findMany({
        where: { id: { in: [own.id, other.id] } },
        select: { mergedIntoId: true }
      })
      expect(rows).toEqual([{ mergedIntoId: null }, { mergedIntoId: null }])
    })
  })

  describe('listing and searching', () => {
    // Customers of a list that is ordered by age are seeded with an age of their own (a minute apart),
    // so that the order never depends on how fast the requests are
    async function seedByAge(storeId: string, names: string[]): Promise<string[]> {
      const base = Date.now() - 60 * 60_000
      const ids: string[] = []
      for (const [index, name] of names.entries()) {
        const row = await createCustomer(owner, {
          storeId,
          name,
          createdAt: new Date(base + index * 60_000)
        })
        ids.push(row.id)
      }
      return ids
    }

    it('pages by cursor, newest first, without repeating or skipping a customer', async () => {
      const asAdminA2 = api(app, ctx.adminA2, ctx.storeA2)
      await seedByAge(
        ctx.storeA2.id,
        [0, 1, 2, 3, 4].map(n => `Pagina ${n}`)
      )
      const page = (cursor?: string | null) =>
        asAdminA2
          .get(ApiRoutes.customers.list)
          .query({ q: 'Pagina', limit: 2, ...(cursor ? { cursor } : {}) })
          .then(response => response.body as PageBody)

      const first = await page()
      const second = await page(first.nextCursor)
      const third = await page(second.nextCursor)

      expect(first.hasMore).toBe(true)
      expect(second.hasMore).toBe(true)
      expect(third).toMatchObject({ hasMore: false, nextCursor: null })
      const names = [...first.data, ...second.data, ...third.data].map(row => row.name)
      expect(names).toEqual(['Pagina 4', 'Pagina 3', 'Pagina 2', 'Pagina 1', 'Pagina 0'])
    })

    it('refuses a cursor that the api did not give', async () => {
      const foreign = await createCustomer(owner, { storeId: ctx.storeB.id })

      for (const cursor of [foreign.id, randomUUID(), 'not-a-cursor']) {
        const response = await asAdmin().get(ApiRoutes.customers.list).query({ cursor })
        expect(response.status).toBe(BAD_REQUEST)
        expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
      }
    })

    it('goes on from a cursor whose customer was deleted or merged meanwhile', async () => {
      const asAdminA2 = api(app, ctx.adminA2, ctx.storeA2)
      await seedByAge(
        ctx.storeA2.id,
        [0, 1, 2, 3].map(n => `Borrado ${n}`)
      )
      const fusion = await seedByAge(
        ctx.storeA2.id,
        [0, 1, 2, 3].map(n => `Fusion ${n}`)
      )
      const page = (q: string, cursor?: string | null) =>
        asAdminA2
          .get(ApiRoutes.customers.list)
          .query({ q, limit: 2, ...(cursor ? { cursor } : {}) })
          .then(response => response.body as PageBody)

      // The last customer of the first page goes away before the second page is asked for
      const deletedPage = await page('Borrado')
      const gone = deletedPage.data[1]?.id ?? ''
      expect(deletedPage.data.map(row => row.name)).toEqual(['Borrado 3', 'Borrado 2'])
      expect((await asAdminA2.delete(ApiRoutes.customers.byId(gone))).status).toBe(NO_CONTENT)
      const afterDelete = await page('Borrado', deletedPage.nextCursor)

      // ...or is absorbed by a merge, into a customer of the same group
      const mergedPage = await page('Fusion')
      expect(mergedPage.data.map(row => row.name)).toEqual(['Fusion 3', 'Fusion 2'])
      const merged = await asAdminA2
        .post(ApiRoutes.customers.merge(fusion[0] ?? ''))
        .send({ absorbedId: mergedPage.data[1]?.id, fieldChoices: {} })
      expect(merged.status).toBe(OK)
      const afterMerge = await page('Fusion', mergedPage.nextCursor)

      expect(afterDelete.data.map(row => row.name)).toEqual(['Borrado 1', 'Borrado 0'])
      expect(afterMerge.data.map(row => row.name)).toEqual(['Fusion 1', 'Fusion 0'])
    })

    it('matches the digits of a phone only when the search looks like a phone number', async () => {
      await create({ name: 'Con tel 123', phone: '+503 7123-9999' })
      await create({ name: 'Calle 123 vecino' })

      const names = async (q: string): Promise<(string | null)[]> =>
        ((await asAdmin().get(ApiRoutes.customers.list).query({ q })).body as PageBody).data.map(
          row => row.name
        )

      expect(await names('Calle 123')).toEqual(['Calle 123 vecino'])
      expect(await names('7123-9999')).toEqual(['Con tel 123'])
      expect(await names('+503 7123-99')).toEqual(['Con tel 123'])
    })

    it('searches by name, e-mail or the digits of a phone, and treats _ and % as text', async () => {
      await create({ name: 'Zeta_Uno', email: 'zeta.uno@example.com', phone: '+503 7444-0001' })
      await create({ name: 'ZetaXUno' })
      await create({ name: '100% Zeta' })

      const names = async (q: string): Promise<(string | null)[]> =>
        ((await asAdmin().get(ApiRoutes.customers.list).query({ q })).body as PageBody).data.map(
          row => row.name
        )

      expect(await names('zeta_uno')).toEqual(['Zeta_Uno'])
      expect(await names('100%')).toEqual(['100% Zeta'])
      expect(await names('uno@example')).toEqual(['Zeta_Uno'])
      expect(await names('7444-0001')).toEqual(['Zeta_Uno'])
    })
  })

  describe('identities', () => {
    it('links a handle, refuses one that is taken and says whose it is', async () => {
      const ana = await create({ name: 'Ana I' })
      const bea = await create({ name: 'Bea I' })
      const link = (id: string, handle: string) =>
        asAdmin()
          .post(ApiRoutes.customers.identities(id))
          .send({ channelType: ChannelIds.WHATSAPP, channelIdentity: handle })

      const linked = await link(ana.id, '7333-0001')
      const taken = await link(bea.id, '+503 73330001')

      expect(linked.status).toBe(CREATED)
      expect((linked.body as { channelIdentity: string }).channelIdentity).toBe('50373330001')
      expect(taken.status).toBe(CONFLICT)
      expect((taken.body as ErrorBody).error.metadata).toMatchObject({ customerId: ana.id })
    })

    it('reads a handle as a phone when the plugin of a channel nobody named says so', async () => {
      const registry = app.get(PluginRegistry, { strict: false })
      registry.register(
        buildChannelPlugin({ id: 'acme_phone', identityKind: ChannelIdentityKinds.PHONE })
      )
      try {
        const ana = await create({ name: 'Ana P' })

        const linked = await asAdmin()
          .post(ApiRoutes.customers.identities(ana.id))
          .send({ channelType: 'acme_phone', channelIdentity: '+503 7333-0009' })
        // The inbound path reads it the same way: the same person is the same identity
        const inbound = await identities().findOrCreateByIdentity({
          storeId: ctx.storeA.id,
          channelType: 'acme_phone',
          channelIdentity: '503 7333 0009'
        })

        expect(linked.status).toBe(CREATED)
        expect((linked.body as { channelIdentity: string }).channelIdentity).toBe('50373330009')
        expect(inbound.created).toBe(false)
        expect(inbound.customerId).toBe(ana.id)
      } finally {
        registry.unregister('acme_phone')
      }
    })

    it('refuses a handle the channel could not have produced, naming the field like any other', async () => {
      const ana = await create({ name: 'Ana R' })

      const refused = await asAdmin()
        .post(ApiRoutes.customers.identities(ana.id))
        .send({ channelType: ChannelIds.WHATSAPP, channelIdentity: '12' })

      expect(refused.status).toBe(BAD_REQUEST)
      expect((refused.body as ErrorBody).error.code).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(JSON.stringify((refused.body as ErrorBody).error.metadata)).toContain(
        'channelIdentity'
      )
    })

    it('answers a link of a handle the customer already has with that identity', async () => {
      const ana = await create({ name: 'Ana L' })
      const link = () =>
        asAdmin()
          .post(ApiRoutes.customers.identities(ana.id))
          .send({ channelType: ChannelIds.INSTAGRAM, channelIdentity: 'ana_l' })

      const first = await link()
      const again = await link()

      expect(first.status).toBe(CREATED)
      expect(again.status).toBe(OK)
      expect((again.body as { id: string }).id).toBe((first.body as { id: string }).id)
    })

    it('refuses a handle the channel could not have produced', async () => {
      const ana = await create({ name: 'Ana J' })
      const response = await asAdmin()
        .post(ApiRoutes.customers.identities(ana.id))
        .send({ channelType: ChannelIds.WHATSAPP, channelIdentity: 'not a phone' })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('unlinks an identity unless a conversation points to it', async () => {
      const ana = await create({ name: 'Ana K' })
      const identity = (
        await asAdmin()
          .post(ApiRoutes.customers.identities(ana.id))
          .send({ channelType: ChannelIds.INSTAGRAM, channelIdentity: 'ana_k' })
      ).body as { id: string }
      const conversation = await createConversation(owner, {
        storeId: ctx.storeA.id,
        customerId: ana.id,
        customerIdentityId: identity.id,
        channelType: ChannelIds.INSTAGRAM
      })

      const blocked = await asAdmin().delete(ApiRoutes.customers.identityById(ana.id, identity.id))
      await owner.conversation.delete({ where: { id: conversation.id } })
      const freed = await asAdmin().delete(ApiRoutes.customers.identityById(ana.id, identity.id))

      expect(blocked.status).toBe(CONFLICT)
      // A rule, not a race: the interface must not tell the agent that someone changed it
      expect((blocked.body as ErrorBody).error.code).toBe(
        ErrorCodes.CUSTOMER_IDENTITY_HAS_CONVERSATIONS
      )
      expect(freed.status).toBe(NO_CONTENT)
    })
  })

  describe('findOrCreateByIdentity', () => {
    const resolve = (storeId: string, handle: string, displayName?: string) =>
      identities().findOrCreateByIdentity({
        storeId,
        channelType: ChannelIds.WHATSAPP,
        channelIdentity: handle,
        profile: displayName === undefined ? undefined : { displayName }
      })

    it('creates the customer with the number the handle carries, and finds it afterwards', async () => {
      const first = await resolve(ctx.storeA.id, '50370001111', 'Hugo')
      const again = await resolve(ctx.storeA.id, '+503 7000-1111')

      expect(first.created).toBe(true)
      expect(again).toMatchObject({
        created: false,
        customerId: first.customerId,
        identityId: first.identityId
      })
      const row = await owner.customer.findUnique({ where: { id: first.customerId } })
      expect(row).toMatchObject({
        name: 'Hugo',
        phone: '+503 7000 1111',
        phoneNormalized: '50370001111'
      })
    })

    it('ends in one customer when the same new handle arrives many times at once', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => resolve(ctx.storeA.id, '50370002222'))
      )

      expect(new Set(results.map(result => result.customerId)).size).toBe(1)
      expect(results.filter(result => result.created)).toHaveLength(1)
      expect(
        await owner.customer.count({
          where: { storeId: ctx.storeA.id, phoneNormalized: '50370002222' }
        })
      ).toBe(1)
    })

    it('does not let the same handle in two stores meet', async () => {
      const here = await resolve(ctx.storeA.id, '50370003333')
      const there = await resolve(ctx.storeB.id, '50370003333')

      expect(there.customerId).not.toBe(here.customerId)
      expect(there.identityId).not.toBe(here.identityId)
      // Each store has its own identity row, in its own store, for its own customer
      const rows = await owner.customerIdentity.findMany({
        where: { channelIdentity: '50370003333', storeId: { in: [ctx.storeA.id, ctx.storeB.id] } },
        select: { id: true, storeId: true, customerId: true }
      })
      expect(rows).toHaveLength(2)
      expect(rows).toContainEqual({
        id: here.identityId,
        storeId: ctx.storeA.id,
        customerId: here.customerId
      })
      expect(rows).toContainEqual({
        id: there.identityId,
        storeId: ctx.storeB.id,
        customerId: there.customerId
      })
    })

    describe('the contact data a person typed in a form', () => {
      const widget = (storeId: string, visitor: string, profile?: ChannelProfile) =>
        identities().findOrCreateByIdentity({
          storeId,
          channelType: ChannelIds.WEB_WIDGET,
          channelIdentity: visitor,
          profile
        })

      it('is kept on the new customer, the address in lower case and the phone with its country code', async () => {
        const visitor = randomUUID()

        const result = await widget(ctx.storeA.id, visitor, {
          displayName: 'Ana',
          email: ' Ana@Example.COM ',
          phone: '7000 2222'
        })

        const row = await owner.customer.findUniqueOrThrow({ where: { id: result.customerId } })
        expect(row).toMatchObject({
          name: 'Ana',
          email: 'ana@example.com',
          phoneNormalized: '50370002222'
        })
      })

      it('drops an address or a number that cannot be read, and keeps the rest', async () => {
        const result = await widget(ctx.storeA.id, randomUUID(), {
          displayName: 'Beto',
          email: 'not an address',
          phone: 'abc'
        })

        const row = await owner.customer.findUniqueOrThrow({ where: { id: result.customerId } })
        expect(row).toMatchObject({ name: 'Beto', email: null, phone: null, phoneNormalized: null })
      })

      it('fills a blank of the customer later and never replaces what is there', async () => {
        const visitor = randomUUID()
        const first = await widget(ctx.storeA.id, visitor, { displayName: 'Carla' })

        await widget(ctx.storeA.id, visitor, { email: 'carla@example.com', phone: '7000 3333' })
        await widget(ctx.storeA.id, visitor, { email: 'other@example.com', phone: '7000 4444' })

        const row = await owner.customer.findUniqueOrThrow({ where: { id: first.customerId } })
        expect(row).toMatchObject({ email: 'carla@example.com', phoneNormalized: '50370003333' })
      })

      it('never links a visitor to the customer who has that address: nobody proved it was theirs', async () => {
        const owned = await owner.customer.create({
          data: { storeId: ctx.storeA.id, name: 'Dueña', email: 'duena@example.com' }
        })

        const stranger = await widget(ctx.storeA.id, randomUUID(), {
          displayName: 'Intruso',
          email: 'duena@example.com'
        })

        expect(stranger.customerId).not.toBe(owned.id)
        expect(stranger.created).toBe(true)
        const untouched = await owner.customer.findUniqueOrThrow({ where: { id: owned.id } })
        expect(untouched).toMatchObject({ name: 'Dueña', email: 'duena@example.com' })
        expect(await owner.customerIdentity.count({ where: { customerId: owned.id } })).toBe(0)
      })
    })

    it('does not trust the profile a channel sends', async () => {
      const blank = await identities().findOrCreateByIdentity({
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WHATSAPP,
        channelIdentity: '50370006666',
        profile: { displayName: '   ', locale: 'x$' }
      })
      const long = await identities().findOrCreateByIdentity({
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WHATSAPP,
        channelIdentity: '50370007777',
        profile: { displayName: 'N'.repeat(10_000) }
      })
      // A later event without a usable name does not erase the one the identity has
      await identities().findOrCreateByIdentity({
        storeId: ctx.storeA.id,
        channelType: ChannelIds.WHATSAPP,
        channelIdentity: '50370007777',
        profile: { displayName: '' }
      })

      const blankRow = await owner.customer.findUniqueOrThrow({ where: { id: blank.customerId } })
      const longRow = await owner.customer.findUniqueOrThrow({ where: { id: long.customerId } })
      const identity = await owner.customerIdentity.findUniqueOrThrow({
        where: { id: long.identityId }
      })
      expect(blankRow).toMatchObject({ name: null, locale: null })
      expect(longRow.name).toHaveLength(120)
      expect(identity.displayName).toHaveLength(120)
    })

    it('copes with the characters Postgres cannot store and the pair of an emoji cut in two', async () => {
      const named = async (handle: string, displayName: string) => {
        const resolved = await identities().findOrCreateByIdentity({
          storeId: ctx.storeA.id,
          channelType: ChannelIds.WHATSAPP,
          channelIdentity: handle,
          profile: { displayName, locale: 'es-AAAAAAAA-BBBBBBBB' }
        })
        return owner.customer.findUniqueOrThrow({ where: { id: resolved.customerId } })
      }

      const nul = await named('50370008888', 'Ana\u0000')
      // 119 letters and two emoji: cut by characters, the first emoji still fits
      const emoji = await named('50370009999', `${'a'.repeat(119)}\u{1F600}\u{1F600}`)
      // Half of an emoji, which nothing can store, is dropped
      const half = await named('50370009998', 'Bea\uD83D')

      expect(nul.name).toBe('Ana')
      expect(emoji.name).toBe(`${'a'.repeat(119)}\u{1F600}`)
      expect(half.name).toBe('Bea')
      expect(emoji.locale).toBeNull()
    })

    it('keeps the phone of the customer equal to the handle of its identity', async () => {
      const resolved = await resolve(ctx.storeA.id, '525512345678')

      const customer = await owner.customer.findUniqueOrThrow({
        where: { id: resolved.customerId }
      })
      const identity = await owner.customerIdentity.findUniqueOrThrow({
        where: { id: resolved.identityId }
      })
      expect(customer.phoneNormalized).toBe(identity.channelIdentity)
    })

    it('refuses a handle that is not valid for the channel', async () => {
      await expect(resolve(ctx.storeA.id, 'abc')).rejects.toMatchObject({
        code: ErrorCodes.VALIDATION_INVALID_INPUT
      })
    })
  })

  describe('addresses, notes and tags', () => {
    it('keeps one default address, and gives the default to another when it is deleted', async () => {
      const customer = await create({ name: 'Dir' })
      const add = async (line1: string, isDefault?: boolean) =>
        (
          await asAdmin()
            .post(ApiRoutes.customers.addresses(customer.id))
            .send({
              line1,
              city: 'San Salvador',
              ...(isDefault === undefined ? {} : { isDefault })
            })
        ).body as { id: string; isDefault: boolean }

      const first = await add('Calle 1')
      const second = await add('Calle 2')
      const third = await add('Calle 3', true)

      expect([first.isDefault, second.isDefault, third.isDefault]).toEqual([true, false, true])
      const defaults = async () =>
        (await owner.address.findMany({ where: { customerId: customer.id, isDefault: true } })).map(
          row => row.id
        )
      expect(await defaults()).toEqual([third.id])

      const removed = await asAdmin().delete(ApiRoutes.customers.addressById(customer.id, third.id))
      expect(removed.status).toBe(NO_CONTENT)
      expect(await defaults()).toEqual([first.id])
    })

    it('keeps a default address when the default one is told it is not', async () => {
      const customer = await create({ name: 'Dir 2' })
      const add = async (line1: string) =>
        (
          await asAdmin()
            .post(ApiRoutes.customers.addresses(customer.id))
            .send({ line1, city: 'San Miguel' })
        ).body as { id: string }
      const first = await add('Calle A')
      const second = await add('Calle B')

      await asAdmin()
        .patch(ApiRoutes.customers.addressById(customer.id, first.id))
        .send({ isDefault: false })

      const defaults = await owner.address.findMany({
        where: { customerId: customer.id, isDefault: true }
      })
      expect(defaults.map(row => row.id)).toEqual([second.id])
    })

    it('adds, lists and deletes a note, recording who wrote it', async () => {
      const customer = await create({ name: 'Nota' })
      const created = await asAdmin()
        .post(ApiRoutes.customers.notes(customer.id))
        .send({ content: 'Cliente VIP' })
      const listed = await asAdmin().get(ApiRoutes.customers.notes(customer.id))

      expect(created.status).toBe(CREATED)
      expect((created.body as { authorId: string }).authorId).toBe(ctx.adminA.id)
      expect((listed.body as { content: string }[]).map(note => note.content)).toEqual([
        'Cliente VIP'
      ])
      const id = (created.body as { id: string }).id
      expect((await asAdmin().delete(ApiRoutes.customers.noteById(customer.id, id))).status).toBe(
        NO_CONTENT
      )
      expect((await asAdmin().delete(ApiRoutes.customers.noteById(customer.id, id))).status).toBe(
        NOT_FOUND
      )
    })

    it('lets a note be deleted by its author or by who may delete customers, and records it', async () => {
      const customer = await create({ name: 'Notas ajenas' })
      const otherAgent = await createActor(owner, app, {
        prefix,
        name: 'second-agent',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      const write = async (who: typeof ctx.agentA): Promise<string> =>
        (
          (
            await api(app, who, ctx.storeA)
              .post(ApiRoutes.customers.notes(customer.id))
              .send({ content: `de ${who.email}` })
          ).body as { id: string }
        ).id
      const remove = (who: typeof ctx.agentA, noteId: string) =>
        api(app, who, ctx.storeA).delete(ApiRoutes.customers.noteById(customer.id, noteId))
      const byAgent = await write(ctx.agentA)
      const byAgentToo = await write(ctx.agentA)

      const stranger = await remove(otherAgent, byAgent)
      const author = await remove(ctx.agentA, byAgent)
      const admin = await remove(ctx.adminA, byAgentToo)

      expect(stranger.status).toBe(FORBIDDEN)
      expect((stranger.body as ErrorBody).error.code).toBe(ErrorCodes.PERMISSION_DENIED)
      expect(author.status).toBe(NO_CONTENT)
      expect(admin.status).toBe(NO_CONTENT)
      const entries = await waitForAuditEntries(
        owner,
        { action: AuditAction.CUSTOMER_NOTE_DELETED, resourceId: customer.id },
        2
      )
      expect(entries.map(entry => entry.userId).sort()).toEqual(
        [ctx.agentA.id, ctx.adminA.id].sort()
      )
    })

    it('attaches a tag of the store, twice without harm, and detaches it', async () => {
      const customer = await create({ name: 'Etiqueta' })
      const tag = await createTag(owner, { storeId: ctx.storeA.id })
      const foreign = await createTag(owner, { storeId: ctx.storeB.id })
      const attach = (tagId: string) =>
        asAdmin().post(ApiRoutes.customers.tags(customer.id)).send({ tagId })

      const once = await attach(tag.id)
      const twice = await attach(tag.id)
      const other = await attach(foreign.id)
      const tagsOf = async (): Promise<string[]> =>
        (
          await owner.customer.findUniqueOrThrow({
            where: { id: customer.id },
            select: { tags: { select: { id: true } } }
          })
        ).tags.map(row => row.id)

      expect((once.body as { id: string }[]).map(row => row.id)).toEqual([tag.id])
      expect(twice.status).toBe(OK)
      expect((twice.body as { id: string }[]).map(row => row.id)).toEqual([tag.id])
      expect(other.status).toBe(NOT_FOUND)
      // The tag is on the customer once, and the tag of the other store was never attached
      expect(await tagsOf()).toEqual([tag.id])
      expect(
        (await asAdmin().delete(ApiRoutes.customers.tagById(customer.id, tag.id))).status
      ).toBe(NO_CONTENT)
      const detail = await asAdmin().get(ApiRoutes.customers.byId(customer.id))
      expect((detail.body as CustomerBody).tags).toEqual([])
    })
  })

  describe('deleting', () => {
    it('keeps the survivor of a merge that can still be undone', async () => {
      const survivor = await create({ name: 'Sobreviviente' })
      const absorbed = await create({ name: 'Absorbido' })
      await asAdmin()
        .post(ApiRoutes.customers.merge(survivor.id))
        .send({ absorbedId: absorbed.id, fieldChoices: {} })

      const response = await asAdmin().delete(ApiRoutes.customers.byId(survivor.id))

      expect(response.status).toBe(CONFLICT)
      expect(await owner.customer.findUnique({ where: { id: absorbed.id } })).not.toBeNull()
    })

    it('deletes the survivor of a merge once the time to undo it has passed', async () => {
      const survivor = await create({ name: 'Sobreviviente viejo' })
      const absorbed = await create({ name: 'Absorbido viejo' })
      await asAdmin()
        .post(ApiRoutes.customers.merge(survivor.id))
        .send({ absorbedId: absorbed.id, fieldChoices: {} })
      await owner.customerMerge.updateMany({
        where: { survivorId: survivor.id },
        data: { unmergeUntil: new Date(Date.now() - 86_400_000) }
      })

      const response = await asAdmin().delete(ApiRoutes.customers.byId(survivor.id))

      expect(response.status).toBe(NO_CONTENT)
    })

    it('says on each identity, and on each conversation of the customer, whether its channel has anonymous customers', async () => {
      const customer = await create({ name: 'Mixto' })
      const visitor = await owner.customerIdentity.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: customer.id,
          channelType: ChannelIds.WEB_WIDGET,
          channelIdentity: `${prefix}-anon`
        }
      })
      await owner.customerIdentity.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: customer.id,
          channelType: ChannelIds.MESSENGER,
          channelIdentity: `${prefix}-named`
        }
      })
      const conversation = await createConversation(owner, {
        storeId: ctx.storeA.id,
        customerId: customer.id,
        customerIdentityId: visitor.id,
        channelType: ChannelIds.WEB_WIDGET
      })

      const detail = await asAdmin().get(ApiRoutes.customers.byId(customer.id))
      const listed = await asAdmin().get(ApiRoutes.customers.conversations(customer.id))
      const single = await asAdmin().get(ApiRoutes.conversations.byId(conversation.id))
      const inbox = await asAdmin().get(ApiRoutes.conversations.list)

      const flags = Object.fromEntries(
        (
          detail.body as { identities: { channelType: string; anonymousCustomers: boolean }[] }
        ).identities.map(identity => [identity.channelType, identity.anonymousCustomers])
      )
      expect(flags).toEqual({ [ChannelIds.WEB_WIDGET]: true, [ChannelIds.MESSENGER]: false })
      expect(
        (listed.body as { data: { anonymousCustomers: boolean }[] }).data.map(
          row => row.anonymousCustomers
        )
      ).toEqual([true])
      expect((single.body as { anonymousCustomers: boolean }).anonymousCustomers).toBe(true)
      expect(
        (inbox.body as { data: { id: string; anonymousCustomers: boolean }[] }).data.find(
          row => row.id === conversation.id
        )?.anonymousCustomers
      ).toBe(true)
    })

    it('deletes a customer with no history and keeps one that has conversations', async () => {
      const alone = await create({ name: 'Solo' })
      const withHistory = await create({ name: 'Con historia' })
      const identity = await owner.customerIdentity.create({
        data: {
          storeId: ctx.storeA.id,
          customerId: withHistory.id,
          channelType: ChannelIds.WEB_WIDGET,
          channelIdentity: `${prefix}-visitor`
        }
      })
      await createConversation(owner, {
        storeId: ctx.storeA.id,
        customerId: withHistory.id,
        customerIdentityId: identity.id,
        channelType: ChannelIds.WEB_WIDGET
      })

      const removed = await asAdmin().delete(ApiRoutes.customers.byId(alone.id))
      const kept = await asAdmin().delete(ApiRoutes.customers.byId(withHistory.id))

      expect(removed.status).toBe(NO_CONTENT)
      expect(kept.status).toBe(CONFLICT)
      expect(await owner.customer.findUnique({ where: { id: alone.id } })).toBeNull()
      expect(await owner.customer.findUnique({ where: { id: withHistory.id } })).not.toBeNull()
      const [audit] = await waitForAuditEntries(owner, {
        action: AuditAction.CUSTOMER_DELETED,
        resourceId: alone.id
      })
      expect(audit?.userId).toBe(ctx.adminA.id)
    })
  })
})
