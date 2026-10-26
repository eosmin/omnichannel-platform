import { stripVTControlCharacters } from 'node:util'

import type { INestApplication } from '@nestjs/common'

import type { OwnerClient } from '@platform/core/database-testing'

import { createTag } from '../builders'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import {
  type IsolationCheck,
  isolationChecks,
  type IsolationResource,
  type IsolationScene
} from '../helpers/isolation'
import { LeakyRoutes, LeakyTagController } from '../helpers/leaky-tag.controller'

// A gate that has never failed proves nothing. These routes of LeakyTagController forget the store on purpose
// (a service written without thinking about tenants), and the checks of tenant-isolation.spec.ts
// have to catch each way they leak. If a check is weakened until it lets one through, this file
// is what turns red.
// Each resource renames to a name of its own: tags are unique by name in a store, and two routes
// renaming to the same name would fail on that, not on the check that is being tested
function renamingTo(name: string): Pick<IsolationResource, 'untouched'> {
  return {
    untouched: async (owner, id) =>
      (await owner.tag.findUnique({ where: { id }, select: { name: true } }))?.name !== name
  }
}

const leaky: IsolationResource = {
  name: 'leakyTag',
  create: createTag,
  readPath: LeakyRoutes.tagById,
  modify: { path: LeakyRoutes.tagById, body: { name: 'hacked-leaky' } },
  ...renamingTo('hacked-leaky')
}

// What a check threw, without the colors that jest adds when the output is a terminal. An empty
// string means the check did not fail.
async function failureOf(check: Promise<void>): Promise<string> {
  try {
    await check
    return ''
  } catch (error) {
    return stripVTControlCharacters(error instanceof Error ? error.message : String(error))
  }
}

describe('the isolation checks', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let scene: IsolationScene

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp([LeakyTagController])
    ctx = await seedTestContext(owner, app, prefix)
    scene = { app, owner, ctx }
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  // The failure has to be the leak and not another reason: each check names what it expected
  it.each([
    ['claimingOwnStore', /Expected: 404\s+Received: 200/],
    ['siblingStore', /Expected: 404\s+Received: 200/],
    ['modification', /Expected: 404\s+Received: 200/]
  ] satisfies [IsolationCheck, RegExp][])(
    'fail the check %s on a route that forgets the store',
    async (check, reason) => {
      expect(await failureOf(isolationChecks[check](scene, leaky))).toMatch(reason)
    }
  )

  it('fail the check listing on a route that lists every store', async () => {
    const listsAll: IsolationResource = { ...leaky, name: 'leakyList', listPath: LeakyRoutes.tags }

    expect(await failureOf(isolationChecks.listing(scene, listsAll))).toMatch(/not\.toContain/)
  })

  it('fail the check creation on a route that trusts the store of the body', async () => {
    const trusting: IsolationResource = {
      ...leaky,
      name: 'leakyCreation',
      creation: {
        path: LeakyRoutes.tags,
        body: name => ({ name }),
        storeOf: async (owner, id) =>
          (await owner.tag.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
          null
      }
    }

    expect(await failureOf(isolationChecks.creation(scene, trusting))).toMatch(
      /Expected: "[0-9a-f-]{36}"\s+Received: "[0-9a-f-]{36}"/
    )
  })

  it('fail the strict creation check on a route that writes the store of the body and answers 201', async () => {
    const lenient: IsolationResource = {
      ...leaky,
      name: 'leakyStrict',
      creation: {
        path: LeakyRoutes.tags,
        body: name => ({ name: `${name}-strict` }),
        strict: true,
        countIn: (owner, storeId) => owner.tag.count({ where: { storeId } }),
        storeOf: async (owner, id) =>
          (await owner.tag.findUnique({ where: { id }, select: { storeId: true } }))?.storeId ??
          null
      }
    }

    // The route should have refused the body: it answered 201 instead of 400
    expect(await failureOf(isolationChecks.creation(scene, lenient))).toMatch(
      /Expected: 400\s+Received: 201/
    )
  })

  it('fail the check ownRow on a route that gives the row of another store', async () => {
    const wrongRow: IsolationResource = {
      ...leaky,
      name: 'leakyOwn',
      create: async (owner, { storeId }) => {
        await owner.businessHours.upsert({
          where: { storeId },
          create: { storeId, timezone: 'UTC', schedule: {} },
          update: {}
        })
        return { id: storeId }
      },
      readPath: () => LeakyRoutes.businessHours,
      own: {
        set: async (owner, storeId, marker) => {
          await owner.businessHours.update({
            where: { storeId },
            data: { timezone: marker === 'A' ? 'America/Costa_Rica' : 'Asia/Tokyo' }
          })
        },
        markerIn: body => {
          const timezone = (body as { timezone?: string }).timezone
          return timezone === 'America/Costa_Rica' ? 'A' : timezone === 'Asia/Tokyo' ? 'B' : null
        }
      }
    }

    expect(await failureOf(isolationChecks.ownRow(scene, wrongRow))).toMatch(/Expected: "[AB]"/)
  })
  it('fail the check modification on a route that answers 404 but has already changed the row', async () => {
    // The status is the right one, so only the look at the row can catch it
    const lateCheck: IsolationResource = {
      ...leaky,
      name: 'lateCheckTag',
      modify: { path: LeakyRoutes.lateCheckTagById, body: { name: 'hacked-late' } },
      ...renamingTo('hacked-late')
    }

    // The status is the right one: it fails on the look at the row, not on the status
    expect(await failureOf(isolationChecks.modification(scene, lateCheck))).toMatch(
      /Expected: true\s+Received: false/
    )
  })

  it('still pass the check of the other organization on it, because the guard refuses first', async () => {
    // The first layer (TenantGuard) protects even a route whose service forgot the store; the
    // others are what the service itself has to keep
    await expect(isolationChecks.otherOrganization(scene, leaky)).resolves.toBeUndefined()
  })
})
