import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ExportStatus, ExportTypes } from '@platform/core/queues'

import { createRole } from '../builders'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

const OK = 200
const ACCEPTED = 202
const FORBIDDEN = 403
const BAD_REQUEST = 400

interface EntryBody {
  id: string
  action: string
  userId: string | null
  resourceType: string | null
  resourceId: string | null
  metadata: unknown
  timestamp: string
}
interface PageBody {
  data: EntryBody[]
  hasMore: boolean
  nextCursor: string | null
}

// The audit log viewer of a store (TDD_05 §9.3, Step 7.2-E): who may read it, that it holds the rows of the store of the request
// and no other, the cursor, the filters, and that reading it is itself audited. The table is immutable (the rows are made here by
// the owner, as the application writes them: with a store, or with none).
describe('Audit log viewer', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  const action = `${prefix}.viewer`
  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)

  async function entry(data: {
    storeId: string | null
    userId: string
    action?: string
    resourceType?: string
    resourceId?: string
    timestamp?: Date
    metadata?: Record<string, unknown>
  }): Promise<{ id: string }> {
    return owner.auditLog.create({
      data: {
        action: data.action ?? action,
        userId: data.userId,
        storeId: data.storeId,
        ...(data.resourceType === undefined ? {} : { resourceType: data.resourceType }),
        ...(data.resourceId === undefined ? {} : { resourceId: data.resourceId }),
        ...(data.timestamp === undefined ? {} : { timestamp: data.timestamp }),
        ...(data.metadata === undefined ? {} : { metadata: data.metadata })
      },
      select: { id: true }
    })
  }
  const list = async (query = ''): Promise<PageBody> => {
    const response = await asAdmin().get(`${ApiRoutes.organizations.auditLog}?${query}`)
    expect(response.status).toBe(OK)
    return response.body as PageBody
  }

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

  it('is for the members who hold org:view_audit_log: the Admin and a custom role, not an agent or a viewer', async () => {
    expect(
      (await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.organizations.auditLog)).status
    ).toBe(FORBIDDEN)
    expect(
      (await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.organizations.auditLog)).status
    ).toBe(FORBIDDEN)
    const auditor = await createRole(owner, {
      storeId: ctx.storeA.id,
      permissions: [Permissions.ORG_VIEW_AUDIT_LOG]
    })
    const member = await createActor(owner, app, {
      prefix,
      name: 'auditor',
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      roleId: auditor.id
    })
    expect((await api(app, member, ctx.storeA).get(ApiRoutes.organizations.auditLog)).status).toBe(
      OK
    )
    // The right of a store is not the right of another one
    expect((await api(app, member, ctx.storeA2).get(ApiRoutes.organizations.auditLog)).status).toBe(
      FORBIDDEN
    )
  })

  it('lists the rows of the store of the request, never those of another store or of no store', async () => {
    const mine = await entry({ storeId: ctx.storeA.id, userId: ctx.adminA.id })
    await entry({ storeId: ctx.storeB.id, userId: ctx.adminB.id })
    await entry({ storeId: ctx.storeA2.id, userId: ctx.adminA2.id })
    await entry({ storeId: null, userId: ctx.adminA.id })

    const page = await list(`action=${action}`)

    expect(page.data.map(row => row.id)).toEqual([mine.id])
    // The view carries no store and no organization: they are the caller's own
    expect(Object.keys(page.data[0] ?? {}).sort()).toEqual(
      [
        'action',
        'id',
        'ipAddress',
        'metadata',
        'resourceId',
        'resourceType',
        'timestamp',
        'userAgent',
        'userId'
      ].sort()
    )
    // Another store named in the query is not a filter: the query is refused, not obeyed
    const foreign = await asAdmin().get(
      `${ApiRoutes.organizations.auditLog}?storeId=${ctx.storeB.id}`
    )
    expect(foreign.status).toBe(BAD_REQUEST)
    // And a person who is not a member of the store gets nothing of it
    expect(
      (await api(app, ctx.adminB, ctx.storeA).get(ApiRoutes.organizations.auditLog)).status
    ).toBe(FORBIDDEN)
  })

  it('pages by cursor, newest first, with no row lost or repeated when two share the same instant', async () => {
    const paged = `${prefix}.paged`
    const same = new Date('2026-01-10T10:00:00.000Z')
    const ids = [
      (
        await entry({
          storeId: ctx.storeA.id,
          userId: ctx.adminA.id,
          action: paged,
          timestamp: new Date('2026-01-09T10:00:00.000Z')
        })
      ).id,
      (
        await entry({
          storeId: ctx.storeA.id,
          userId: ctx.adminA.id,
          action: paged,
          timestamp: same
        })
      ).id,
      (
        await entry({
          storeId: ctx.storeA.id,
          userId: ctx.adminA.id,
          action: paged,
          timestamp: same
        })
      ).id,
      (
        await entry({
          storeId: ctx.storeA.id,
          userId: ctx.adminA.id,
          action: paged,
          timestamp: new Date('2026-01-11T10:00:00.000Z')
        })
      ).id,
      (
        await entry({
          storeId: ctx.storeA.id,
          userId: ctx.adminA.id,
          action: paged,
          timestamp: new Date('2026-01-12T10:00:00.000Z')
        })
      ).id
    ]

    const first = await list(`action=${paged}&limit=2`)
    expect(first.hasMore).toBe(true)
    const second = await list(
      `action=${paged}&limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`
    )
    expect(second.hasMore).toBe(true)
    const third = await list(
      `action=${paged}&limit=2&cursor=${encodeURIComponent(second.nextCursor ?? '')}`
    )
    expect(third).toMatchObject({ hasMore: false, nextCursor: null })

    const seen = [...first.data, ...second.data, ...third.data]
    expect(new Set(seen.map(row => row.id))).toEqual(new Set(ids))
    expect(seen).toHaveLength(ids.length)
    const times = seen.map(row => row.timestamp)
    expect(times).toEqual([...times].sort().reverse())

    expect(
      (await asAdmin().get(`${ApiRoutes.organizations.auditLog}?cursor=not-a-cursor`)).status
    ).toBe(BAD_REQUEST)
    expect((await asAdmin().get(`${ApiRoutes.organizations.auditLog}?limit=101`)).status).toBe(
      BAD_REQUEST
    )
  })

  it('filters by action, person, resource and range, together', async () => {
    const kind = `${prefix}.filters`
    const a = await entry({
      storeId: ctx.storeA.id,
      userId: ctx.adminA.id,
      action: kind,
      resourceType: 'order',
      resourceId: 'o-1',
      timestamp: new Date('2026-02-01T00:00:00.000Z')
    })
    const b = await entry({
      storeId: ctx.storeA.id,
      userId: ctx.agentA.id,
      action: kind,
      resourceType: 'customer',
      resourceId: 'c-1',
      timestamp: new Date('2026-03-01T00:00:00.000Z')
    })

    const ids = async (query: string) => (await list(`action=${kind}&${query}`)).data.map(r => r.id)
    expect(await ids(`userId=${ctx.agentA.id}`)).toEqual([b.id])
    expect(await ids('resourceType=order')).toEqual([a.id])
    expect(await ids('resourceType=order&resourceId=o-1')).toEqual([a.id])
    expect(await ids('resourceId=c-1')).toEqual([b.id])
    expect(await ids('from=2026-02-15T00:00:00.000Z')).toEqual([b.id])
    // The end of the range is exclusive
    expect(await ids('before=2026-03-01T00:00:00.000Z')).toEqual([a.id])
    expect(await ids(`userId=${ctx.adminA.id}&resourceType=customer`)).toEqual([])
    expect(
      (
        await asAdmin().get(
          `${ApiRoutes.organizations.auditLog}?from=2026-03-01T00:00:00.000Z&before=2026-02-01T00:00:00.000Z`
        )
      ).status
    ).toBe(BAD_REQUEST)
  })

  it('audits that it was read, with the filters and no text of a person', async () => {
    const seen = `${prefix}.audited-read`
    await list(`action=${seen}`)

    const [viewed] = await waitForAuditEntries(owner, {
      storeId: ctx.storeA.id,
      action: AuditAction.AUDIT_LOG_VIEWED,
      userId: ctx.adminA.id,
      metadata: { path: ['filters', 'action'], equals: seen }
    })
    expect(viewed?.metadata).toEqual({ filters: { action: seen }, page: 'first' })
    expect(viewed?.resourceType).toBe('audit_log')
  })

  it('asks for the same permission to export, and answers with the export of the center', async () => {
    expect(
      (await api(app, ctx.agentA, ctx.storeA).get(ApiRoutes.organizations.auditLogExport)).status
    ).toBe(FORBIDDEN)

    const response = await asAdmin().get(
      `${ApiRoutes.organizations.auditLogExport}?action=${action}&from=2026-01-01T00:00:00.000Z`
    )

    expect(response.status).toBe(ACCEPTED)
    const view = response.body as { id: string; type: string; status: string }
    expect(view).toMatchObject({ type: ExportTypes.AUDIT_LOG, status: ExportStatus.PENDING })
    const row = await owner.export.findUniqueOrThrow({ where: { id: view.id } })
    expect(row.storeId).toBe(ctx.storeA.id)
    expect(row.requestedBy).toBe(ctx.adminA.id)
    // The store is not in the filters: the file is the one of the row
    expect(row.filters).toEqual({ action, from: '2026-01-01T00:00:00.000Z' })
    expect(
      (await asAdmin().get(`${ApiRoutes.organizations.auditLogExport}?storeId=${ctx.storeB.id}`))
        .status
    ).toBe(BAD_REQUEST)
    await owner.export.update({ where: { id: view.id }, data: { status: ExportStatus.FAILED } })
  })
})
