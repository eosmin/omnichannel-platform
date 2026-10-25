import type { INestApplication } from '@nestjs/common'

import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import type { TestContext } from './context'
import { api } from './http'

// One resource of the platform that belongs to a store, described once. The checks below are the
// same for all of them (TDD_13 section 6): adding a resource to the platform means adding its
// description to the suite, and scripts/check-isolation-coverage.ts fails the build if it is not.
export interface IsolationResource {
  name: string
  // A row of the resource in the given store, written as the owner
  create: (owner: OwnerClient, input: { storeId: string }) => Promise<{ id: string }>
  readPath: (id: string) => string
  // The route that lists the resource of the store of the request
  listPath?: string
  // A change a user could try to make to a row (a rename, a status)
  modify: { path: (id: string) => string; body: Record<string, unknown> }
  // true while the row is as it was created: after a refused change it must still be
  untouched: (owner: OwnerClient, id: string) => Promise<boolean>
  // Creating through the api, with another store named in the body: the row must land in the store
  // of the request
  creation?: {
    path: string
    body: (name: string) => Record<string, unknown>
    storeOf: (owner: OwnerClient, id: string) => Promise<string | null>
  }
}

export interface IsolationScene {
  app: INestApplication
  owner: OwnerClient
  ctx: TestContext
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

    const response = await api(app, ctx.adminA, ctx.storeB).get(resource.readPath(row.id))

    expect(response.status).toBe(403)
    expect((response.body as ErrorBody).error?.code).toBe(ErrorCodes.TENANT_ACCESS_DENIED)
  },

  // The user names their own store and asks for the id of a row of store B. Only the service
  // that filters by the store of the request keeps it out: the answer must be the one of a row that
  // does not exist.
  async claimingOwnStore(
    { app, owner, ctx }: IsolationScene,
    resource: IsolationResource
  ): Promise<void> {
    const row = await resource.create(owner, { storeId: ctx.storeB.id })

    const response = await api(app, ctx.adminA, ctx.storeA).get(resource.readPath(row.id))

    expect(response.status).toBe(404)
    expect(JSON.stringify(response.body)).not.toContain(row.id)
  },

  // Two stores of one organization are as separate as two organizations
  async siblingStore(
    { app, owner, ctx }: IsolationScene,
    resource: IsolationResource
  ): Promise<void> {
    const row = await resource.create(owner, { storeId: ctx.storeA2.id })

    const fromOwnStore = await api(app, ctx.adminA, ctx.storeA).get(resource.readPath(row.id))
    const fromTheSibling = await api(app, ctx.adminA, ctx.storeA2).get(resource.readPath(row.id))

    expect(fromOwnStore.status).toBe(404)
    expect(fromTheSibling.status).toBe(403) // The user is not a member of the sibling
  },

  async modification(
    { app, owner, ctx }: IsolationScene,
    resource: IsolationResource
  ): Promise<void> {
    const row = await resource.create(owner, { storeId: ctx.storeB.id })
    const path = resource.modify.path(row.id)

    const claiming = await api(app, ctx.adminA, ctx.storeA).patch(path).send(resource.modify.body)
    const naming = await api(app, ctx.adminA, ctx.storeB).patch(path).send(resource.modify.body)

    expect(claiming.status).toBe(404)
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
    const ids = (response.body as { id: string }[]).map(row => row.id)
    expect(ids).toContain(mine.id)
    expect(ids).not.toContain(theirs.id)
  },

  // A body that names another store is a body like any other: the row goes to the store of the
  // header (and a store in the body is never read)
  async creation({ app, owner, ctx }: IsolationScene, resource: IsolationResource): Promise<void> {
    if (resource.creation === undefined) return
    const { path, body, storeOf } = resource.creation

    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(path)
      .send({ ...body('created-by-the-suite'), storeId: ctx.storeB.id })

    expect(response.status).toBe(201)
    expect(await storeOf(owner, (response.body as { id: string }).id)).toBe(ctx.storeA.id)
  }
}

export type IsolationCheck = keyof typeof isolationChecks
