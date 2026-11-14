import { types } from 'node:util'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'

import { SnippetsService } from '../../apps/api/src/modules/settings/snippets.service'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const CREATED = 201

interface TagBody {
  id: string
  name: string
}
interface SnippetBody {
  id: string
  shortcut: string
  updatedAt: string
}
interface PreferencesBody {
  sendReadReceipts: boolean
}

// What a row edited behind the api's back (the owner client emits no event) does to a cached read is the
// evidence: the old value is still served, so the read came from Redis; a change through the api drops
// it at once, so the listener of the domain events works; and a change in one store never reaches the
// cache of another.
describe('The cached reads of the settings of a store', () => {
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

  // Rows written as the owner, with no domain event and without the builders (which drop the cache, as the listener
  // would): this is the "behind the api's back" the cases below stand on
  const rawTag = (storeId: string, name: string) =>
    owner.tag.create({
      data: { storeId, name, color: '#8b5cf6' },
      select: { id: true, name: true }
    })
  const rawSnippet = (storeId: string, shortcut: string) =>
    owner.snippet.create({
      data: { storeId, shortcut, title: 'Greeting', content: 'Hello!', createdBy: 'a-user' },
      select: { id: true, shortcut: true }
    })

  const inA = () => api(app, ctx.adminA, ctx.storeA)
  const inB = () => api(app, ctx.adminB, ctx.storeB)

  const namesOf = async (agent: ReturnType<typeof inA>): Promise<string[]> => {
    const response = await agent.get(ApiRoutes.settings.tags)
    expect(response.status).toBe(OK)
    return (response.body as TagBody[]).map(tag => tag.name)
  }

  describe('tags', () => {
    it('serves the second read from the cache, and a change through the api shows at once', async () => {
      const first = await rawTag(ctx.storeA.id, `${prefix}-one`)
      expect(await namesOf(inA())).toContain(first.name)

      // Behind the api's back: no event, so the cache still holds the old list
      const second = await rawTag(ctx.storeA.id, `${prefix}-two`)
      expect(await namesOf(inA())).not.toContain(second.name)

      // Through the api: TAG_CREATED drops the cache, and the next read sees both
      const created = await inA()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-three` })
      expect(created.status).toBe(CREATED)
      const names = await namesOf(inA())
      expect(names).toEqual(expect.arrayContaining([first.name, second.name, `${prefix}-three`]))
    })

    it('shows a rename and a deletion at once', async () => {
      const tag = (
        await inA()
          .post(ApiRoutes.settings.tags)
          .send({ name: `${prefix}-before` })
      ).body as TagBody
      expect(await namesOf(inA())).toContain(`${prefix}-before`)

      const renamed = await inA()
        .patch(ApiRoutes.settings.tagById(tag.id))
        .send({ name: `${prefix}-after` })
      expect(renamed.status).toBe(OK)
      const afterRename = await namesOf(inA())
      expect(afterRename).toContain(`${prefix}-after`)
      expect(afterRename).not.toContain(`${prefix}-before`)

      const removed = await inA().delete(ApiRoutes.settings.tagById(tag.id))
      expect(removed.status).toBe(204)
      expect(await namesOf(inA())).not.toContain(`${prefix}-after`)
    })

    it('never serves the tags of one store to another, nor drops them when another changes', async () => {
      const tagOfB = await rawTag(ctx.storeB.id, `${prefix}-only-b`)
      const listB = await namesOf(inB())
      expect(listB).toContain(tagOfB.name)
      expect(await namesOf(inA())).not.toContain(tagOfB.name)

      // The cache of B holds the list; a row added to B behind the api's back stays unseen...
      const hidden = await rawTag(ctx.storeB.id, `${prefix}-hidden-b`)
      // ...and a change of A through the api must not drop it (the scope carries the storeId)
      const created = await inA()
        .post(ApiRoutes.settings.tags)
        .send({ name: `${prefix}-of-a` })
      expect(created.status).toBe(CREATED)
      const listBAgain = await namesOf(inB())
      expect(listBAgain).not.toContain(hidden.name)
      expect(listBAgain).not.toContain(`${prefix}-of-a`)
    })
  })

  describe('snippets', () => {
    it('keeps its date a date through the cache, and shows a change at once', async () => {
      const seeded = await rawSnippet(ctx.storeA.id, `${prefix}-a`)
      const read = async (): Promise<SnippetBody[]> => {
        const response = await inA().get(ApiRoutes.settings.snippets)
        expect(response.status).toBe(OK)
        return response.body as SnippetBody[]
      }
      const fromDatabase = await read() // loads and stores
      const fromCache = await read() // served from Redis
      expect(fromCache).toEqual(fromDatabase)
      const cachedSeeded = fromCache.find(s => s.id === seeded.id)
      expect(Number.isNaN(Date.parse(cachedSeeded?.updatedAt ?? ''))).toBe(false)

      // Called as a service, the cached list still holds a Date (the api turns it into text only on the way out)
      const service = app.get(SnippetsService, { strict: false })
      for (const snippet of await service.list(ctx.storeA.id)) {
        expect(types.isDate(snippet.updatedAt)).toBe(true) // not instanceof: structuredClone makes it in another realm under Jest
      }

      await rawSnippet(ctx.storeA.id, `${prefix}-hidden`)
      expect((await read()).map(s => s.shortcut)).not.toContain(`${prefix}-hidden`)

      const created = await inA()
        .post(ApiRoutes.settings.snippets)
        .send({ shortcut: `${prefix}-b`, title: 'T', content: 'C' })
      expect(created.status).toBe(CREATED)
      expect((await read()).map(s => s.shortcut)).toEqual(
        expect.arrayContaining([`${prefix}-a`, `${prefix}-hidden`, `${prefix}-b`])
      )
    })
  })

  describe('preferences', () => {
    it('shows what the store just chose, and keeps each store with its own', async () => {
      const read = async (agent: ReturnType<typeof inA>): Promise<boolean> => {
        const response = await agent.get(ApiRoutes.settings.preferences)
        expect(response.status).toBe(OK)
        return (response.body as PreferencesBody).sendReadReceipts
      }
      expect(await read(inA())).toBe(true)
      expect(await read(inB())).toBe(true)

      const changed = await inA()
        .put(ApiRoutes.settings.preferences)
        .send({ sendReadReceipts: false })
      expect(changed.status).toBe(OK)
      expect(await read(inA())).toBe(false)
      expect(await read(inB())).toBe(true)
    })
  })
})
