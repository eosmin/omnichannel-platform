import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import type { TestContext } from './context'
import { api, type TestAgent } from './http'

// One resource of the platform that belongs to a store, described once. The checks below are the
// same for all of them (TDD_13 section 6): adding a resource to the platform means adding its
// description to the suite, and scripts/check-isolation-coverage.ts fails the build if it is not.
export interface IsolationResource {
  name: string
  // A row of the resource in the given store, written as the owner
  create: (owner: OwnerClient, input: { storeId: string }) => Promise<{ id: string }>
  // Where one row is read. A resource with no route for that (a member is only listed and changed)
  // is reached by the route that changes it: the answers a stranger gets are the same.
  readPath?: (id: string) => string
  // The route that lists the resource of the store of the request
  listPath?: string
  // A change a user could try to make to a row (a rename, a status). A resource no route changes (a
  // file is replaced by uploading another) has none, and the change check does not apply to it.
  modify?: {
    path: (id: string) => string
    // PATCH unless the resource is changed by a DELETE (an invitation is revoked) or by an action
    // (a merge is undone with a POST)
    method?: 'patch' | 'post' | 'put' | 'delete'
    // A body that names the row (an unmerge names the merge) is a function of its id
    body: Record<string, unknown> | ((id: string) => Record<string, unknown>)
  }
  // One row per store, reached through the store of the request and never by an id (the business
  // hours, the settings): the checks about asking for the row of another store by its id do not
  // apply, `create` returns the store as the id, and the check `ownRow` looks that the row the
  // request gets is the one of its own store. `set` puts a marker in the row of a store, `markerIn`
  // reads it from the answer.
  own?: {
    set: (owner: OwnerClient, storeId: string, marker: string) => Promise<void>
    markerIn: (body: unknown) => string | null
  }
  // true while the row is as it was created: after a refused change it must still be
  untouched: (owner: OwnerClient, id: string) => Promise<boolean>
  // Creating through the api, with another store named in the body: the row must land in the store
  // of the request
  creation?: {
    path: string
    body: (name: string) => Record<string, unknown>
    storeOf: (owner: OwnerClient, id: string) => Promise<string | null>
    // How many rows of the resource a store has: a body refused for naming another store must have
    // left none in it. Required when the endpoint is strict.
    countIn?: (owner: OwnerClient, storeId: string) => Promise<number>
    // The endpoint refuses a field it does not know (400) instead of ignoring it: the store in the
    // body is then refused, and the same body without it must land in the store of the header
    strict?: boolean
  }
}

export interface IsolationScene {
  app: INestApplication
  owner: OwnerClient
  ctx: TestContext
}

// The request that changes a row of the resource
function change(agent: TestAgent, modify: NonNullable<IsolationResource['modify']>, id: string) {
  const { path, method = 'patch', body } = modify
  if (method === 'delete') return agent.delete(path(id))
  const payload = typeof body === 'function' ? body(id) : body
  if (method === 'post') return agent.post(path(id)).send(payload)
  if (method === 'put') return agent.put(path(id)).send(payload)
  return agent.patch(path(id)).send(payload)
}

// A resource with no route to read it is reached by the route that changes it: whatever the answer
// to the stranger, the row must be as it was
async function expectUntouchedIfChangedToReach(
  owner: OwnerClient,
  resource: IsolationResource,
  id: string
): Promise<void> {
  if (resource.readPath === undefined) expect(await resource.untouched(owner, id)).toBe(true)
}

// One request for a row of the resource, whichever way the api lets it be reached
function reach(agent: TestAgent, resource: IsolationResource, id: string) {
  if (resource.readPath !== undefined) return agent.get(resource.readPath(id))
  // A resource nobody can read or change has nothing to test here
  if (resource.modify === undefined) {
    throw new Error(`the resource ${resource.name} has neither a readPath nor a modify route`)
  }
  return change(agent, resource.modify, id)
}

interface ErrorBody {
  error?: { code?: string }
}

// Every check throws (a jest expectation) when the resource leaks, so that a suite and the test of
// the suite (isolation-detects-leaks.spec.ts) use the very same code.
export const isolationChecks = {
  // The user belongs to store A. The row is in store B, of another organization, and the user names
  // store B in the header: the guard refuses it before the resource is looked at.
  async otherOrganization(
    { app, owner, ctx }: IsolationScene,
    resource: IsolationResource
  ): Promise<void> {
    const row = await resource.create(owner, { storeId: ctx.storeB.id })

    const response = await reach(api(app, ctx.adminA, ctx.storeB), resource, row.id)

    expect(response.status).toBe(403)
    expect((response.body as ErrorBody).error?.code).toBe(ErrorCodes.TENANT_ACCESS_DENIED)
    await expectUntouchedIfChangedToReach(owner, resource, row.id)
  },

  // The user names their own store and asks for the id of a row of store B. Only the service
  // that filters by the store of the request keeps it out: the answer must be the one of a row that
  // does not exist.
  async claimingOwnStore(
    { app, owner, ctx }: IsolationScene,
    resource: IsolationResource
  ): Promise<void> {
    if (resource.own !== undefined) return
    const row = await resource.create(owner, { storeId: ctx.storeB.id })

    const response = await reach(api(app, ctx.adminA, ctx.storeA), resource, row.id)

    expect(response.status).toBe(404)
    expect(JSON.stringify(response.body)).not.toContain(row.id)
    // Not an existence oracle: the answer is the very one of an id that exists nowhere
    if (resource.readPath !== undefined) {
      const missing = await reach(api(app, ctx.adminA, ctx.storeA), resource, randomUUID())
      expect((response.body as ErrorBody).error).toEqual((missing.body as ErrorBody).error)
    }
    await expectUntouchedIfChangedToReach(owner, resource, row.id)
  },

  // Two stores of one organization are as separate as two organizations
  async siblingStore(
    { app, owner, ctx }: IsolationScene,
    resource: IsolationResource
  ): Promise<void> {
    if (resource.own !== undefined) return
    const row = await resource.create(owner, { storeId: ctx.storeA2.id })

    const fromOwnStore = await reach(api(app, ctx.adminA, ctx.storeA), resource, row.id)
    const fromTheSibling = await reach(api(app, ctx.adminA, ctx.storeA2), resource, row.id)

    expect(fromOwnStore.status).toBe(404)
    expect(fromTheSibling.status).toBe(403) // The user is not a member of the sibling
    await expectUntouchedIfChangedToReach(owner, resource, row.id)
  },

  // A resource with one row per store: two stores each have a row with its own marker, and the
  // request of a store gets the row of that store
  async ownRow({ app, owner, ctx }: IsolationScene, resource: IsolationResource): Promise<void> {
    const { own, readPath } = resource
    if (own === undefined) return
    // A one-row-per-store resource skips the checks by id: without a read route nothing reads it
    expect(readPath).toBeDefined()
    if (readPath === undefined) return
    await resource.create(owner, { storeId: ctx.storeA.id })
    await resource.create(owner, { storeId: ctx.storeB.id })
    await own.set(owner, ctx.storeA.id, 'A')
    await own.set(owner, ctx.storeB.id, 'B')

    const fromA = await api(app, ctx.adminA, ctx.storeA).get(readPath(ctx.storeA.id))
    const fromB = await api(app, ctx.adminB, ctx.storeB).get(readPath(ctx.storeB.id))

    expect(fromA.status).toBe(200)
    expect(own.markerIn(fromA.body)).toBe('A')
    expect(own.markerIn(fromB.body)).toBe('B')
  },

  async modification(
    { app, owner, ctx }: IsolationScene,
    resource: IsolationResource
  ): Promise<void> {
    if (resource.modify === undefined) return
    const row = await resource.create(owner, { storeId: ctx.storeB.id })

    const claiming = await change(api(app, ctx.adminA, ctx.storeA), resource.modify, row.id)
    const naming = await change(api(app, ctx.adminA, ctx.storeB), resource.modify, row.id)

    // A resource with one row per store changes the row of the own store: it must have worked, or the
    // untouched row below proves nothing
    if (resource.own === undefined) expect(claiming.status).toBe(404)
    else expect(claiming.status).toBe(200)
    expect(naming.status).toBe(403)
    // The refusal is not enough: the row must not have changed
    expect(await resource.untouched(owner, row.id)).toBe(true)
  },

  async listing({ app, owner, ctx }: IsolationScene, resource: IsolationResource): Promise<void> {
    if (resource.listPath === undefined) return
    const mine = await resource.create(owner, { storeId: ctx.storeA.id })
    const theirs = await resource.create(owner, { storeId: ctx.storeB.id })

    const response = await api(app, ctx.adminA, ctx.storeA).get(resource.listPath)

    expect(response.status).toBe(200)
    // A list is a bare array or a page ({ data, nextCursor, hasMore }, TDD_08 §2.4)
    const rows = response.body as { id: string }[] | { data: { id: string }[] }
    const ids = (Array.isArray(rows) ? rows : rows.data).map(row => row.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  },

  // A body that names another store is a body like any other: the row goes to the store of the
  // header (and a store in the body is never read), or the body is refused as a whole
  async creation({ app, owner, ctx }: IsolationScene, resource: IsolationResource): Promise<void> {
    if (resource.creation === undefined) return
    const { path, body, storeOf, countIn, strict = false } = resource.creation
    const agent = api(app, ctx.adminA, ctx.storeA)
    const before = countIn === undefined ? null : await countIn(owner, ctx.storeB.id)

    const named = await agent
      .post(path)
      .send({ ...body('created-by-the-suite'), storeId: ctx.storeB.id })
    if (strict) {
      expect(named.status).toBe(400)
      expect((named.body as ErrorBody).error?.code).toBe(ErrorCodes.VALIDATION_FAILED)
      // Refused as a whole: nothing was written into the store the body named
      expect(countIn).toBeDefined()
      expect(await countIn?.(owner, ctx.storeB.id)).toBe(before)
    }
    const created = strict ? await agent.post(path).send(body('created-by-the-suite')) : named

    expect(created.status).toBe(201)
    expect(await storeOf(owner, (created.body as { id: string }).id)).toBe(ctx.storeA.id)
  }
}

export type IsolationCheck = keyof typeof isolationChecks
