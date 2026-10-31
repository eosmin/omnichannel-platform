import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { type Permission, Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { SettingsLimits } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createRole, createSnippet, createTag } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: Record<string, unknown> }
}
interface TagBody {
  id: string
  name: string
  color: string
  description: string | null
}
interface SnippetBody {
  id: string
  shortcut: string
  title: string
  content: string
}
interface HoursBody {
  timezone: string
  schedule: Record<string, { from: string; to: string }[]>
  awayMessageSnippetId: string | null
}

const OK = 200
const CREATED = 201
const NO_CONTENT = 204
const BAD_REQUEST = 400
const FORBIDDEN = 403
const NOT_FOUND = 404
const CONFLICT = 409

const CLOSED_WEEK = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] }

describe('The settings of the inbox of a store', () => {
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
  const asAgent = () => api(app, ctx.agentA, ctx.storeA)
  const asViewer = () => api(app, ctx.viewerA, ctx.storeA)
  const codeOf = (body: unknown) => (body as ErrorBody).error.code

  async function newTag(name: string): Promise<TagBody> {
    const response = await asAdmin().post(ApiRoutes.settings.tags).send({ name })
    expect(response.status).toBe(CREATED)
    return response.body as TagBody
  }

  async function newSnippet(shortcut: string): Promise<SnippetBody> {
    const response = await asAdmin()
      .post(ApiRoutes.settings.snippets)
      .send({ shortcut, title: 'Title', content: 'Content' })
    expect(response.status).toBe(CREATED)
    return response.body as SnippetBody
  }

  describe('tags', () => {
    it('creates one in the store of the request, with the default color, and audits it', async () => {
      const tag = await newTag(`${prefix}-vip`)

      expect(tag.color).toBe('#8b5cf6')
      expect(tag.description).toBeNull()
      const row = await owner.tag.findUniqueOrThrow({ where: { id: tag.id } })
      expect(row.storeId).toBe(ctx.storeA.id)
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.SETTINGS_CHANGED,
        resourceId: tag.id,
        resourceType: 'tag'
      })
      expect(entry?.storeId).toBe(ctx.storeA.id)
      expect(entry?.userId).toBe(ctx.adminA.id)
    })

    it('keeps a color in lower case and refuses one that is not #rrggbb', async () => {
      const ok = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-color`, color: '#AABBCC' })
      const bad = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-bad-color`, color: 'red' })

      expect((ok.body as TagBody).color).toBe('#aabbcc')
      expect(bad.status).toBe(BAD_REQUEST)
      expect(codeOf(bad.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('refuses a name that another tag has, whatever its case, and holds when two ask at once', async () => {
      await newTag(`${prefix}-Dup`)

      const again = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-dUP` })
      const race = await Promise.all(
        [1, 2].map(() =>
          asAdmin()
            .post(ApiRoutes.settings.tags)
            .send({ name: `${prefix}-race` })
        )
      )

      expect(again.status).toBe(CONFLICT)
      expect(codeOf(again.body)).toBe(ErrorCodes.RESOURCE_ALREADY_EXISTS)
      expect(race.map(response => response.status).sort()).toEqual([CREATED, CONFLICT])
    })

    it('lists the tags of the store by name, and only of the store', async () => {
      await createTag(owner, { storeId: ctx.storeB.id, name: `${prefix}-other-store` })
      await newTag(`${prefix}-b-list`)
      await newTag(`${prefix}-a-list`)

      const response = await asViewer().get(ApiRoutes.settings.tags)

      expect(response.status).toBe(OK)
      const names = (response.body as TagBody[]).map(tag => tag.name)
      expect(names).not.toContain(`${prefix}-other-store`)
      expect(names).toContain(`${prefix}-a-list`)
      expect(names).toContain(`${prefix}-b-list`)
      expect(names.indexOf(`${prefix}-a-list`)).toBeLessThan(names.indexOf(`${prefix}-b-list`))
    })

    it('renames and recolors one, clears the description with null, and refuses an empty change', async () => {
      const tag = await newTag(`${prefix}-edit`)
      const described = await asAdmin()
        .patch(ApiRoutes.settings.tagById(tag.id))
        .send({ description: 'first' })
      expect((described.body as TagBody).description).toBe('first')

      const changed = await asAdmin()
        .patch(ApiRoutes.settings.tagById(tag.id))
        .send({ name: `${prefix}-edited`, color: '#112233', description: null })
      const empty = await asAdmin().patch(ApiRoutes.settings.tagById(tag.id)).send({})

      expect(changed.body).toMatchObject({
        name: `${prefix}-edited`,
        color: '#112233',
        description: null
      })
      expect(empty.status).toBe(BAD_REQUEST)
    })

    it('lets a tag change only its case, and refuses a rename to the name of another', async () => {
      const first = await newTag(`${prefix}-first`)
      await newTag(`${prefix}-second`)

      const recased = await asAdmin()
        .patch(ApiRoutes.settings.tagById(first.id))
        .send({ name: `${prefix}-FIRST` })
      const taken = await asAdmin()
        .patch(ApiRoutes.settings.tagById(first.id))
        .send({ name: `${prefix}-Second` })

      expect(recased.status).toBe(OK)
      expect((recased.body as TagBody).name).toBe(`${prefix}-FIRST`)
      expect(taken.status).toBe(CONFLICT)
    })

    it('deletes one and takes it off the customers that had it', async () => {
      const tag = await newTag(`${prefix}-gone`)
      const customer = await owner.customer.create({
        data: { storeId: ctx.storeA.id, name: 'Tagged', tags: { connect: { id: tag.id } } }
      })

      const response = await asAdmin().delete(ApiRoutes.settings.tagById(tag.id))

      expect(response.status).toBe(NO_CONTENT)
      expect(await owner.tag.count({ where: { id: tag.id } })).toBe(0)
      const after = await owner.customer.findUniqueOrThrow({
        where: { id: customer.id },
        select: { tags: true }
      })
      expect(after.tags).toEqual([])
      expect((await asAdmin().delete(ApiRoutes.settings.tagById(tag.id))).status).toBe(NOT_FOUND)
    })

    it('refuses the tag that passes the limit of the store, and a store with room is not affected', async () => {
      const full = api(app, ctx.adminA2, ctx.storeA2)
      await owner.tag.createMany({
        data: Array.from({ length: SettingsLimits.MAX_TAGS_PER_STORE }, (_, i) => ({
          storeId: ctx.storeA2.id,
          name: `${prefix}-fill-${i}`,
          color: '#000000'
        }))
      })

      const over = await full.post(ApiRoutes.settings.tags).send({ name: `${prefix}-over` })
      const elsewhere = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-room` })

      expect(over.status).toBe(CONFLICT)
      expect(codeOf(over.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect((over.body as ErrorBody).error.metadata).toEqual({
        limit: SettingsLimits.MAX_TAGS_PER_STORE
      })
      expect(elsewhere.status).toBe(CREATED)
    })

    it('can be read by who works the inbox but changed only with SETTINGS_EDIT', async () => {
      const tag = await newTag(`${prefix}-perm`)

      const read = await asAgent().get(ApiRoutes.settings.tagById(tag.id))
      const create = await asAgent()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-no` })
      const update = await asAgent()
        .patch(ApiRoutes.settings.tagById(tag.id))
        .send({ name: `${prefix}-no` })
      const remove = await asAgent().delete(ApiRoutes.settings.tagById(tag.id))

      expect(read.status).toBe(OK)
      for (const response of [create, update, remove]) {
        expect(response.status).toBe(FORBIDDEN)
        expect(codeOf(response.body)).toBe(ErrorCodes.PERMISSION_DENIED)
      }
    })
  })

  describe('snippets', () => {
    it('creates one with the shortcut in lower case, written by the user', async () => {
      const snippet = await newSnippet(`${prefix}-Gracias`)

      expect(snippet.shortcut).toBe(`${prefix}-gracias`)
      // The author is kept, and not handed to everybody who reads the list
      expect(snippet).not.toHaveProperty('createdBy')
      const row = await owner.snippet.findUniqueOrThrow({ where: { id: snippet.id } })
      expect(row.createdBy).toBe(ctx.adminA.id)
    })

    it('refuses the snippet that passes the limit of the store', async () => {
      await owner.snippet.createMany({
        data: Array.from({ length: SettingsLimits.MAX_SNIPPETS_PER_STORE }, (_, i) => ({
          storeId: ctx.storeB.id,
          shortcut: `${prefix}-fill-${i}`,
          title: 't',
          content: 'c',
          createdBy: ctx.adminB.id
        }))
      })

      const over = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-over`, title: 't', content: 'c' })

      expect(over.status).toBe(CONFLICT)
      expect((over.body as ErrorBody).error.metadata).toEqual({
        limit: SettingsLimits.MAX_SNIPPETS_PER_STORE
      })
    })

    it('refuses a shortcut with a space or a slash, and one that is taken', async () => {
      await newSnippet(`${prefix}-taken`)

      const spaced = await asAdmin()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: 'two words', title: 't', content: 'c' })
      const slashed = await asAdmin()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: '/slash', title: 't', content: 'c' })
      const taken = await asAdmin()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-TAKEN`, title: 't', content: 'c' })

      expect(spaced.status).toBe(BAD_REQUEST)
      expect(slashed.status).toBe(BAD_REQUEST)
      expect(taken.status).toBe(CONFLICT)
      expect(codeOf(taken.body)).toBe(ErrorCodes.RESOURCE_ALREADY_EXISTS)
    })

    it('edits one, and lists the snippets of the store only', async () => {
      await createSnippet(owner, { storeId: ctx.storeB.id, shortcut: `${prefix}-theirs` })
      const snippet = await newSnippet(`${prefix}-edit`)

      const changed = await asAdmin()
        .patch(ApiRoutes.settings.snippetById(snippet.id))
        .send({ content: 'New text' })
      const list = await asAgent().get(ApiRoutes.settings.snippets)

      expect((changed.body as SnippetBody).content).toBe('New text')
      const shortcuts = (list.body as SnippetBody[]).map(item => item.shortcut)
      expect(shortcuts).toContain(`${prefix}-edit`)
      expect(shortcuts).not.toContain(`${prefix}-theirs`)
    })

    it('refuses to delete the one the settings use, and deletes it once they do not', async () => {
      const closing = await newSnippet(`${prefix}-closing`)
      const away = await newSnippet(`${prefix}-away`)
      const pointed = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ closingSnippetId: closing.id })
      const awayed = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: away.id })
      expect([pointed.status, awayed.status]).toEqual([OK, OK])

      const usedAsClosing = await asAdmin().delete(ApiRoutes.settings.snippetById(closing.id))
      const usedAsAway = await asAdmin().delete(ApiRoutes.settings.snippetById(away.id))

      expect(usedAsClosing.status).toBe(CONFLICT)
      expect(codeOf(usedAsClosing.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect((usedAsClosing.body as ErrorBody).error.metadata).toEqual({
        usedAsClosingMessage: true,
        usedAsAwayMessage: false
      })
      expect(usedAsAway.status).toBe(CONFLICT)

      const unpointed = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ closingSnippetId: null })
      const unawayed = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: null })
      expect([unpointed.status, unawayed.status]).toEqual([OK, OK])
      const freed = await asAdmin().delete(ApiRoutes.settings.snippetById(closing.id))
      const freedAway = await asAdmin().delete(ApiRoutes.settings.snippetById(away.id))
      expect([freed.status, freedAway.status]).toEqual([NO_CONTENT, NO_CONTENT])
    })

    it('can be changed only with SETTINGS_EDIT', async () => {
      const snippet = await newSnippet(`${prefix}-perm`)

      const create = await asAgent()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-no`, title: 't', content: 'c' })
      const remove = await asAgent().delete(ApiRoutes.settings.snippetById(snippet.id))

      expect(create.status).toBe(FORBIDDEN)
      expect(remove.status).toBe(FORBIDDEN)
    })
  })

  describe('business hours', () => {
    it('answers 404 for a store that never set them, and returns what was put', async () => {
      expect(
        (await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.settings.businessHours)).status
      ).toBe(NOT_FOUND)

      const put = await api(app, ctx.adminA2, ctx.storeA2)
        .put(ApiRoutes.settings.businessHours)
        .send({
          timezone: 'America/El_Salvador',
          schedule: {
            ...CLOSED_WEEK,
            mon: [
              { from: '13:00', to: '18:00' },
              { from: '08:00', to: '12:00' }
            ]
          },
          awayMessageSnippetId: null
        })
      const read = await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.settings.businessHours)

      expect(put.status).toBe(OK)
      // The ranges of a day come back in order
      expect((read.body as HoursBody).schedule['mon']).toEqual([
        { from: '08:00', to: '12:00' },
        { from: '13:00', to: '18:00' }
      ])
      expect((read.body as HoursBody).timezone).toBe('America/El_Salvador')
    })

    it.each([
      [
        'ranges that overlap',
        {
          mon: [
            { from: '08:00', to: '12:00' },
            { from: '11:00', to: '13:00' }
          ]
        }
      ],
      ['a range that ends before it starts', { mon: [{ from: '12:00', to: '08:00' }] }],
      ['a time that is not HH:mm', { mon: [{ from: '8am', to: '12:00' }] }],
      ['a day that is not a day', { funday: [] }]
    ])('refuses %s', async (_label, change) => {
      const response = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({
          timezone: 'UTC',
          schedule: { ...CLOSED_WEEK, ...change },
          awayMessageSnippetId: null
        })

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('refuses a timezone that does not exist, and an away snippet of another store', async () => {
      const foreign = await createSnippet(owner, { storeId: ctx.storeB.id })

      const timezone = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone: 'Mars/Olympus', schedule: CLOSED_WEEK, awayMessageSnippetId: null })
      const snippet = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: foreign.id })

      expect(timezone.status).toBe(BAD_REQUEST)
      expect(snippet.status).toBe(NOT_FOUND)
    })

    it('is read with SETTINGS_VIEW and changed with SETTINGS_EDIT', async () => {
      const write = await asAgent()
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: null })
      const read = await asAgent().get(ApiRoutes.settings.businessHours)

      expect(write.status).toBe(FORBIDDEN)
      expect(read.status).toBe(FORBIDDEN)
    })
  })

  describe('the behavior of the inbox read by who works it', () => {
    it('reads back what the settings of the store say', async () => {
      const snippet = await newSnippet(`${prefix}-bye`)
      await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ resolveShowOptions: false, sendClosingMessage: true, closingSnippetId: snippet.id })

      const response = await asAdmin().get(ApiRoutes.settings.inboxBehavior)
      // The settings of this store go back to what the other cases expect
      await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ sendClosingMessage: false, closingSnippetId: null, resolveShowOptions: true })

      expect(response.body).toMatchObject({
        resolveShowOptions: false,
        sendClosingMessage: true,
        closingSnippetId: snippet.id
      })
    })

    it('gives an agent how resolving behaves and the timezone, and nothing else of the settings', async () => {
      const response = await asAgent().get(ApiRoutes.settings.inboxBehavior)

      expect(response.status).toBe(OK)
      expect(Object.keys(response.body as object).sort()).toEqual([
        'closingSnippetId',
        'resolveShowOptions',
        'sendClosingMessage',
        'timezone'
      ])
      const store = await owner.store.findUniqueOrThrow({ where: { id: ctx.storeA.id } })
      expect((response.body as { timezone: string }).timezone).toBe(store.timezone)
    })
  })

  describe('the behavior of the inbox', () => {
    it('starts with the defaults of the store and changes only what the body says', async () => {
      const before = await api(app, ctx.adminA2, ctx.storeA2).get(ApiRoutes.settings.inbox)
      const after = await api(app, ctx.adminA2, ctx.storeA2)
        .patch(ApiRoutes.settings.inbox)
        .send({ reopenWindowDays: 14, requestCsat: true })

      expect(before.body).toEqual({
        reopenWindowDays: null,
        autoArchiveAfterDays: 30,
        resolveShowOptions: true,
        sendClosingMessage: false,
        closingSnippetId: null,
        requestCsat: false,
        agentLoadThreshold: 8
      })
      expect(after.body).toMatchObject({
        reopenWindowDays: 14,
        requestCsat: true,
        autoArchiveAfterDays: 30
      })
      const [entry] = await waitForAuditEntries(owner, {
        action: AuditAction.SETTINGS_CHANGED,
        resourceId: ctx.storeA2.id,
        resourceType: 'store_settings'
      })
      expect(entry?.metadata).toMatchObject({ fields: ['reopenWindowDays', 'requestCsat'] })
    })

    it('takes the window off again with null', async () => {
      const set = await asAdmin().patch(ApiRoutes.settings.inbox).send({ reopenWindowDays: 3 })
      const cleared = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ reopenWindowDays: null })

      expect(set.body).toMatchObject({ reopenWindowDays: 3 })
      expect(cleared.body).toMatchObject({ reopenWindowDays: null })
    })

    it.each([
      ['a window of zero days', { reopenWindowDays: 0 }],
      ['a fraction of a day', { autoArchiveAfterDays: 1.5 }],
      ['more than a year', { autoArchiveAfterDays: 366 }],
      ['a threshold of zero', { agentLoadThreshold: 0 }],
      ['a field it does not have', { safety: {} }],
      ['a store in the body', { storeId: 'x' }],
      ['nothing', {}]
    ])('refuses %s', async (_label, body) => {
      const response = await asAdmin().patch(ApiRoutes.settings.inbox).send(body)

      expect(response.status).toBe(BAD_REQUEST)
      expect(codeOf(response.body)).toBe(ErrorCodes.VALIDATION_FAILED)
    })

    it('refuses a closing snippet of another store', async () => {
      const foreign = await createSnippet(owner, { storeId: ctx.storeB.id })

      const response = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ closingSnippetId: foreign.id })

      expect(response.status).toBe(NOT_FOUND)
    })

    it('is read with SETTINGS_VIEW and changed with SETTINGS_EDIT', async () => {
      const read = await asAdmin().get(ApiRoutes.settings.inbox)
      const readByViewer = await asViewer().get(ApiRoutes.settings.inbox)
      const write = await asAgent().patch(ApiRoutes.settings.inbox).send({ requestCsat: true })

      expect(read.status).toBe(OK)
      expect(readByViewer.status).toBe(FORBIDDEN)
      expect(write.status).toBe(FORBIDDEN)
    })
  })
  // Findings of the review of Step 2.3 (PR 1): each one is a test that failed before its fix
  describe('what the review found', () => {
    it('holds the case-insensitive name of a tag at the database, when two ask at once', async () => {
      for (let round = 0; round < 5; round += 1) {
        const [upper, lower] = await Promise.all([
          asAdmin()
            .post(ApiRoutes.settings.tags)
            .send({ name: `${prefix}-RACE${round}` }),
          asAdmin()
            .post(ApiRoutes.settings.tags)
            .send({ name: `${prefix}-race${round}` })
        ])

        expect([upper.status, lower.status].sort()).toEqual([CREATED, CONFLICT])
      }
    })

    it('does not take _ or % in a tag name for a wildcard', async () => {
      await newTag(`${prefix}-vip_1`)

      const other = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-vipX1` })

      expect(other.status).toBe(CREATED)
    })

    it('never leaves a settings row pointing at a snippet that was deleted meanwhile', async () => {
      for (let round = 0; round < 8; round += 1) {
        const snippet = await newSnippet(`${prefix}-race-${round}`)

        const [remove, point] = await Promise.all([
          asAdmin().delete(ApiRoutes.settings.snippetById(snippet.id)),
          asAdmin().patch(ApiRoutes.settings.inbox).send({ closingSnippetId: snippet.id })
        ])

        // The two outcomes there are: the pointer won and the delete is refused, or the delete won
        // and the pointer is refused. Never both, never a dangling pointer, never a 500.
        const deleteWon = remove.status === NO_CONTENT && point.status === NOT_FOUND
        const pointerWon = point.status === OK && remove.status === CONFLICT
        expect(deleteWon || pointerWon).toBe(true)
        const settings = await owner.storeSettings.findUniqueOrThrow({
          where: { storeId: ctx.storeA.id },
          select: { closingSnippetId: true }
        })
        const exists = (await owner.snippet.count({ where: { id: snippet.id } })) > 0
        expect(settings.closingSnippetId === snippet.id && !exists).toBe(false)
        await asAdmin().patch(ApiRoutes.settings.inbox).send({ closingSnippetId: null })
      }
    })

    it('does the same for the away message of the business hours', async () => {
      for (let round = 0; round < 8; round += 1) {
        const snippet = await newSnippet(`${prefix}-away-race-${round}`)

        const [remove, point] = await Promise.all([
          asAdmin().delete(ApiRoutes.settings.snippetById(snippet.id)),
          asAdmin()
            .put(ApiRoutes.settings.businessHours)
            .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: snippet.id })
        ])

        const hours = await owner.businessHours.findUniqueOrThrow({
          where: { storeId: ctx.storeA.id },
          select: { awayMessageSnippetId: true }
        })
        const exists = (await owner.snippet.count({ where: { id: snippet.id } })) > 0
        expect(hours.awayMessageSnippetId === snippet.id && !exists).toBe(false)
        const deleteWon = remove.status === NO_CONTENT && point.status === NOT_FOUND
        const pointerWon = point.status === OK && remove.status === CONFLICT
        expect(deleteWon || pointerWon).toBe(true)
        await asAdmin()
          .put(ApiRoutes.settings.businessHours)
          .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: null })
      }
    })

    it.each([
      ['an offset', '+05:00'],
      ['a name with nothing of a zone', 'tomorrow']
    ])('refuses %s as a timezone', async (_label, timezone) => {
      const response = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone, schedule: CLOSED_WEEK, awayMessageSnippetId: null })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('stores a timezone in its canonical spelling', async () => {
      const response = await asAdmin().put(ApiRoutes.settings.businessHours).send({
        timezone: 'america/el_salvador',
        schedule: CLOSED_WEEK,
        awayMessageSnippetId: null
      })

      expect((response.body as HoursBody).timezone).toBe('America/El_Salvador')
    })

    it('answers 404 with the code of a resource, not of a tenant, for a store with no hours', async () => {
      const response = await api(app, ctx.adminB, ctx.storeB).get(ApiRoutes.settings.businessHours)

      expect(response.status).toBe(NOT_FOUND)
      expect(codeOf(response.body)).toBe(ErrorCodes.RESOURCE_NOT_FOUND)
    })

    it('lower-cases a shortcut before it is checked, so what lowers into ASCII is stored lowered', async () => {
      // U+212A (Kelvin sign) is not ASCII until it is normalized and lowered: it becomes "k"
      const response = await asAdmin()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-\u212A`, title: 't', content: 'c' })

      expect(response.status).toBe(CREATED)
      expect((response.body as SnippetBody).shortcut).toBe(`${prefix}-k`)
    })

    it('keeps the spaces and the line breaks of a snippet, which is a message', async () => {
      const response = await asAdmin()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-spaces`, title: 't', content: 'Hola\n\n' })
      const blank = await asAdmin()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-blank`, title: 't', content: '  \n ' })

      expect((response.body as SnippetBody).content).toBe('Hola\n\n')
      expect(blank.status).toBe(BAD_REQUEST)
    })
  })

  describe('who may do what, and what happens when requests meet', () => {
    // Actors that hold exactly one permission, so that one cannot stand in for the other
    let viewsSettings: { id: string; email: string; token: string }
    let editsSettings: { id: string; email: string; token: string }
    let noPermission: { id: string; email: string; token: string }

    beforeAll(async () => {
      const make = async (name: string, permissions: readonly Permission[]) => {
        const role = await createRole(owner, {
          storeId: ctx.storeA.id,
          name: `${prefix}-${name}`,
          permissions
        })
        return createActor(owner, app, {
          prefix,
          name,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          roleId: role.id
        })
      }
      viewsSettings = await make('views-settings', [Permissions.SETTINGS_VIEW])
      editsSettings = await make('edits-settings', [Permissions.SETTINGS_EDIT])
      noPermission = await make('nothing', [Permissions.TEAM_VIEW])
    })

    const as = (actor: { id: string; email: string; token: string }) => api(app, actor, ctx.storeA)

    it('gives the behavior of the inbox to CONVERSATIONS_VIEW and not to SETTINGS_VIEW alone', async () => {
      const response = await as(viewsSettings).get(ApiRoutes.settings.inboxBehavior)

      expect(response.status).toBe(FORBIDDEN)
    })

    it('reads business hours and the inbox with SETTINGS_VIEW alone, and writes them with SETTINGS_EDIT alone', async () => {
      const hours = {
        timezone: 'UTC',
        schedule: CLOSED_WEEK,
        awayMessageSnippetId: null
      }

      expect((await as(viewsSettings).get(ApiRoutes.settings.inbox)).status).toBe(OK)
      expect((await as(editsSettings).get(ApiRoutes.settings.inbox)).status).toBe(FORBIDDEN)
      expect((await as(editsSettings).get(ApiRoutes.settings.businessHours)).status).toBe(FORBIDDEN)
      expect(
        (await as(viewsSettings).patch(ApiRoutes.settings.inbox).send({ requestCsat: false }))
          .status
      ).toBe(FORBIDDEN)
      expect(
        (await as(viewsSettings).put(ApiRoutes.settings.businessHours).send(hours)).status
      ).toBe(FORBIDDEN)
      expect(
        (await as(editsSettings).put(ApiRoutes.settings.businessHours).send(hours)).status
      ).toBe(OK)
      expect((await as(viewsSettings).get(ApiRoutes.settings.businessHours)).status).toBe(OK)
    })

    it('reads tags and snippets with CONVERSATIONS_VIEW and with nothing else', async () => {
      const snippet = await newSnippet(`${prefix}-readable`)
      const tag = await newTag(`${prefix}-readable`)

      for (const route of [
        ApiRoutes.settings.tags,
        ApiRoutes.settings.tagById(tag.id),
        ApiRoutes.settings.snippets,
        ApiRoutes.settings.snippetById(snippet.id)
      ]) {
        expect((await as(noPermission).get(route)).status).toBe(FORBIDDEN)
        expect((await as(viewsSettings).get(route)).status).toBe(FORBIDDEN)
        expect((await as(editsSettings).get(route)).status).toBe(FORBIDDEN)
        expect((await asViewer().get(route)).status).toBe(OK)
      }
    })

    it('writes tags and snippets with SETTINGS_EDIT alone, each verb', async () => {
      const snippet = await newSnippet(`${prefix}-writable`)

      const created = await as(editsSettings)
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-by-editor`, title: 't', content: 'c' })
      const changed = await as(editsSettings)
        .patch(ApiRoutes.settings.snippetById(snippet.id))
        .send({ title: 'new' })
      const agentChange = await asAgent()
        .patch(ApiRoutes.settings.snippetById(snippet.id))
        .send({ title: 'agent' })

      expect(created.status).toBe(CREATED)
      expect(changed.status).toBe(OK)
      expect(agentChange.status).toBe(FORBIDDEN)
    })

    it('lets two stores use the same tag name and the same shortcut', async () => {
      // The limit tests above fill store B: this one needs room there
      await owner.snippet.deleteMany({ where: { storeId: ctx.storeB.id } })
      await owner.tag.deleteMany({ where: { storeId: ctx.storeB.id } })
      const name = `${prefix}-shared-name`
      await newTag(name)
      await newSnippet(`${prefix}-shared-shortcut`)

      const tag = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.settings.tags)
        .send({ name })
      const snippet = await api(app, ctx.adminB, ctx.storeB)
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-shared-shortcut`, title: 't', content: 'c' })

      expect([tag.status, snippet.status]).toEqual([CREATED, CREATED])
    })

    it('stops at the limit exactly, even when many creators come together', async () => {
      const room = 3
      await owner.tag.deleteMany({ where: { storeId: ctx.storeB.id } })
      await owner.tag.createMany({
        data: Array.from({ length: SettingsLimits.MAX_TAGS_PER_STORE - room }, (_, i) => ({
          storeId: ctx.storeB.id,
          name: `${prefix}-cap-${i}`,
          color: '#000000'
        }))
      })

      const answers = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          api(app, ctx.adminB, ctx.storeB)
            .post(ApiRoutes.settings.tags)
            .send({ name: `${prefix}-cap-new-${i}` })
        )
      )

      expect(answers.filter(response => response.status === CREATED)).toHaveLength(room)
      for (const refused of answers.filter(response => response.status !== CREATED)) {
        expect(refused.status).toBe(CONFLICT)
        expect((refused.body as ErrorBody).error.metadata).toEqual({
          limit: SettingsLimits.MAX_TAGS_PER_STORE
        })
      }
      expect(await owner.tag.count({ where: { storeId: ctx.storeB.id } })).toBe(
        SettingsLimits.MAX_TAGS_PER_STORE
      )
    })

    it('answers 404 and not 500 when a tag or a snippet is gone under a request', async () => {
      const tag = await newTag(`${prefix}-vanishing`)
      const snippet = await newSnippet(`${prefix}-vanishing`)

      const [tagDelete, tagDeleteAgain, tagPatch] = await Promise.all([
        asAdmin().delete(ApiRoutes.settings.tagById(tag.id)),
        asAdmin().delete(ApiRoutes.settings.tagById(tag.id)),
        asAdmin().patch(ApiRoutes.settings.tagById(tag.id)).send({ color: '#010203' })
      ])
      const [snippetDelete, snippetPatch] = await Promise.all([
        asAdmin().delete(ApiRoutes.settings.snippetById(snippet.id)),
        asAdmin().patch(ApiRoutes.settings.snippetById(snippet.id)).send({ title: 'late' })
      ])

      for (const response of [tagDelete, tagDeleteAgain, tagPatch, snippetDelete, snippetPatch]) {
        expect([OK, NO_CONTENT, NOT_FOUND]).toContain(response.status)
      }
      expect(
        [tagDelete, tagDeleteAgain].filter(response => response.status === NO_CONTENT)
      ).toHaveLength(1)
    })

    it('lets two first PUTs of the business hours both succeed', async () => {
      await owner.businessHours.deleteMany({ where: { storeId: ctx.storeB.id } })

      const answers = await Promise.all(
        [1, 2].map(() =>
          api(app, ctx.adminB, ctx.storeB)
            .put(ApiRoutes.settings.businessHours)
            .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: null })
        )
      )

      expect(answers.map(response => response.status)).toEqual([OK, OK])
    })
  })

  describe('what is refused, and what is recorded', () => {
    it('refuses a name with a zero-width or a control character, and one that looks like another', async () => {
      await newTag(`${prefix}-look`)

      for (const name of [
        `${prefix}-look\u200b`,
        `${prefix}-lo\u200bok`,
        `${prefix}-\u202elook`,
        `${prefix}-a\nb`
      ]) {
        const response = await asAdmin().post(ApiRoutes.settings.tags).send({ name })
        expect(response.status).toBe(BAD_REQUEST)
      }
    })

    it('refuses a shortcut with letters of another script that look like Latin ones', async () => {
      const response = await asAdmin()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-gr\u0430cias`, title: 't', content: 'c' })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('refuses a shortcut that another snippet holds when it is changed, and answers 404 for a missing one', async () => {
      const first = await newSnippet(`${prefix}-change-a`)
      await newSnippet(`${prefix}-change-b`)

      const taken = await asAdmin()
        .patch(ApiRoutes.settings.snippetById(first.id))
        .send({ shortcut: `${prefix}-change-B` })
      const get = await asAdmin().get(ApiRoutes.settings.snippetById(first.id))
      const missing = await asAdmin().delete(
        ApiRoutes.settings.snippetById('00000000-0000-4000-8000-000000000000')
      )

      expect(taken.status).toBe(CONFLICT)
      expect((get.body as SnippetBody).shortcut).toBe(`${prefix}-change-a`)
      expect(missing.status).toBe(NOT_FOUND)
    })

    it.each([
      ['a range of no length', { mon: [{ from: '12:00', to: '12:00' }] }],
      ['an end past midnight', { mon: [{ from: '08:00', to: '24:01' }] }],
      ['a start at midnight of the next day', { mon: [{ from: '24:00', to: '24:00' }] }],
      ['minutes past 59', { mon: [{ from: '08:00', to: '12:60' }] }],
      [
        'more ranges than a day takes',
        { mon: [1, 2, 3, 4, 5].map(i => ({ from: `0${i}:00`, to: `0${i}:30` })) }
      ]
    ])('refuses %s', async (_label, change) => {
      const response = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({
          timezone: 'UTC',
          schedule: { ...CLOSED_WEEK, ...change },
          awayMessageSnippetId: null
        })

      expect(response.status).toBe(BAD_REQUEST)
    })

    it('refuses a missing day, and a store named in any body', async () => {
      const withoutSunday = { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [] }
      const missingDay = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone: 'UTC', schedule: withoutSunday, awayMessageSnippetId: null })
      const hoursWithStore = await asAdmin().put(ApiRoutes.settings.businessHours).send({
        timezone: 'UTC',
        schedule: CLOSED_WEEK,
        awayMessageSnippetId: null,
        storeId: ctx.storeB.id
      })
      const tag = await newTag(`${prefix}-no-store-in-body`)
      const tagWithStore = await asAdmin()
        .patch(ApiRoutes.settings.tagById(tag.id))
        .send({ name: `${prefix}-moved`, storeId: ctx.storeB.id })
      const snippet = await newSnippet(`${prefix}-no-store-in-body`)
      const snippetWithStore = await asAdmin()
        .patch(ApiRoutes.settings.snippetById(snippet.id))
        .send({ title: 'moved', storeId: ctx.storeB.id })

      for (const response of [missingDay, hoursWithStore, tagWithStore, snippetWithStore]) {
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect(await owner.tag.count({ where: { id: tag.id, storeId: ctx.storeA.id } })).toBe(1)
    })

    it('records every kind of change with its resource, and nothing for a request that was refused', async () => {
      const tag = await newTag(`${prefix}-audited`)
      await asAdmin().patch(ApiRoutes.settings.tagById(tag.id)).send({ color: '#abcdef' })
      await asAdmin().delete(ApiRoutes.settings.tagById(tag.id))
      const refused = await asAdmin().patch(ApiRoutes.settings.tagById(tag.id)).send({})

      await waitForAuditEntries(
        owner,
        { action: AuditAction.SETTINGS_CHANGED, resourceId: tag.id, resourceType: 'tag' },
        3
      )
      // The refused request would write its entry after the answer too: give it the time to show
      await new Promise(resolve => setTimeout(resolve, 500))
      const entries = await owner.auditLog.findMany({
        where: { action: AuditAction.SETTINGS_CHANGED, resourceId: tag.id, resourceType: 'tag' }
      })

      expect(refused.status).toBe(BAD_REQUEST)
      expect(entries.map(entry => (entry.metadata as { change: string }).change).sort()).toEqual([
        'created',
        'deleted',
        'updated'
      ])
    })

    it('records a put of the business hours and a change of a snippet', async () => {
      const snippet = await newSnippet(`${prefix}-audited`)
      await asAdmin().patch(ApiRoutes.settings.snippetById(snippet.id)).send({ title: 'again' })
      const hoursBefore = await owner.auditLog.count({
        where: {
          action: AuditAction.SETTINGS_CHANGED,
          resourceType: 'business_hours',
          resourceId: ctx.storeA2.id
        }
      })
      await api(app, ctx.adminA2, ctx.storeA2)
        .put(ApiRoutes.settings.businessHours)
        .send({ timezone: 'UTC', schedule: CLOSED_WEEK, awayMessageSnippetId: null })

      const snippetEntries = await waitForAuditEntries(
        owner,
        { action: AuditAction.SETTINGS_CHANGED, resourceId: snippet.id, resourceType: 'snippet' },
        2
      )
      const hoursEntries = await waitForAuditEntries(
        owner,
        {
          action: AuditAction.SETTINGS_CHANGED,
          resourceId: ctx.storeA2.id,
          resourceType: 'business_hours'
        },
        hoursBefore + 1
      )

      expect(snippetEntries).toHaveLength(2)
      expect(hoursEntries).toHaveLength(hoursBefore + 1)
      expect(hoursEntries.every(entry => entry.storeId === ctx.storeA2.id)).toBe(true)
    })
  })

  describe('second review of the tests', () => {
    it('holds the case-insensitive name at the index when two tags are renamed to it together', async () => {
      for (let round = 0; round < 5; round += 1) {
        const one = await newTag(`${prefix}-ren-a-${round}`)
        const two = await newTag(`${prefix}-ren-b-${round}`)

        const [upper, lower] = await Promise.all([
          asAdmin()
            .patch(ApiRoutes.settings.tagById(one.id))
            .send({ name: `${prefix}-REN${round}` }),
          asAdmin()
            .patch(ApiRoutes.settings.tagById(two.id))
            .send({ name: `${prefix}-ren${round}` })
        ])

        expect([upper.status, lower.status].sort()).toEqual([OK, CONFLICT])
      }
    })

    it('holds the shortcut of a snippet when two are changed to it together', async () => {
      const one = await newSnippet(`${prefix}-sc-a`)
      const two = await newSnippet(`${prefix}-sc-b`)

      const answers = await Promise.all([
        asAdmin()
          .patch(ApiRoutes.settings.snippetById(one.id))
          .send({ shortcut: `${prefix}-sc-x` }),
        asAdmin()
          .patch(ApiRoutes.settings.snippetById(two.id))
          .send({ shortcut: `${prefix}-sc-x` })
      ])

      expect(answers.map(response => response.status).sort()).toEqual([OK, CONFLICT])
    })

    it('does not delete a tag or a snippet of another store, and leaves it there', async () => {
      const tag = await createTag(owner, { storeId: ctx.storeB.id })
      const snippet = await createSnippet(owner, { storeId: ctx.storeB.id })

      const tagClaim = await asAdmin().delete(ApiRoutes.settings.tagById(tag.id))
      const snippetClaim = await asAdmin().delete(ApiRoutes.settings.snippetById(snippet.id))
      const tagNaming = await api(app, ctx.adminA, ctx.storeB).delete(
        ApiRoutes.settings.tagById(tag.id)
      )

      expect([tagClaim.status, snippetClaim.status]).toEqual([NOT_FOUND, NOT_FOUND])
      expect(tagNaming.status).toBe(FORBIDDEN)
      expect(await owner.tag.count({ where: { id: tag.id } })).toBe(1)
      expect(await owner.snippet.count({ where: { id: snippet.id } })).toBe(1)
    })

    it('stops the snippets at the limit exactly under concurrency, refusing the rest with 409', async () => {
      await owner.snippet.deleteMany({ where: { storeId: ctx.storeB.id } })
      const room = 2
      await owner.snippet.createMany({
        data: Array.from({ length: SettingsLimits.MAX_SNIPPETS_PER_STORE - room }, (_, i) => ({
          storeId: ctx.storeB.id,
          shortcut: `${prefix}-scap-${i}`,
          title: 't',
          content: 'c',
          createdBy: ctx.adminB.id
        }))
      })

      const answers = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          api(app, ctx.adminB, ctx.storeB)
            .post(ApiRoutes.settings.snippets)
            .send({ shortcut: `${prefix}-scap-new-${i}`, title: 't', content: 'c' })
        )
      )

      expect(answers.filter(response => response.status === CREATED)).toHaveLength(room)
      expect(
        answers.filter(response => response.status !== CREATED).every(r => r.status === CONFLICT)
      ).toBe(true)
      expect(await owner.snippet.count({ where: { storeId: ctx.storeB.id } })).toBe(
        SettingsLimits.MAX_SNIPPETS_PER_STORE
      )
      await owner.snippet.deleteMany({ where: { storeId: ctx.storeB.id } })
    })

    it('accepts the values at the limits and folds equivalent spellings into one name', async () => {
      const adjacent = await asAdmin()
        .put(ApiRoutes.settings.businessHours)
        .send({
          timezone: 'UTC',
          schedule: {
            ...CLOSED_WEEK,
            mon: [
              { from: '08:00', to: '12:00' },
              { from: '12:00', to: '13:00' },
              { from: '14:00', to: '15:00' },
              { from: '16:00', to: '24:00' }
            ]
          },
          awayMessageSnippetId: null
        })
      const longName = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: 'n'.repeat(SettingsLimits.TAG_NAME_MAX_LENGTH) })
      const tooLong = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: 'n'.repeat(SettingsLimits.TAG_NAME_MAX_LENGTH + 1) })
      const composed = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-caf\u00e9` })
      const decomposed = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-cafe\u0301` })
      const emoji = await asAdmin()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-\u{1F468}\u200D\u{1F4BB}` })

      expect(adjacent.status).toBe(OK)
      expect(longName.status).toBe(CREATED)
      expect(tooLong.status).toBe(BAD_REQUEST)
      expect(composed.status).toBe(CREATED)
      expect(decomposed.status).toBe(CONFLICT)
      expect(emoji.status).toBe(CREATED)
    })

    it('reads tags with CONVERSATIONS_VIEW alone, and writes each verb with SETTINGS_EDIT alone', async () => {
      const reader = await createActor(owner, app, {
        prefix,
        name: 'reads-conversations',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: (
          await createRole(owner, {
            storeId: ctx.storeA.id,
            name: `${prefix}-reads-conversations`,
            permissions: [Permissions.CONVERSATIONS_VIEW]
          })
        ).id
      })
      const editor = await createActor(owner, app, {
        prefix,
        name: 'edits-only',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: (
          await createRole(owner, {
            storeId: ctx.storeA.id,
            name: `${prefix}-edits-only`,
            permissions: [Permissions.SETTINGS_EDIT]
          })
        ).id
      })
      const tag = await newTag(`${prefix}-verbs`)
      const snippet = await newSnippet(`${prefix}-verbs`)
      const as = (actor: typeof reader) => api(app, actor, ctx.storeA)

      expect((await as(reader).get(ApiRoutes.settings.tags)).status).toBe(OK)
      expect((await as(reader).get(ApiRoutes.settings.snippets)).status).toBe(OK)
      expect((await as(reader).get(ApiRoutes.settings.inbox)).status).toBe(FORBIDDEN)
      expect((await as(editor).get(ApiRoutes.settings.tags)).status).toBe(FORBIDDEN)

      const created = await as(editor)
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-by-editor` })
      const patched = await as(editor)
        .patch(ApiRoutes.settings.tagById(tag.id))
        .send({ color: '#102030' })
      const deletedSnippet = await as(editor).delete(ApiRoutes.settings.snippetById(snippet.id))
      const inbox = await as(editor).patch(ApiRoutes.settings.inbox).send({ requestCsat: false })
      const deletedTag = await as(editor).delete(ApiRoutes.settings.tagById(tag.id))
      expect([
        created.status,
        patched.status,
        deletedSnippet.status,
        inbox.status,
        deletedTag.status
      ]).toEqual([CREATED, OK, NO_CONTENT, OK, NO_CONTENT])
      expect(
        (
          await as(reader)
            .post(ApiRoutes.settings.tags)
            .send({ name: `${prefix}-no` })
        ).status
      ).toBe(FORBIDDEN)
    })
  })

  describe('the closing message', () => {
    it('needs a closing snippet, whichever field is the one that is changed', async () => {
      const snippet = await newSnippet(`${prefix}-closing-rule`)
      await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ sendClosingMessage: false, closingSnippetId: null })

      const noSnippet = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ sendClosingMessage: true })
      const both = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ sendClosingMessage: true, closingSnippetId: snippet.id })
      const removing = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ closingSnippetId: null })
      const off = await asAdmin()
        .patch(ApiRoutes.settings.inbox)
        .send({ sendClosingMessage: false, closingSnippetId: null })

      expect(noSnippet.status).toBe(BAD_REQUEST)
      expect(codeOf(noSnippet.body)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(both.status).toBe(OK)
      expect(removing.status).toBe(BAD_REQUEST)
      expect(off.status).toBe(OK)
    })
  })
})
