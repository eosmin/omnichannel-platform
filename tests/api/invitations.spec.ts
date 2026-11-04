import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { AuditAction } from '@platform/core/audit'
import {
  INVITATION_RESEND_COOLDOWN_SECONDS,
  INVITATION_TTL_DAYS,
  Permissions,
  RoleNames
} from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import type { OwnerClient } from '@platform/core/database-testing'
import { MembershipStatus } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'
import { EmailTemplates } from '@platform/core/queues'

import { createTestApp } from '../helpers/app'
import { createActor, seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { emailsOf } from '../helpers/email'
import { api } from '../helpers/http'

interface InvitationBody {
  id: string
  email: string
  role: { id: string; name: string }
  invitedBy: string
  expiresAt: string
  expired: boolean
}
interface ErrorBody {
  error: { code: string }
}

const MS_PER_DAY = 86_400_000
const URL_TOKEN = /\/invitations\/([A-Za-z0-9_-]+)$/

describe('Inviting to a store', () => {
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

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const newEmail = (): string => {
    counter += 1
    return `${prefix}-invited${counter}@example.com`
  }
  const invite = (email: string, roleId = ctx.roleIds[RoleNames.AGENT]) =>
    asAdmin().post(ApiRoutes.settings.members).send({ email, roleId })

  // The cooldown between two invitations to one address has passed
  const ageInvitation = (id: string) =>
    owner.invitation.update({
      where: { id },
      data: { createdAt: new Date(Date.now() - 2 * INVITATION_RESEND_COOLDOWN_SECONDS * 1000) }
    })

  // The token that went out in the email: the only copy there is
  function tokenSentTo(email: string): string {
    const job = emailsOf(app).to(email.toLowerCase()).at(-1)
    const token = URL_TOKEN.exec((job?.data as { url: string }).url)?.[1]
    if (token === undefined) throw new Error(`no invitation was sent to ${email}`)
    return token
  }

  async function auditEntry(action: string, resourceId: string) {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const entry = await owner.auditLog.findFirst({ where: { action, resourceId } })
      if (entry !== null) return entry
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return null
  }

  describe('creating an invitation', () => {
    it('saves it pending with the hash of the token, and sends the link', async () => {
      const email = newEmail()

      const response = await invite(email)

      expect(response.status).toBe(201)
      const body = response.body as InvitationBody
      expect(body).toMatchObject({
        email,
        role: { id: ctx.roleIds[RoleNames.AGENT], name: RoleNames.AGENT },
        invitedBy: 'adminA',
        expired: false
      })
      const token = tokenSentTo(email)
      const row = await owner.invitation.findUniqueOrThrow({ where: { id: body.id } })
      expect(row).toMatchObject({
        status: 'PENDING',
        storeId: ctx.storeA.id,
        organizationId: ctx.orgA.id,
        invitedById: ctx.adminA.id,
        tokenHash: hashToken(token)
      })
      expect(row.tokenHash).not.toBe(token)
      const days = (row.expiresAt.getTime() - Date.now()) / MS_PER_DAY
      expect(days).toBeGreaterThan(INVITATION_TTL_DAYS - 0.01)
      expect(days).toBeLessThanOrEqual(INVITATION_TTL_DAYS)
      expect(token).toHaveLength(43) // 256 bits in base64url
    })

    it('sends it in the language of the store, with the names the invitee needs', async () => {
      const email = newEmail()
      await invite(email)

      const job = emailsOf(app).to(email).at(-1)

      expect(job).toMatchObject({
        template: EmailTemplates.INVITATION,
        locale: 'es',
        data: {
          inviterName: 'adminA',
          storeName: `${prefix}-store-a`,
          // The system roles are stored in English; the email names them in the language it speaks
          roleName: 'Agente',
          expiresInDays: INVITATION_TTL_DAYS
        }
      })
    })

    it('gives the invitee no access and creates no account until they accept', async () => {
      const email = newEmail()
      await invite(email)

      expect(await owner.user.findFirst({ where: { email } })).toBeNull()
      const members = await asAdmin().get(ApiRoutes.settings.members)
      expect(JSON.stringify(members.body)).not.toContain(email)
    })

    it('never answers with the token, and never writes it to the audit trail', async () => {
      const email = newEmail()

      const response = await invite(email)

      const token = tokenSentTo(email)
      expect(JSON.stringify(response.body)).not.toContain(token)
      const entry = await auditEntry(
        AuditAction.MEMBER_INVITED,
        (response.body as InvitationBody).id
      )
      expect(entry).toMatchObject({ userId: ctx.adminA.id, storeId: ctx.storeA.id })
      expect(JSON.stringify(entry)).not.toContain(token)
      expect(JSON.stringify(entry)).not.toContain(email)
    })

    it('writes the address in lower case, and finds an existing member whatever the case', async () => {
      const email = newEmail()
      const mixed = email.replace('invited', 'InViTeD').toUpperCase()

      const created = await invite(mixed)
      const member = await invite(ctx.viewerA.email.toUpperCase())

      expect((created.body as InvitationBody).email).toBe(email)
      expect(member.status).toBe(409)
      expect((member.body as ErrorBody).error.code).toBe(ErrorCodes.TENANT_MEMBER_ALREADY_EXISTS)
    })

    it('refuses an address that is a suspended member, and says to reactivate it', async () => {
      const suspended = await createActor(owner, app, {
        prefix,
        name: `suspendedInvitee${randomUUID().slice(0, 6)}`,
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: ctx.roleIds[RoleNames.AGENT]
      })
      await owner.membership.updateMany({
        where: { userId: suspended.id, storeId: ctx.storeA.id },
        data: { status: MembershipStatus.SUSPENDED }
      })

      const response = await invite(suspended.email)

      expect(response.status).toBe(409)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.TENANT_INVITEE_SUSPENDED)
      expect(emailsOf(app).to(suspended.email.toLowerCase())).toHaveLength(0)
    })

    it('replaces the pending invitation of the same address: the old link stops being valid', async () => {
      const email = newEmail()
      const first = (await invite(email)).body as InvitationBody
      const oldToken = tokenSentTo(email)
      await ageInvitation(first.id)

      const second = (await invite(email)).body as InvitationBody

      expect(second.id).not.toBe(first.id)
      expect(tokenSentTo(email)).not.toBe(oldToken)
      expect(emailsOf(app).to(email)).toHaveLength(2)
      const rows = await owner.invitation.findMany({ where: { storeId: ctx.storeA.id, email } })
      expect(rows.map(row => row.status).sort()).toEqual(['PENDING', 'REVOKED'])
      expect(rows.find(row => row.status === 'PENDING')?.id).toBe(second.id)
    })

    it('does not send the same address another invitation within the minute', async () => {
      const email = newEmail()
      await invite(email)

      const again = await invite(email)

      expect(again.status).toBe(429)
      expect((again.body as ErrorBody).error.code).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
      expect(emailsOf(app).to(email)).toHaveLength(1)
    })

    it('may invite the same address to two stores', async () => {
      const email = newEmail()

      const here = await invite(email)
      const there = await api(app, ctx.adminA2, ctx.storeA2)
        .post(ApiRoutes.settings.members)
        .send({ email, roleId: ctx.roleIds[RoleNames.AGENT] })

      expect([here.status, there.status]).toEqual([201, 201])
    })

    it('does not invite into a role of another store', async () => {
      const foreign = await owner.role.create({
        data: { storeId: ctx.storeB.id, name: `${prefix}-foreign` }
      })

      const response = await invite(newEmail(), foreign.id)

      expect(response.status).toBe(404)
    })

    it('does not invite into a role that holds what the inviter lacks', async () => {
      const inviterRole = await owner.role.create({
        data: {
          storeId: ctx.storeA.id,
          name: `${prefix}-inviter`,
          permissions: { create: [{ name: Permissions.TEAM_INVITE }] }
        }
      })
      const inviter = await createActor(owner, app, {
        prefix,
        name: 'inviter',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: inviterRole.id
      })

      const response = await api(app, inviter, ctx.storeA)
        .post(ApiRoutes.settings.members)
        .send({ email: newEmail(), roleId: ctx.roleIds[RoleNames.ADMIN] })

      expect(response.status).toBe(403)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.PERMISSION_DENIED)
    })

    it.each([
      ['an address that is not one', { email: 'not-an-email', roleId: randomUUID() }],
      ['no role', { email: 'a@example.com' }],
      ['a role that is not an id', { email: 'a@example.com', roleId: 'Admin' }],
      [
        'a store in the body',
        { email: 'a@example.com', roleId: randomUUID(), storeId: randomUUID() }
      ]
    ])('refuses %s', async (_label, body) => {
      const response = await asAdmin().post(ApiRoutes.settings.members).send(body)

      expect(response.status).toBe(400)
    })

    it('is refused to a member without the permission', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA)
        .post(ApiRoutes.settings.members)
        .send({ email: newEmail(), roleId: ctx.roleIds[RoleNames.VIEWER] })

      expect(response.status).toBe(403)
    })
  })

  describe('the pending invitations', () => {
    it('are listed for the store, with whether they have expired', async () => {
      const live = (await invite(newEmail())).body as InvitationBody
      const stale = (await invite(newEmail())).body as InvitationBody
      await owner.invitation.update({
        where: { id: stale.id },
        data: { expiresAt: new Date(Date.now() - 1000) }
      })

      const response = await asAdmin().get(ApiRoutes.settings.invitations)

      expect(response.status).toBe(200)
      const rows = response.body as InvitationBody[]
      expect(rows.find(row => row.id === live.id)?.expired).toBe(false)
      expect(rows.find(row => row.id === stale.id)?.expired).toBe(true)
    })

    it('leave the list once revoked, and the other stores’ are not in it', async () => {
      const mine = (await invite(newEmail())).body as InvitationBody
      const elsewhere = (
        await api(app, ctx.adminA2, ctx.storeA2)
          .post(ApiRoutes.settings.members)
          .send({ email: newEmail(), roleId: ctx.roleIds[RoleNames.AGENT] })
      ).body as InvitationBody
      await asAdmin().delete(ApiRoutes.settings.invitationById(mine.id))

      const ids = (
        (await asAdmin().get(ApiRoutes.settings.invitations)).body as InvitationBody[]
      ).map(row => row.id)

      expect(ids).not.toContain(mine.id)
      expect(ids).not.toContain(elsewhere.id)
    })

    it('are listed only to those who may see the team', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA).get(ApiRoutes.settings.invitations)

      expect(response.status).toBe(403)
    })
  })

  describe('resending an invitation', () => {
    const resend = (id: string, as = asAdmin()) => as.post(ApiRoutes.settings.invitationResend(id))

    it('issues a new token, ends the old link and sends the email again', async () => {
      const email = newEmail()
      const first = (await invite(email)).body as InvitationBody
      const oldToken = tokenSentTo(email)
      await ageInvitation(first.id)

      const response = await resend(first.id)

      expect(response.status).toBe(200)
      const second = response.body as InvitationBody
      expect(second.id).not.toBe(first.id)
      expect(second).toMatchObject({
        email,
        role: { id: ctx.roleIds[RoleNames.AGENT], name: RoleNames.AGENT },
        expired: false
      })
      const newToken = tokenSentTo(email)
      expect(newToken).not.toBe(oldToken)
      expect(emailsOf(app).to(email)).toHaveLength(2)
      const rows = await owner.invitation.findMany({ where: { storeId: ctx.storeA.id, email } })
      expect(rows.find(row => row.id === first.id)?.status).toBe('REVOKED')
      expect(rows.find(row => row.id === second.id)).toMatchObject({
        status: 'PENDING',
        tokenHash: hashToken(newToken)
      })
      expect(JSON.stringify(response.body)).not.toContain(newToken)
    })

    it('brings back an invitation whose link expired, with a full lifetime', async () => {
      const email = newEmail()
      const first = (await invite(email)).body as InvitationBody
      await owner.invitation.update({
        where: { id: first.id },
        data: {
          expiresAt: new Date(Date.now() - 1000),
          createdAt: new Date(Date.now() - 2 * INVITATION_RESEND_COOLDOWN_SECONDS * 1000)
        }
      })

      const response = await resend(first.id)

      expect(response.status).toBe(200)
      const days =
        (new Date((response.body as InvitationBody).expiresAt).getTime() - Date.now()) / MS_PER_DAY
      expect(days).toBeGreaterThan(INVITATION_TTL_DAYS - 0.01)
    })

    it('does not bring back an invitation that was revoked while the resend was on its way', async () => {
      // Several rounds, so that both orders of the two requests are likely to happen
      for (let round = 0; round < 5; round += 1) {
        const email = newEmail()
        const first = (await invite(email)).body as InvitationBody
        await ageInvitation(first.id)

        const [revoked, resent] = await Promise.all([
          asAdmin().delete(ApiRoutes.settings.invitationById(first.id)),
          resend(first.id)
        ])

        // The revoke wins (204) or finds the invitation already replaced by the resend (404)
        expect([204, 404]).toContain(revoked.status)
        expect([200, 404]).toContain(resent.status)
        // The invitation that was resent or revoked is never pending again, whatever the order was
        const old = await owner.invitation.findUniqueOrThrow({ where: { id: first.id } })
        expect(old.status).not.toBe('PENDING')
        // What is pending is the new invitation if the resend came first, and nothing if it found none
        const pending = await owner.invitation.findMany({
          where: { storeId: ctx.storeA.id, email, status: 'PENDING' },
          select: { id: true }
        })
        if (resent.status === 200) {
          expect(pending.map(row => row.id)).toEqual([(resent.body as InvitationBody).id])
        } else {
          expect(pending).toEqual([])
        }
      }
    })

    it('audits it as a resend, without the address or the token', async () => {
      const email = newEmail()
      const first = (await invite(email)).body as InvitationBody
      await ageInvitation(first.id)

      const second = (await resend(first.id)).body as InvitationBody

      const entry = await auditEntry(AuditAction.INVITATION_RESENT, second.id)
      expect(entry).toMatchObject({ userId: ctx.adminA.id, storeId: ctx.storeA.id })
      expect(entry?.metadata).toMatchObject({ replacedInvitationId: first.id })
      expect(JSON.stringify(entry)).not.toContain(tokenSentTo(email))
      expect(JSON.stringify(entry)).not.toContain(email)
    })

    it('is held to the cooldown of inviting: a second resend at once is a 429 and sends nothing', async () => {
      const email = newEmail()
      const first = (await invite(email)).body as InvitationBody
      await ageInvitation(first.id)
      const second = (await resend(first.id)).body as InvitationBody

      const again = await resend(second.id)

      expect(again.status).toBe(429)
      expect((again.body as ErrorBody).error.code).toBe(ErrorCodes.RATE_LIMIT_EXCEEDED)
      expect(emailsOf(app).to(email)).toHaveLength(2)
    })

    it('answers 404 to a revoked one, an accepted one, a missing one and one of another store', async () => {
      const revoked = (await invite(newEmail())).body as InvitationBody
      await asAdmin().delete(ApiRoutes.settings.invitationById(revoked.id))
      const accepted = (await invite(newEmail())).body as InvitationBody
      await owner.invitation.update({ where: { id: accepted.id }, data: { status: 'ACCEPTED' } })
      const elsewhere = (
        await api(app, ctx.adminA2, ctx.storeA2)
          .post(ApiRoutes.settings.members)
          .send({ email: newEmail(), roleId: ctx.roleIds[RoleNames.AGENT] })
      ).body as InvitationBody
      const before = emailsOf(app).jobs.length

      for (const id of [revoked.id, accepted.id, randomUUID(), elsewhere.id]) {
        expect((await resend(id)).status).toBe(404)
      }

      expect(emailsOf(app).jobs).toHaveLength(before)
      expect(
        (await owner.invitation.findUniqueOrThrow({ where: { id: elsewhere.id } })).status
      ).toBe('PENDING')
    })

    it('is refused to a member without the permission, and to a path that is not an id', async () => {
      const invitation = (await invite(newEmail())).body as InvitationBody

      expect((await resend(invitation.id, api(app, ctx.viewerA, ctx.storeA))).status).toBe(403)
      expect((await resend('not-an-id')).status).toBe(400)
    })

    it('does not resend into a role that holds what the caller lacks', async () => {
      const inviterRole = await owner.role.create({
        data: {
          storeId: ctx.storeA.id,
          name: `${prefix}-resender`,
          permissions: { create: [{ name: Permissions.TEAM_INVITE }] }
        }
      })
      const resender = await createActor(owner, app, {
        prefix,
        name: 'resender',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        roleId: inviterRole.id
      })
      const adminInvitation = (await invite(newEmail(), ctx.roleIds[RoleNames.ADMIN]))
        .body as InvitationBody
      await ageInvitation(adminInvitation.id)

      const response = await resend(adminInvitation.id, api(app, resender, ctx.storeA))

      expect(response.status).toBe(403)
      expect((response.body as ErrorBody).error.code).toBe(ErrorCodes.PERMISSION_DENIED)
    })
  })

  describe('revoking an invitation', () => {
    it('ends it, keeps the record, and audits it', async () => {
      const invitation = (await invite(newEmail())).body as InvitationBody

      const response = await asAdmin().delete(ApiRoutes.settings.invitationById(invitation.id))

      expect(response.status).toBe(204)
      expect(
        (await owner.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).status
      ).toBe('REVOKED')
      expect(await auditEntry(AuditAction.INVITATION_REVOKED, invitation.id)).not.toBeNull()
    })

    it('answers 404 to one already revoked, one that does not exist, and one of another store', async () => {
      const invitation = (await invite(newEmail())).body as InvitationBody
      await asAdmin().delete(ApiRoutes.settings.invitationById(invitation.id))
      const elsewhere = (
        await api(app, ctx.adminA2, ctx.storeA2)
          .post(ApiRoutes.settings.members)
          .send({ email: newEmail(), roleId: ctx.roleIds[RoleNames.AGENT] })
      ).body as InvitationBody

      const again = await asAdmin().delete(ApiRoutes.settings.invitationById(invitation.id))
      const unknown = await asAdmin().delete(ApiRoutes.settings.invitationById(randomUUID()))
      const foreign = await asAdmin().delete(ApiRoutes.settings.invitationById(elsewhere.id))

      expect([again.status, unknown.status, foreign.status]).toEqual([404, 404, 404])
      expect(
        (await owner.invitation.findUniqueOrThrow({ where: { id: elsewhere.id } })).status
      ).toBe('PENDING')
    })

    it('is refused to a member without the permission', async () => {
      const response = await api(app, ctx.viewerA, ctx.storeA).delete(
        ApiRoutes.settings.invitationById(randomUUID())
      )

      expect(response.status).toBe(403)
    })
  })
})
