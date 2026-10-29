import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import type { AuthenticatedUser } from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import { isUniqueViolation, PrismaService, type PrismaTransaction } from '@platform/core/database'
import { InvitationStatus, MembershipStatus } from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  RefusalReasons,
  resourceConflict,
  unauthorized
} from '@platform/core/errors'

import type { IssuedSession, SessionContext } from '../auth/session.service'
import { SessionService } from '../auth/session.service'
import { TenantContextService } from '../tenancy'

export interface InvitationPreview {
  email: string
  storeName: string
  roleName: string
  inviterName: string
  expiresAt: Date
}

export interface AcceptedInvitation {
  store: { id: string; name: string }
  role: string
  // Only when the accept created the account: the person has no session yet
  session?: IssuedSession
  user?: { id: string; email: string; name: string }
}

interface Account {
  id: string
  email: string
  name: string
}

// The public side of an invitation: whoever holds the link sees what it is for, and accepts it. The
// token is the credential, so everything unknown, used or revoked answers the same.
@Injectable()
export class InvitationAcceptService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly audit: AuditService,
    private readonly tenants: TenantContextService
  ) {}

  async preview(token: string): Promise<InvitationPreview> {
    const invitation = await this.find(token)
    return {
      email: invitation.email,
      storeName: invitation.store.name,
      roleName: invitation.role.name,
      inviterName: invitation.invitedBy.name,
      expiresAt: invitation.expiresAt
    }
  }

  // Three cases (Step 1.4):
  //  a) no account for the address: the person names themselves and the account, the membership
  //     and the session are created together;
  //  b) an account, and a session for that address: the membership is created;
  //  c) a session for another address: refused. An account and no session: the person logs in
  //     first (the magic link) and comes back.
  async accept(
    token: string,
    input: { name?: string | undefined },
    session: AuthenticatedUser | undefined,
    context: SessionContext
  ): Promise<AcceptedInvitation> {
    const invitation = await this.find(token)

    // Everything is decided inside the transaction, after the claim: of two requests with the same
    // link the second waits for the first and then finds the link used, whatever the account says
    // by then. A refusal rolls the claim back, so the link still works.
    const accepted = await this.write(async tx => {
      const claim = await tx.invitation.updateMany({
        where: {
          id: invitation.id,
          status: InvitationStatus.PENDING,
          expiresAt: { gt: new Date() }
        },
        data: { status: InvitationStatus.ACCEPTED, acceptedAt: new Date() }
      })
      if (claim.count === 0) throw invalid()

      // With a session the account is the one of the session, whatever else shares the address
      const account =
        session === undefined
          ? await this.accountOf(tx, invitation.email)
          : await this.accountOfSession(tx, session, invitation.email)
      if (session === undefined && account !== null) {
        throw unauthorized('sign in with the invited address to accept', {
          reason: RefusalReasons.LOGIN_REQUIRED
        })
      }
      if (account === null && input.name === undefined) {
        throw new PlatformException(
          ErrorCodes.VALIDATION_FAILED,
          'a name is needed to create the account',
          HttpStatusCodes.BAD_REQUEST,
          { issues: [{ path: 'name', code: 'invalid_type', message: 'Required' }] }
        )
      }

      const user: Account =
        account ??
        (await tx.user.create({
          data: {
            email: invitation.email,
            name: input.name ?? '',
            // The link reached this inbox: the address is proven
            emailVerified: true,
            locale: invitation.store.defaultLocale
          },
          select: { id: true, email: true, name: true }
        }))
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { acceptedById: user.id }
      })
      const membershipId = await this.join(tx, user.id, invitation)
      return {
        user,
        membershipId,
        newAccount: account === null,
        issued: account === null ? await this.sessions.issue(user, context, tx) : undefined
      }
    })

    await this.tenants.invalidateUser(accepted.user.id, invitation.storeId)
    this.audit.log({
      action: AuditAction.MEMBER_JOINED,
      actor: { userId: accepted.user.id },
      storeId: invitation.storeId,
      organizationId: invitation.organizationId,
      resourceType: 'membership',
      resourceId: accepted.membershipId,
      metadata: {
        invitationId: invitation.id,
        role: invitation.role.name,
        newAccount: accepted.newAccount
      },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    })
    return {
      store: { id: invitation.storeId, name: invitation.store.name },
      role: invitation.role.name,
      ...(accepted.issued === undefined ? {} : { session: accepted.issued, user: accepted.user })
    }
  }

  private async find(token: string) {
    const invitation = await this.prisma.client.invitation.findUnique({
      where: { tokenHash: hashToken(token) },
      include: {
        store: { select: { name: true, defaultLocale: true } },
        role: { select: { name: true } },
        invitedBy: { select: { name: true } }
      }
    })
    if (invitation === null || invitation.status !== String(InvitationStatus.PENDING))
      throw invalid()
    if (invitation.expiresAt.getTime() <= Date.now()) {
      throw new PlatformException(
        ErrorCodes.TENANT_INVITATION_EXPIRED,
        'invitation expired',
        HttpStatusCodes.GONE
      )
    }
    return invitation
  }

  // Compared in lower case, as the login does: the seed stores an address as it was written
  private async accountOf(tx: PrismaTransaction, email: string): Promise<Account | null> {
    const rows = await tx.$queryRaw<Account[]>`
      SELECT id, email, name FROM users WHERE lower(email) = ${email} LIMIT 1`
    return rows[0] ?? null
  }

  // The session must be of the very account the invitation names; the address in the token is not
  // enough, the account is read from the database
  private async accountOfSession(
    tx: PrismaTransaction,
    session: AuthenticatedUser,
    invitedEmail: string
  ): Promise<Account> {
    const user = await tx.user.findUnique({
      where: { id: session.id },
      select: { id: true, email: true, name: true }
    })
    if (user === null) {
      throw unauthorized('account no longer exists')
    }
    if (user.email.toLowerCase() !== invitedEmail) {
      throw new PlatformException(
        ErrorCodes.TENANT_INVITATION_EMAIL_MISMATCH,
        'the invitation is for another address',
        HttpStatusCodes.FORBIDDEN
      )
    }
    return user
  }

  // The membership of the invitee in the store: new, or the one that was revoked before, brought back
  private async join(
    tx: PrismaTransaction,
    userId: string,
    invitation: { id: string; organizationId: string; storeId: string; roleId: string }
  ): Promise<string> {
    const existing = await tx.membership.findUnique({
      where: { userId_storeId: { userId, storeId: invitation.storeId } },
      select: { id: true, status: true, revokedAt: true }
    })
    if (existing === null) {
      const created = await tx.membership.create({
        data: {
          userId,
          organizationId: invitation.organizationId,
          storeId: invitation.storeId,
          roleId: invitation.roleId,
          status: MembershipStatus.ACTIVE,
          invitationId: invitation.id
        },
        select: { id: true }
      })
      return created.id
    }
    if (existing.status === String(MembershipStatus.ACTIVE) && existing.revokedAt === null) {
      throw new PlatformException(
        ErrorCodes.TENANT_MEMBER_ALREADY_EXISTS,
        'already a member of the store',
        HttpStatusCodes.CONFLICT
      )
    }
    await tx.membership.update({
      where: { id: existing.id },
      data: {
        status: MembershipStatus.ACTIVE,
        revokedAt: null,
        roleId: invitation.roleId,
        invitationId: invitation.id
      }
    })
    return existing.id
  }

  // All or nothing: a failure leaves no user, no membership and an invitation still pending
  private async write<T>(work: (tx: PrismaTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.prisma.transaction(work)
    } catch (error) {
      // The account was created between the lookup and the insert
      if (isUniqueViolation(error)) {
        throw resourceConflict('the account was created meanwhile: try again')
      }
      throw error
    }
  }
}

function invalid(): PlatformException {
  return new PlatformException(
    ErrorCodes.TENANT_INVITATION_INVALID,
    'invalid invitation',
    HttpStatusCodes.NOT_FOUND
  )
}
