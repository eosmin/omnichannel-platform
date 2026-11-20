import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { OwnerClient } from '@platform/core/database-testing'

import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400

// QA RB-G4 (debt of #672): the page size of a list is a whole number in digits. `z.coerce.number()` read '1e2' as 100, '0x10' as
// 16, ' 5' as 5, '5.0' as 5 and '+5' as 5 on every list that was not finance or fiscal.
describe('the page size of the lists', () => {
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

  const lists = [
    ApiRoutes.customers.list,
    ApiRoutes.orders.list,
    ApiRoutes.conversations.list,
    ApiRoutes.shipments.list,
    ApiRoutes.exports.list,
    ApiRoutes.transfers.list,
    ApiRoutes.counts.list,
    ApiRoutes.pickups.list
  ]
  const spellings = ['1e2', '0x10', '%205', '5.0', '%2B5', '']

  it.each(lists)('%s reads digits only, and the ordinary sizes still work', async route => {
    const agent = () => api(app, ctx.adminA, ctx.storeA)

    for (const limit of spellings) {
      const response = await agent().get(`${route}?limit=${limit}`)
      expect([route, limit, response.status]).toEqual([route, limit, BAD_REQUEST])
    }
    // Past the size a list may give
    expect((await agent().get(`${route}?limit=101`)).status).toBe(BAD_REQUEST)
    expect((await agent().get(`${route}?limit=0`)).status).toBe(BAD_REQUEST)
    for (const limit of ['1', '25', '100']) {
      const response = await agent().get(`${route}?limit=${limit}`)
      expect([route, limit, response.status]).toEqual([route, limit, OK])
    }
    expect((await agent().get(route)).status).toBe(OK)
  })
})
