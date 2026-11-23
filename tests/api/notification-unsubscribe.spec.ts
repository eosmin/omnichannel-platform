import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Redis } from 'ioredis'
import type { PinoLogger } from 'nestjs-pino'
import supertest from 'supertest'

import { API_PREFIX, ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { UnsubscribeThrottle, UnsubscribeTokenThrottle } from '@platform/core/auth'
import { signUnsubscribeToken, UnsubscribeScopes } from '@platform/core/crypto'
import { JobContext, PrismaService } from '@platform/core/database'
import type { OwnerClient } from '@platform/core/database-testing'
import { DigestFrequency } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import {
  NotificationSeverity,
  NotificationTypes,
  notificationMessageKey,
  UNSUBSCRIBE_VERIFICATION_KEYS
} from '@platform/core/notifications'
import { REDIS_CLIENT } from '@platform/core/redis'

import { NotificationUnsubscribeService } from '../../apps/api/src/modules/notifications/notification-unsubscribe.service'
import { createTestApp } from '../helpers/app'
import { waitForAuditEntries } from '../helpers/audit'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { anonymousApi } from '../helpers/http'

const NO_CONTENT = 204
const NOT_FOUND = 404
const TOO_MANY = 429

// The public one-click unsubscribe of the notification emails (Step 7.3, B6b-3b2b): no session, the signed token is the credential. It
// switches OFF the notification email of the person the token names, and nothing else; it answers the same for everything it refuses.
describe('The one-click unsubscribe of the notification emails', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let key: string
  const route = ApiRoutes.notifications.unsubscribe

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
    key = app.get<readonly string[]>(UNSUBSCRIBE_VERIFICATION_KEYS, { strict: false })[0] ?? ''
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const tokenOf = (userId: string, signingKey = key): string =>
    signUnsubscribeToken(signingKey, UnsubscribeScopes.NOTIFICATION_EMAIL, userId)
  const post = (token: string) => anonymousApi(app).post(route).send({ token })

  const choose = (userId: string, digestFrequency: string) =>
    owner.userNotificationSettings.upsert({
      where: { userId },
      create: { userId, digestFrequency, quietHoursEnabled: true, quietHoursStart: 22 },
      update: { digestFrequency, quietHoursEnabled: true, quietHoursStart: 22 }
    })
  const mark = (userId: string) =>
    owner.notification.create({
      data: {
        userId,
        storeId: ctx.storeA.id,
        type: NotificationTypes.EXPORT_READY,
        severity: NotificationSeverity.INFO,
        messageKey: notificationMessageKey(NotificationTypes.EXPORT_READY),
        emailPendingAt: new Date()
      },
      select: { id: true }
    })
  const settingsOf = (userId: string) =>
    owner.userNotificationSettings.findUnique({ where: { userId } })
  const pendingOf = (userId: string) =>
    owner.notification.count({ where: { userId, emailPendingAt: { not: null } } })

  afterEach(async () => {
    const users = [ctx.adminA.id, ctx.agentA.id, ctx.viewerA.id]
    await owner.notification.deleteMany({ where: { userId: { in: users } } })
    await owner.userNotificationSettings.deleteMany({ where: { userId: { in: users } } })
    await owner.auditLog.deleteMany({
      where: { action: AuditAction.NOTIFICATION_EMAIL_UNSUBSCRIBED, resourceId: { in: users } }
    })
  })

  describe('with a good token', () => {
    it('switches the email of that person off, takes off the marks that waited, and answers 204 with no body', async () => {
      await choose(ctx.adminA.id, DigestFrequency.HOURLY)
      await mark(ctx.adminA.id)

      const response = await post(tokenOf(ctx.adminA.id))

      expect(response.status).toBe(NO_CONTENT)
      expect(response.text).toBe('')
      expect((await settingsOf(ctx.adminA.id))?.digestFrequency).toBe(DigestFrequency.OFF)
      expect(await pendingOf(ctx.adminA.id)).toBe(0)
    })

    it('works with no row of settings (a person who never chose): it makes the row, off', async () => {
      const response = await post(tokenOf(ctx.agentA.id))

      expect(response.status).toBe(NO_CONTENT)
      expect((await settingsOf(ctx.agentA.id))?.digestFrequency).toBe(DigestFrequency.OFF)
    })

    it('only turns off: the other choices of the person, and every other person, stay as they were', async () => {
      await choose(ctx.adminA.id, DigestFrequency.DAILY)
      await choose(ctx.agentA.id, DigestFrequency.HOURLY)
      await mark(ctx.agentA.id)

      await post(tokenOf(ctx.adminA.id))

      expect(await settingsOf(ctx.adminA.id)).toMatchObject({
        digestFrequency: DigestFrequency.OFF,
        quietHoursEnabled: true,
        quietHoursStart: 22
      })
      expect(await settingsOf(ctx.agentA.id)).toMatchObject({
        digestFrequency: DigestFrequency.HOURLY
      })
      expect(await pendingOf(ctx.agentA.id)).toBe(1)
    })

    it('never turns the email back on: a person who is off stays off', async () => {
      await choose(ctx.adminA.id, DigestFrequency.OFF)

      await post(tokenOf(ctx.adminA.id))

      expect((await settingsOf(ctx.adminA.id))?.digestFrequency).toBe(DigestFrequency.OFF)
    })

    it('is idempotent: the same token twice answers the same, leaves the same state and writes one audit entry', async () => {
      await choose(ctx.adminA.id, DigestFrequency.IMMEDIATE)
      const token = tokenOf(ctx.adminA.id)

      const first = await post(token)
      const second = await post(token)

      expect([first.status, second.status]).toEqual([NO_CONTENT, NO_CONTENT])
      expect(second.text).toBe(first.text)
      expect((await settingsOf(ctx.adminA.id))?.digestFrequency).toBe(DigestFrequency.OFF)
      const entries = await waitForAuditEntries(owner, {
        action: AuditAction.NOTIFICATION_EMAIL_UNSUBSCRIBED,
        resourceId: ctx.adminA.id
      })
      expect(entries).toHaveLength(1)
      // Ids and the scope only: no address, no name, no token
      const written = JSON.stringify(entries[0])
      expect(written).not.toContain(token)
      expect(written).not.toContain(ctx.adminA.email)
      expect(entries[0]?.metadata).toEqual({ scope: UnsubscribeScopes.NOTIFICATION_EMAIL })
    })

    it('takes the token from the query when a mail client POSTs `List-Unsubscribe=One-Click` to the url of the header (RFC 8058)', async () => {
      await choose(ctx.adminA.id, DigestFrequency.HOURLY)

      const response = await anonymousApi(app)
        .post(`${route}?token=${encodeURIComponent(tokenOf(ctx.adminA.id))}`)
        .type('form')
        .send('List-Unsubscribe=One-Click')

      expect(response.status).toBe(NO_CONTENT)
      expect((await settingsOf(ctx.adminA.id))?.digestFrequency).toBe(DigestFrequency.OFF)
    })
  })

  describe('with a token that does not hold', () => {
    const settled = async (userId: string) => ({
      settings: await settingsOf(userId),
      pending: await pendingOf(userId)
    })

    it('answers the same 204 for a changed id, a changed mac, another key, another scope, junk, no token and a person who does not exist, and changes nothing', async () => {
      await choose(ctx.adminA.id, DigestFrequency.HOURLY)
      await choose(ctx.agentA.id, DigestFrequency.HOURLY)
      await mark(ctx.adminA.id)
      await mark(ctx.agentA.id)
      const before = [await settled(ctx.adminA.id), await settled(ctx.agentA.id)]

      const good = tokenOf(ctx.adminA.id)
      const [version, scope, , mac] = good.split('.') as [string, string, string, string]
      const refused = [
        // The id of ANOTHER person under the mac of this one: a person cannot switch off another's email by changing the id
        [version, scope, ctx.agentA.id, mac].join('.'),
        [version, scope, ctx.adminA.id, `${mac.slice(0, -1)}${mac.endsWith('0') ? '1' : '0'}`].join(
          '.'
        ),
        tokenOf(ctx.adminA.id, 'x'.repeat(40)),
        [version, 'zz', ctx.adminA.id, mac].join('.'),
        `junk-${randomUUID()}`,
        'v1.ne..'
      ]
      const answers = await Promise.all(refused.map(token => post(token)))
      const noBody = await anonymousApi(app).post(route).send({})
      const wrongShape = await anonymousApi(app)
        .post(route)
        .send({ token: { a: 1 } })
      const stranger = await post(tokenOf(randomUUID()))

      for (const answer of [...answers, noBody, wrongShape, stranger]) {
        expect(answer.status).toBe(NO_CONTENT)
        expect(answer.text).toBe('')
      }
      expect([await settled(ctx.adminA.id), await settled(ctx.agentA.id)]).toEqual(before)
    })

    it('answers a good token and a bad one with the same status, headers aside from the date, and body (nothing says which held)', async () => {
      const good = await post(tokenOf(ctx.adminA.id))
      const bad = await post(`junk-${randomUUID()}`)

      expect(good.status).toBe(bad.status)
      expect(good.text).toBe(bad.text)
      expect(good.headers['content-type']).toBe(bad.headers['content-type'])
      expect(good.headers['cache-control']).toBe(bad.headers['cache-control'])
    })

    it('writes no audit entry for a person who does not exist', async () => {
      const gone = randomUUID()
      await post(tokenOf(gone))

      expect(
        await owner.auditLog.count({
          where: { action: AuditAction.NOTIFICATION_EMAIL_UNSUBSCRIBED, resourceId: gone }
        })
      ).toBe(0)
    })
  })

  describe('the key of a rotation', () => {
    const NEW_KEY = 'n'.repeat(40)
    const OLD_KEY = 'p'.repeat(40)
    const serviceWith = (keys: readonly string[]): NotificationUnsubscribeService =>
      new NotificationUnsubscribeService(
        app.get(PrismaService, { strict: false }),
        app.get(JobContext, { strict: false }),
        app.get(AuditService, { strict: false }),
        app.get<Redis>(REDIS_CLIENT, { strict: false }),
        keys,
        { inc: jest.fn() } as unknown as Counter<string>,
        { setContext: jest.fn(), warn: jest.fn() } as unknown as PinoLogger
      )

    it('a link signed under the previous key still switches the email off while the previous key is set', async () => {
      await choose(ctx.adminA.id, DigestFrequency.HOURLY)

      await serviceWith([NEW_KEY, OLD_KEY]).unsubscribe(tokenOf(ctx.adminA.id, OLD_KEY))

      expect((await settingsOf(ctx.adminA.id))?.digestFrequency).toBe(DigestFrequency.OFF)
    })

    it('the same link does nothing once the previous key is gone', async () => {
      await choose(ctx.adminA.id, DigestFrequency.HOURLY)

      await serviceWith([NEW_KEY]).unsubscribe(tokenOf(ctx.adminA.id, OLD_KEY))

      expect((await settingsOf(ctx.adminA.id))?.digestFrequency).toBe(DigestFrequency.HOURLY)
    })
  })

  describe('as a page opened by a mail scanner', () => {
    it('has NO GET: opening the link changes nothing (the route does not exist for that method)', async () => {
      await choose(ctx.adminA.id, DigestFrequency.HOURLY)
      const token = tokenOf(ctx.adminA.id)

      const asked = await anonymousApi(app).get(`${route}?token=${encodeURIComponent(token)}`)

      expect(asked.status).toBe(NOT_FOUND)
      expect((await settingsOf(ctx.adminA.id))?.digestFrequency).toBe(DigestFrequency.HOURLY)
    })
  })

  describe('the rate limit', () => {
    it('cuts one token after its few tries, whether the token is good or junk (a 429 says nothing about it)', async () => {
      const token = `junk-${randomUUID()}`
      const answers: number[] = []
      for (let attempt = 0; attempt <= UnsubscribeTokenThrottle.limit; attempt += 1) {
        answers.push((await post(token)).status)
      }

      expect(answers.slice(0, UnsubscribeTokenThrottle.limit).every(s => s === NO_CONTENT)).toBe(
        true
      )
      expect(answers[UnsubscribeTokenThrottle.limit]).toBe(TOO_MANY)
      const refused = await post(token)
      expect((refused.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.RATE_LIMIT_EXCEEDED
      )
    })

    it('a good token is counted the same: it too is cut after its tries', async () => {
      const token = tokenOf(ctx.viewerA.id)
      let last = NO_CONTENT
      for (let attempt = 0; attempt <= UnsubscribeTokenThrottle.limit; attempt += 1) {
        last = (await post(token)).status
      }

      expect(last).toBe(TOO_MANY)
    })

    it('cuts one address after its tries, whatever the tokens', async () => {
      const server = app.getHttpServer() as Parameters<typeof supertest>[0]
      const address = `10.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}.77`
      const answers: number[] = []
      for (let attempt = 0; attempt <= UnsubscribeThrottle.limit; attempt += 1) {
        const response = await supertest(server)
          .post(`${API_PREFIX}${route}`)
          .set('x-forwarded-for', address)
          .send({ token: `junk-${randomUUID()}` })
        answers.push(response.status)
      }

      expect(answers.slice(0, UnsubscribeThrottle.limit).every(s => s === NO_CONTENT)).toBe(true)
      expect(answers[UnsubscribeThrottle.limit]).toBe(TOO_MANY)
    })
  })
})
