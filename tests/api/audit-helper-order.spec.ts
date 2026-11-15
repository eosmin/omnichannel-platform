import { randomUUID } from 'node:crypto'

import type { OwnerClient } from '@platform/core/database-testing'

import { waitForAuditEntries } from '../helpers/audit'
import { ownerClient } from '../helpers/database'

// The first row of an audit read is a thing the suites lean on: it must not be whichever row
// Postgres stored first.
describe('waitForAuditEntries order', () => {
  const organizationId = randomUUID()
  const action = `order.suite.${randomUUID()}`
  let owner: OwnerClient

  beforeAll(() => {
    owner = ownerClient()
  })

  afterAll(async () => {
    try {
      await owner.auditLog.deleteMany({ where: { organizationId } })
    } finally {
      await owner.$disconnect()
    }
  })

  it('returns the rows oldest first, whatever order they were stored in', async () => {
    // Stored newest first: the physical order is the reverse of the time order
    const newest = await owner.auditLog.create({
      data: { action, organizationId, timestamp: new Date('2026-01-03T00:00:00Z') }
    })
    const middle = await owner.auditLog.create({
      data: { action, organizationId, timestamp: new Date('2026-01-02T00:00:00Z') }
    })
    const oldest = await owner.auditLog.create({
      data: { action, organizationId, timestamp: new Date('2026-01-01T00:00:00Z') }
    })

    const found = await waitForAuditEntries(owner, { organizationId, action }, 3)

    expect(found.map(row => row.id)).toEqual([oldest.id, middle.id, newest.id])
  })

  it('breaks a tie of time by id, so the order is the same on every read', async () => {
    const tied = new Date('2026-02-01T00:00:00Z')
    const tiedAction = `${action}.tie`
    const ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const id of ids) {
      await owner.auditLog.create({
        data: { id, action: tiedAction, organizationId, timestamp: tied }
      })
    }

    const found = await waitForAuditEntries(owner, { organizationId, action: tiedAction }, 3)

    expect(found.map(row => row.id)).toEqual([...ids].sort())
  })
})
