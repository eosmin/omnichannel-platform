import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import { RoleNames } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ensureUser } from '@platform/core/database-testing'
import { ErrorCodes } from '@platform/core/errors'

import { SessionService } from '../../apps/api/src/modules/auth/session.service'
import { TenantContextService } from '../../apps/api/src/modules/tenancy'
import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { emailsOf } from '../helpers/email'
import { type Actor, anonymousApi, api } from '../helpers/http'

interface ErrorBody {
  error: { code: string; metadata?: { reason?: string } }
}
interface AcceptedBody {
  store: { id: string; name: string }
  role: string
  session?: { accessToken: string; refreshToken: string }
  user?: { id: string; email: string; name: string }
}

const URL_TOKEN = /\/invitations\/([A-Za-z0-9_-]+)$/

describe('Accepting an invitation', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  let counter = 0

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

  const newEmail = (): string => {
    counter += 1
    return `${prefix}-guest${counter}@example.com`
  }
  const tenants = () => app.get(TenantContextService, { strict: false })

  // The real path: an Admin invites through the api, and the token is read from the email that went out
  async function invite(email: string, roleId = ctx.roleIds[RoleNames.AGENT]) {
    const response = await api(app, ctx.adminA, ctx.storeA)
      .post(ApiRoutes.settings.members)
      .send({ email, roleId })
    expect(response.status).toBe(201)
    const job = emailsOf(app).to(email.toLowerCase()).at(-1)
    const token = URL_TOKEN.exec((job?.data as { url: string }).url)?.[1] as string
    return { token, id: (response.body as { id: string }).id }
  }

  // An account that exists already, with a session, as a member of the other organization
  async function existingAccount(email: string): Promise<Actor> {
    const name = email.slice(prefix.length + 1, email.indexOf('@'))
    const actor = await createActor(owner, app, {
      prefix,
      name,
      organizationId: ctx.orgB.id,
      storeId: ctx.storeB.id,
      roleId: ctx.roleIds[RoleNames.VIEWER]
    })
    expect(actor.email).toBe(email)
    return actor
  }

  const accept = (token: string, body: object = {}) =>
    anonymousApi(app).post(ApiRoutes.invitations.accept(token)).send(body)
  const acceptAs = (user: Actor, token: string, body: object = {}) =>
    anonymousApi(app)
      .post(ApiRoutes.invitations.accept(token))
      .set('authorization', `Bearer ${user.token}`)
      .send(body)
  const codeOf = (response: { body: unknown }): string => (response.body as ErrorBody).error.code

  describe('the preview', () => {
    it('shows what the link is for, to anyone who holds it, and nothing else', async () => {
      const email = newEmail()
      const { token } = await invite(email)

      const response = await anonymousApi(app).get(ApiRoutes.invitations.byToken(token))

      expect(response.status).toBe(200)
      expect(Object.keys(response.body as object).sort()).toEqual([
        'email',
        'expiresAt',
        'inviterName',
        'roleName',
        'storeName'
      ])
      expect(response.body).toMatchObject({
        email,
        storeName: `${prefix}-store-a`,
        roleName: RoleNames.AGENT,
        inviterName: 'adminA'
      })
    })

    it('answers the same to a token that does not exist, one revoked and one already used', async () => {
      const revoked = await invite(newEmail())
      await api(app, ctx.adminA, ctx.storeA).delete(ApiRoutes.settings.invitationById(revoked.id))
      const used = await invite(newEmail())
      await accept(used.token, { name: 'Guest' })

      const answers = await Promise.all(
        ['not-a-token', randomUUID(), revoked.token, used.token].map(token =>
          anonymousApi(app).get(ApiRoutes.invitations.byToken(token))
        )
      )

      expect(answers.map(answer => answer.status)).toEqual([404, 404, 404, 404])
      expect(answers.map(codeOf)).toEqual(Array(4).fill(ErrorCodes.TENANT_INVITATION_INVALID))
    })

    it('says so when the invitation has expired', async () => {
      const { token, id } = await invite(newEmail())
      await owner.invitation.update({
        where: { id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })

      const response = await anonymousApi(app).get(ApiRoutes.invitations.byToken(token))

      expect(response.status).toBe(410)
      expect(codeOf(response)).toBe(ErrorCodes.TENANT_INVITATION_EXPIRED)
    })
  })

  describe('by someone with no account', () => {
    it('creates the account, the membership and the session together', async () => {
      const email = newEmail()
      const { token, id } = await invite(email)

      const response = await accept(token, { name: 'New Guest' })

      expect(response.status).toBe(200)
      const body = response.body as AcceptedBody
      expect(body).toMatchObject({
        store: { id: ctx.storeA.id, name: `${prefix}-store-a` },
        role: RoleNames.AGENT,
        user: { email, name: 'New Guest' }
      })
      const user = await owner.user.findUniqueOrThrow({ where: { email } })
      expect(user).toMatchObject({ emailVerified: true, name: 'New Guest', locale: 'es' })
      const membership = await owner.membership.findFirstOrThrow({
        where: { userId: user.id, storeId: ctx.storeA.id }
      })
      expect(membership).toMatchObject({
        status: 'ACTIVE',
        roleId: ctx.roleIds[RoleNames.AGENT],
        invitationId: id,
        organizationId: ctx.orgA.id
      })
      expect(await owner.invitation.findUniqueOrThrow({ where: { id } })).toMatchObject({
        status: 'ACCEPTED',
        acceptedById: user.id
      })
    })

    it('opens a session that works in the store at once', async () => {
      const { token } = await invite(newEmail())
      const body = (await accept(token, { name: 'Guest' })).body as AcceptedBody

      const response = await api(
        app,
        { id: '', email: '', token: body.session?.accessToken ?? '' },
        ctx.storeA
      ).get(ApiRoutes.settings.members)

      // An Agent may not see the team, but the guards let them into the store: 403 is not 401/403 TENANT
      expect(response.status).toBe(403)
      expect(codeOf(response)).toBe(ErrorCodes.PERMISSION_DENIED)
    })

    it('needs the name, and creates nothing without it', async () => {
      const email = newEmail()
      const { token, id } = await invite(email)

      const response = await accept(token)

      expect(response.status).toBe(400)
      expect(codeOf(response)).toBe(ErrorCodes.VALIDATION_FAILED)
      expect(await owner.user.findUnique({ where: { email } })).toBeNull()
      expect((await owner.invitation.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING')
    })

    it('never takes the address, the role or the store from the body', async () => {
      const { token } = await invite(newEmail())

      const response = await accept(token, {
        name: 'Guest',
        email: 'someone-else@example.com',
        roleId: ctx.roleIds[RoleNames.ADMIN],
        storeId: ctx.storeB.id
      })

      expect(response.status).toBe(400)
    })

    it('leaves no user behind when it fails half way', async () => {
      const email = newEmail()
      const { token, id } = await invite(email)
      const issue = jest
        .spyOn(app.get(SessionService, { strict: false }), 'issue')
        .mockRejectedValueOnce(new Error('the session store is down'))

      const response = await accept(token, { name: 'Guest' })

      issue.mockRestore()
      expect(response.status).toBe(500)
      expect(await owner.user.findUnique({ where: { email } })).toBeNull()
      expect(await owner.membership.count({ where: { invitationId: id } })).toBe(0)
      expect((await owner.invitation.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING')
      // And the link still works
      expect((await accept(token, { name: 'Guest' })).status).toBe(200)
    })

    it('can be done once: the link is single use', async () => {
      const { token } = await invite(newEmail())
      await accept(token, { name: 'Guest' })

      const again = await accept(token, { name: 'Guest' })

      expect(again.status).toBe(404)
      expect(codeOf(again)).toBe(ErrorCodes.TENANT_INVITATION_INVALID)
    })

    it('creates one account when the link is used twice at the same moment', async () => {
      const email = newEmail()
      const { token } = await invite(email)

      const answers = await Promise.all([
        accept(token, { name: 'Guest' }),
        accept(token, { name: 'Guest' })
      ])

      expect(answers.map(answer => answer.status).sort()).toEqual([200, 404])
      expect(await owner.user.count({ where: { email } })).toBe(1)
    })

    it('does not accept a link that expired or was revoked', async () => {
      const expired = await invite(newEmail())
      await owner.invitation.update({
        where: { id: expired.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })
      const revoked = await invite(newEmail())
      await api(app, ctx.adminA, ctx.storeA).delete(ApiRoutes.settings.invitationById(revoked.id))

      const late = await accept(expired.token, { name: 'Guest' })
      const gone = await accept(revoked.token, { name: 'Guest' })

      expect([late.status, gone.status]).toEqual([410, 404])
    })

    it('audits the join', async () => {
      const { token, id } = await invite(newEmail())
      const body = (await accept(token, { name: 'Guest' })).body as AcceptedBody

      let entry = null
      for (let attempt = 0; attempt < 50 && entry === null; attempt += 1) {
        entry = await owner.auditLog.findFirst({
          where: { action: AuditAction.MEMBER_JOINED, userId: body.user?.id }
        })
        if (entry === null) await new Promise(resolve => setTimeout(resolve, 100))
      }

      expect(entry).toMatchObject({
        storeId: ctx.storeA.id,
        metadata: { invitationId: id, role: RoleNames.AGENT, newAccount: true }
      })
    })
  })

  describe('by someone who has an account', () => {
    it('creates the membership when they are logged in as the invited address', async () => {
      const email = newEmail()
      const guest = await existingAccount(email)
      const { token, id } = await invite(email)
      const usersBefore = await owner.user.count({ where: { email: { startsWith: prefix } } })

      const response = await acceptAs(guest, token)

      expect(response.status).toBe(200)
      const body = response.body as AcceptedBody
      expect(body).toMatchObject({ store: { id: ctx.storeA.id }, role: RoleNames.AGENT })
      expect(body.session).toBeUndefined() // They have one
      expect(await owner.user.count({ where: { email: { startsWith: prefix } } })).toBe(usersBefore)
      expect(
        await owner.membership.findFirst({ where: { userId: guest.id, storeId: ctx.storeA.id } })
      ).toMatchObject({ status: 'ACTIVE', invitationId: id })
      expect((await tenants().resolve(guest.id, ctx.storeA.id))?.membership.roleName).toBe(
        RoleNames.AGENT
      )
    })

    it('is asked to log in first when they come with no session, and nothing is created', async () => {
      const email = newEmail()
      const guest = await existingAccount(email)
      const { token, id } = await invite(email)

      const response = await accept(token, { name: 'Guest' })

      expect(response.status).toBe(401)
      expect(codeOf(response)).toBe(ErrorCodes.AUTH_UNAUTHORIZED)
      expect((response.body as ErrorBody).error.metadata?.reason).toBe('login_required')
      expect(
        await owner.membership.count({ where: { userId: guest.id, storeId: ctx.storeA.id } })
      ).toBe(0)
      expect((await owner.invitation.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING')
    })

    it('matches the address whatever the case it was saved in', async () => {
      const email = newEmail()
      const user = await ensureUser(owner, email.replace('guest', 'GuEsT'), 'Mixed')
      const stored = await owner.user.findUniqueOrThrow({ where: { id: user.id } })
      expect(stored.email).not.toBe(email)
      const sessions = app.get(SessionService, { strict: false })
      const issued = await sessions.issue({ id: user.id, email: stored.email })
      const { token } = await invite(email)

      const response = await acceptAs(
        { id: user.id, email: stored.email, token: issued.accessToken },
        token
      )

      expect(response.status).toBe(200)
    })

    it('gives the membership to the account of the session, not to one that differs only in case', async () => {
      const email = newEmail()
      const lowerCase = await ensureUser(owner, email, 'Lower')
      const upperCase = await ensureUser(owner, email.toUpperCase(), 'Upper')
      const sessions = app.get(SessionService, { strict: false })
      const issued = await sessions.issue({ id: upperCase.id, email: email.toUpperCase() })
      const { token } = await invite(email)

      const response = await acceptAs(
        { id: upperCase.id, email: email.toUpperCase(), token: issued.accessToken },
        token
      )

      expect(response.status).toBe(200)
      expect(
        await owner.membership.count({ where: { userId: upperCase.id, storeId: ctx.storeA.id } })
      ).toBe(1)
      expect(
        await owner.membership.count({ where: { userId: lowerCase.id, storeId: ctx.storeA.id } })
      ).toBe(0)
    })

    it('is refused when the session belongs to another address, and nothing changes', async () => {
      const other = await existingAccount(newEmail())
      const { token, id } = await invite(newEmail())

      const response = await acceptAs(other, token, { name: 'Guest' })

      expect(response.status).toBe(403)
      expect(codeOf(response)).toBe(ErrorCodes.TENANT_INVITATION_EMAIL_MISMATCH)
      expect(
        await owner.membership.count({ where: { userId: other.id, storeId: ctx.storeA.id } })
      ).toBe(0)
      expect((await owner.invitation.findUniqueOrThrow({ where: { id } })).status).toBe('PENDING')
    })

    it('is refused when the session belongs to a member of the store, for an invitation to another', async () => {
      const { token } = await invite(newEmail())

      const response = await acceptAs(ctx.adminA, token)

      expect(response.status).toBe(403)
    })

    it('is refused with a token that does not verify, not taken for anonymous', async () => {
      const email = newEmail()
      const { token } = await invite(email)

      const response = await anonymousApi(app)
        .post(ApiRoutes.invitations.accept(token))
        .set('authorization', 'Bearer garbage')
        .send({ name: 'Guest' })

      expect(response.status).toBe(401)
      expect(codeOf(response)).toBe(ErrorCodes.AUTH_TOKEN_INVALID)
      expect(await owner.user.findUnique({ where: { email } })).toBeNull()
    })

    it('brings back the membership of someone who was removed, with the role of the invitation', async () => {
      const email = newEmail()
      const guest = await existingAccount(email)
      const first = await invite(email, ctx.roleIds[RoleNames.VIEWER])
      await acceptAs(guest, first.token)
      const membership = await owner.membership.findFirstOrThrow({
        where: { userId: guest.id, storeId: ctx.storeA.id }
      })
      await api(app, ctx.adminA, ctx.storeA).delete(ApiRoutes.settings.memberById(membership.id))
      expect(await tenants().resolve(guest.id, ctx.storeA.id)).toBeNull()
      const second = await invite(email, ctx.roleIds[RoleNames.SUPERVISOR])

      const response = await acceptAs(guest, second.token)

      expect(response.status).toBe(200)
      const after = await owner.membership.findFirstOrThrow({
        where: { userId: guest.id, storeId: ctx.storeA.id }
      })
      expect(after).toMatchObject({
        id: membership.id,
        status: 'ACTIVE',
        revokedAt: null,
        roleId: ctx.roleIds[RoleNames.SUPERVISOR]
      })
      expect((await tenants().resolve(guest.id, ctx.storeA.id))?.membership.roleName).toBe(
        RoleNames.SUPERVISOR
      )
    })

    it('does not make a second membership of someone who joined meanwhile', async () => {
      const email = newEmail()
      const guest = await existingAccount(email)
      const pending = await invite(email)
      // They joined the store by another way after the invitation was sent
      await owner.membership.create({
        data: {
          userId: guest.id,
          organizationId: ctx.orgA.id,
          storeId: ctx.storeA.id,
          roleId: ctx.roleIds[RoleNames.VIEWER]
        }
      })

      const response = await acceptAs(guest, pending.token)

      expect(response.status).toBe(409)
      expect(codeOf(response)).toBe(ErrorCodes.TENANT_MEMBER_ALREADY_EXISTS)
      expect(
        await owner.membership.count({ where: { userId: guest.id, storeId: ctx.storeA.id } })
      ).toBe(1)
    })
  })

  describe('the limit', () => {
    it('allows 3 an hour from one address, however the tokens are', async () => {
      const address = `10.${(Math.random() * 255) | 0}.${(Math.random() * 255) | 0}.77`
      const post = () =>
        anonymousApi(app)
          .post(ApiRoutes.invitations.accept('not-a-token'))
          .set('x-forwarded-for', address)
          .send({ name: 'Guest' })

      const statuses = []
      for (let attempt = 0; attempt < 4; attempt += 1) statuses.push((await post()).status)

      expect(statuses).toEqual([404, 404, 404, 429])
    })
  })
})
