import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  INVITATION_RESEND_COOLDOWN_SECONDS,
  INVITATION_TTL_DAYS,
  INVITATION_WEB_PATH,
  type Permission
} from '@platform/core/auth'
import { AUTH_SETTINGS, type AuthSettings } from '@platform/core/auth-module'
import { generateToken, hashToken } from '@platform/core/crypto'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import { InvitationStatus, MembershipStatus } from '@platform/core/domain'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import { DEFAULT_LOCALE, type Locale, SUPPORTED_LOCALES } from '@platform/core/i18n'
import { EmailTemplates, JobNames, QueueNames, type SendEmailJob } from '@platform/core/queues'

import { normalizeEmail } from '../auth/magic-link.service'
import { type Actor, missingPermissions } from '../tenancy'

const MS_PER_DAY = 86_400_000
const MS_PER_SECOND = 1000
const HTTP_TOO_MANY_REQUESTS = 429
const HTTP_FORBIDDEN = 403
const HTTP_NOT_FOUND = 404
const HTTP_CONFLICT = 409

export interface InvitationView {
  id: string
  email: string
  role: { id: string; name: string }
  invitedBy: string
  expiresAt: Date
  createdAt: Date
  expired: boolean
}

const INVITATION_SELECT = {
  id: true,
  email: true,
  expiresAt: true,
  createdAt: true,
  role: { select: { id: true, name: true } },
  invitedBy: { select: { name: true } }
} as const

function view(row: {
  id: string
  email: string
  expiresAt: Date
  createdAt: Date
  role: { id: string; name: string }
  invitedBy: { name: string }
}): InvitationView {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    invitedBy: row.invitedBy.name,
    expiresAt: row.expiresAt,
    createdAt: row.createdAt,
    expired: row.expiresAt.getTime() <= Date.now()
  }
}

// An invitation is not a membership: nobody gets access until the invitee accepts it. The link
// holds the only copy of the token (the database keeps its hash), so the invitation cannot be shown
// again, only replaced.
@Injectable()
export class InvitationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @InjectQueue(QueueNames.EMAIL) private readonly emailQueue: Queue<SendEmailJob>,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings
  ) {}

  async list(storeId: string): Promise<InvitationView[]> {
    const rows = await this.prisma.client.invitation.findMany({
      where: { storeId, status: InvitationStatus.PENDING },
      select: INVITATION_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }]
    })
    return rows.map(view)
  }

  // Inviting an address that already has a pending invitation replaces it: the old link stops
  // working and the new one is sent, which is how an invitation is resent.
  async invite(
    store: { id: string; organizationId: string; name: string },
    input: { email: string; roleId: string },
    actor: Actor,
    held: readonly Permission[]
  ): Promise<InvitationView> {
    const email = normalizeEmail(input.email)
    const role = await this.prisma.client.role.findFirst({
      where: {
        id: input.roleId,
        OR: [{ storeId: store.id }, { isSystem: true, storeId: null }]
      },
      select: { id: true, name: true, permissions: { select: { name: true } } }
    })
    if (role === null) throw notFound('role')
    // Nobody invites into a role that can do what they cannot
    const missing = missingPermissions(
      held,
      role.permissions.map(permission => permission.name)
    )
    if (missing.length > 0) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'a member cannot be invited into a role that holds permissions the caller lacks',
        HTTP_FORBIDDEN,
        { permissions: missing }
      )
    }
    if (await this.isMember(store.id, email)) {
      throw new PlatformException(
        ErrorCodes.TENANT_MEMBER_ALREADY_EXISTS,
        'that address is already a member of the store',
        HTTP_CONFLICT
      )
    }

    await this.requireCooldownPassed(store.id, email)

    const token = generateToken()
    const invitation = await this.replacePending(store, email, role.id, token, actor)
    const [inviter, destination] = await Promise.all([
      this.prisma.client.user.findUniqueOrThrow({
        where: { id: actor.userId },
        select: { name: true }
      }),
      this.localeFor(store.id, email)
    ])
    // After the commit: a mail must never go out for an invitation that was not saved
    await this.emailQueue.add(
      JobNames.SEND_EMAIL,
      {
        template: EmailTemplates.INVITATION,
        to: email,
        locale: destination,
        data: {
          url: this.linkFor(token),
          inviterName: inviter.name,
          storeName: store.name,
          roleName: role.name,
          expiresInDays: INVITATION_TTL_DAYS
        },
        tags: { template: EmailTemplates.INVITATION }
      },
      // The job holds the raw token: once sent it has no reason to stay in the queue
      { removeOnComplete: true }
    )
    this.audit.log({
      action: AuditAction.MEMBER_INVITED,
      actor: { userId: actor.userId },
      storeId: store.id,
      organizationId: store.organizationId,
      resourceType: 'invitation',
      resourceId: invitation.id,
      metadata: { roleId: role.id, role: role.name },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return view(invitation)
  }

  async revoke(storeId: string, invitationId: string, actor: Actor): Promise<void> {
    const { count } = await this.prisma.client.invitation.updateMany({
      where: { id: invitationId, storeId, status: InvitationStatus.PENDING },
      data: { status: InvitationStatus.REVOKED }
    })
    if (count === 0) throw notFound('invitation')
    this.audit.log({
      action: AuditAction.INVITATION_REVOKED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: 'invitation',
      resourceId: invitationId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  // Replacing an invitation sends an email, so one address cannot be asked for it again at once
  private async requireCooldownPassed(storeId: string, email: string): Promise<void> {
    const recent = await this.prisma.client.invitation.findFirst({
      where: {
        storeId,
        email,
        status: InvitationStatus.PENDING,
        createdAt: { gt: new Date(Date.now() - INVITATION_RESEND_COOLDOWN_SECONDS * MS_PER_SECOND) }
      },
      select: { id: true }
    })
    if (recent !== null) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'that address was invited a moment ago',
        HTTP_TOO_MANY_REQUESTS,
        { retryAfterSeconds: INVITATION_RESEND_COOLDOWN_SECONDS }
      )
    }
  }

  private async replacePending(
    store: { id: string; organizationId: string },
    email: string,
    roleId: string,
    token: string,
    actor: Actor
  ) {
    try {
      return await this.prisma.transaction(async tx => {
        await tx.invitation.updateMany({
          where: { storeId: store.id, email, status: InvitationStatus.PENDING },
          data: { status: InvitationStatus.REVOKED }
        })
        return tx.invitation.create({
          data: {
            organizationId: store.organizationId,
            storeId: store.id,
            email,
            roleId,
            tokenHash: hashToken(token),
            invitedById: actor.userId,
            expiresAt: new Date(Date.now() + INVITATION_TTL_DAYS * MS_PER_DAY)
          },
          select: INVITATION_SELECT
        })
      })
    } catch (error) {
      // Two invitations for the same address at the same moment: the second one loses
      if (isUniqueViolation(error)) {
        throw new PlatformException(
          ErrorCodes.RESOURCE_CONFLICT,
          'an invitation for that address is being created',
          HTTP_CONFLICT
        )
      }
      throw error
    }
  }

  // Compared in lower case, as the login does: the seed stores an address as it was written
  private async isMember(storeId: string, email: string): Promise<boolean> {
    const rows = await this.prisma.client.$queryRaw<{ id: string }[]>`
      SELECT m.id FROM memberships m JOIN users u ON u.id = m.user_id
      WHERE m.store_id = ${storeId} AND m.status = ${MembershipStatus.ACTIVE}
        AND m.revoked_at IS NULL AND lower(u.email) = ${email}
      LIMIT 1`
    return rows.length > 0
  }

  // The language of the person if they already have an account, otherwise the one of the store
  private async localeFor(storeId: string, email: string): Promise<Locale> {
    const users = await this.prisma.client.$queryRaw<{ locale: string }[]>`
      SELECT locale FROM users WHERE lower(email) = ${email} LIMIT 1`
    const store = await this.prisma.client.store.findUniqueOrThrow({
      where: { id: storeId },
      select: { defaultLocale: true }
    })
    return localeOrDefault(users[0]?.locale ?? store.defaultLocale)
  }

  private linkFor(token: string): string {
    return new URL(`${INVITATION_WEB_PATH}/${token}`, this.settings.frontendUrl).toString()
  }
}

function localeOrDefault(value: string): Locale {
  return SUPPORTED_LOCALES.find(locale => locale === value) ?? DEFAULT_LOCALE
}

function notFound(what: string): PlatformException {
  return new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, `${what} not found`, HTTP_NOT_FOUND)
}
