import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { Permissions } from '@platform/core/auth'
import { ComplianceConfig } from '@platform/core/compliance'
import type { OwnerClient } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { type Actor, api } from '../helpers/http'

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403
const CONFLICT = 409

interface FormBody {
  key: string | null
  open: boolean
}
interface ErrorBody {
  error?: { code?: string }
}

// Step 7.2-H2b, C1a: the key of the public data request form, through the real app and the real database. The key is how the worker finds
// the store of a public request, so what matters here is who may make it, that it is random and unique, that a change is compare and swap,
// that no store reads or changes the key of another, and that the audit log never holds the whole key.
describe('The key of the public data request form', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let reviewer: Actor

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    reviewer = await actorWithPermissions(owner, app, {
      prefix,
      organizationId: ctx.orgA.id,
      storeId: ctx.storeA.id,
      name: 'reviewerOnlyForm',
      permissions: [Permissions.CUSTOMERS_DSR_REVIEW, Permissions.SETTINGS_VIEW]
    })
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })
  beforeEach(async () => {
    await owner.store.updateMany({
      where: { id: { in: [ctx.storeA.id, ctx.storeA2.id, ctx.storeB.id] } },
      data: { dsrPublicKey: null }
    })
  })

  const read = (actor: Actor, store: { id: string }) =>
    api(app, actor, store).get(ApiRoutes.compliance.dsrForm)
  const make = (current: string | null, actor: Actor = ctx.adminA, store = ctx.storeA) =>
    api(app, actor, store).post(ApiRoutes.compliance.dsrFormKey).send({ current })
  const revoke = (current: string | null, actor: Actor = ctx.adminA, store = ctx.storeA) =>
    api(app, actor, store).post(ApiRoutes.compliance.dsrFormKeyRevoke).send({ current })
  const keyOf = async (storeId: string): Promise<string | null> =>
    (await owner.store.findUniqueOrThrow({ where: { id: storeId } })).dsrPublicKey
  const codeOf = (body: unknown): string | undefined => (body as ErrorBody).error?.code

  describe('who may touch it', () => {
    it('refuses every route to a member without customers:dsr_manage_form, even one who reviews the requests', async () => {
      for (const response of [
        await read(reviewer, ctx.storeA),
        await make(null, reviewer),
        await revoke('x'.repeat(22), reviewer)
      ]) {
        expect(response.status).toBe(FORBIDDEN)
      }
      expect(await keyOf(ctx.storeA.id)).toBeNull()
    })

    it('does not let an admin of one store read or change the key of a store they do not belong to', async () => {
      const made = await make(null)
      expect(made.status).toBe(OK)
      const key = (made.body as FormBody).key
      expect([
        (await read(ctx.adminA, ctx.storeB)).status,
        (await make(key, ctx.adminA, ctx.storeB)).status,
        (await revoke(key, ctx.adminA, ctx.storeB)).status
      ]).toEqual([FORBIDDEN, FORBIDDEN, FORBIDDEN])
      expect(await keyOf(ctx.storeA.id)).toBe(key)
      expect(await keyOf(ctx.storeB.id)).toBeNull()
    })
  })

  describe('making the key', () => {
    it('reads none for a store that has not made one, and the form is shut while the flow is off', async () => {
      const response = await read(ctx.adminA, ctx.storeA)
      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ key: null, open: false })
    })

    it('makes a random key of 128 bits that the worker lookup finds, and reads it back', async () => {
      const response = await make(null)
      expect(response.status).toBe(OK)
      const { key } = response.body as FormBody
      expect(key).toMatch(/^[A-Za-z0-9_-]{22}$/)
      expect(Buffer.from(key ?? '', 'base64url')).toHaveLength(ComplianceConfig.DSR_FORM_KEY_BYTES)
      expect(await keyOf(ctx.storeA.id)).toBe(key)
      expect((await read(ctx.adminA, ctx.storeA)).body).toEqual({ key, open: false })
    })

    it('makes a different key for each store and each time', async () => {
      const first = ((await make(null)).body as FormBody).key
      const sibling = ((await make(null, ctx.adminA2, ctx.storeA2)).body as FormBody).key
      const again = ((await make(first)).body as FormBody).key
      expect(new Set([first, sibling, again]).size).toBe(3)
    })

    it('refuses to make a first key over one that exists, and leaves the one that is there', async () => {
      const key = ((await make(null)).body as FormBody).key
      const second = await make(null)
      expect(second.status).toBe(CONFLICT)
      expect(codeOf(second.body)).toBe(ErrorCodes.RESOURCE_CONFLICT)
      expect(await keyOf(ctx.storeA.id)).toBe(key)
    })

    it('replaces the key the screen showed, and the old one no longer opens the store', async () => {
      const old = ((await make(null)).body as FormBody).key
      const fresh = ((await make(old)).body as FormBody).key
      expect(fresh).not.toBe(old)
      expect(await keyOf(ctx.storeA.id)).toBe(fresh)
      const stale = await make(old)
      expect(stale.status).toBe(CONFLICT)
      expect(await keyOf(ctx.storeA.id)).toBe(fresh)
    })

    it('lets exactly one of two simultaneous first keys win', async () => {
      const answers = await Promise.all([make(null), make(null)])
      expect(answers.map(answer => answer.status).sort()).toEqual([OK, CONFLICT])
      const winner = answers.find(answer => answer.status === OK)?.body as FormBody
      expect(await keyOf(ctx.storeA.id)).toBe(winner.key)
    })

    it('refuses a body that is not exactly the key the screen showed', async () => {
      for (const body of [{}, { current: 5 }, { current: 'short' }, { current: null, extra: 1 }]) {
        const response = await api(app, ctx.adminA, ctx.storeA)
          .post(ApiRoutes.compliance.dsrFormKey)
          .send(body)
        expect(response.status).toBe(BAD_REQUEST)
      }
      expect(await keyOf(ctx.storeA.id)).toBeNull()
    })
  })

  describe('switching the form off', () => {
    it('takes the key away so that no request finds the store with it', async () => {
      const key = ((await make(null)).body as FormBody).key
      const response = await revoke(key)
      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ key: null, open: false })
      expect(await keyOf(ctx.storeA.id)).toBeNull()
    })

    it('answers the same, and writes nothing, for a form that is already off', async () => {
      // The sibling store: no other case switches a key off there, and the audit log is append-only, so the entries of a case of
      // the first store would still be in it (and may land late)
      const response = await revoke(null, ctx.adminA2, ctx.storeA2)
      expect(response.status).toBe(OK)
      expect(response.body).toEqual({ key: null, open: false })
      const entries = await owner.auditLog.findMany({
        where: { storeId: ctx.storeA2.id, action: AuditAction.DSR_FORM_KEY_REVOKED }
      })
      expect(entries).toHaveLength(0)
    })

    it('refuses to switch off a key that is not the one the store holds', async () => {
      const key = ((await make(null)).body as FormBody).key
      const wrong = await revoke('w'.repeat(22))
      expect(wrong.status).toBe(CONFLICT)
      expect(await keyOf(ctx.storeA.id)).toBe(key)
    })
  })

  describe('the audit log', () => {
    it('records who made, replaced and switched off the key, with its last four characters and never the whole of it', async () => {
      const first = ((await make(null)).body as FormBody).key as string
      const second = ((await make(first)).body as FormBody).key as string
      expect((await revoke(second)).status).toBe(OK)

      for (const [action, key] of [
        [AuditAction.DSR_FORM_KEY_CREATED, first],
        [AuditAction.DSR_FORM_KEY_ROTATED, second],
        [AuditAction.DSR_FORM_KEY_REVOKED, second]
      ] as const) {
        const entries = await waitForAuditEntries(owner, {
          storeId: ctx.storeA.id,
          action,
          metadata: {
            path: ['hint'],
            equals: key.slice(-ComplianceConfig.DSR_FORM_KEY_HINT_LENGTH)
          }
        })
        expect(entries).toHaveLength(1)
        expect(entries[0]?.userId).toBe(ctx.adminA.id)
        const text = JSON.stringify(entries[0])
        expect(text).not.toContain(key)
      }
      // A replacement also names the key it replaced, by its last characters (found by the pair, as the log keeps the entries of every case)
      const rotated = await waitForAuditEntries(owner, {
        storeId: ctx.storeA.id,
        action: AuditAction.DSR_FORM_KEY_ROTATED,
        metadata: {
          path: ['previousHint'],
          equals: first.slice(-ComplianceConfig.DSR_FORM_KEY_HINT_LENGTH)
        }
      })
      expect(rotated).toHaveLength(1)
      expect(rotated[0]?.metadata).toEqual({
        hint: second.slice(-ComplianceConfig.DSR_FORM_KEY_HINT_LENGTH),
        previousHint: first.slice(-ComplianceConfig.DSR_FORM_KEY_HINT_LENGTH)
      })
      expect(JSON.stringify(rotated[0])).not.toContain(first)
    })
  })
})
