import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  type AccessTokenClaims,
  REFRESH_REUSE_GRACE_SECONDS,
  type SessionRevokedReason,
  SessionRevokedReasons
} from '@platform/core/auth'
import { AUTH_SETTINGS, type AuthSettings } from '@platform/core/auth-module'
import { generateToken, hashToken } from '@platform/core/crypto'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import {
  ErrorCodes,
  HttpStatusCodes,
  resourceNotFound,
  PlatformException
} from '@platform/core/errors'

const MS_PER_SECOND = 1000
const MAX_USER_AGENT_LENGTH = 255

export interface SessionUser {
  id: string
  email: string
}

// Where the login came from, kept with the session so the user can recognise it in the list
export interface SessionContext {
  userAgent?: string | undefined
  ipAddress?: string | undefined
}

// What every way of logging in answers with
export interface IssuedSession {
  accessToken: string
  refreshToken: string
  tokenType: 'Bearer'
  expiresIn: number // Seconds the access token lives
  refreshExpiresAt: string // ISO 8601
}

export interface ActiveSession {
  id: string // The family: it stays the same when the refresh token rotates
  userAgent: string | null
  ipAddress: string | null
  lastActiveAt: Date
  current: boolean
}

type Database = PrismaService['client']

// Why a consumed token that came back was judged a leak, for the log: it tells a real replay (long
// after) from the cases the grace window is meant to measure
type ReuseCause =
  | 'outside_window'
  | 'no_successor'
  | 'grace_not_available'
  | 'successor_used'
  | 'grace_context_mismatch'

// A Session row with its user, as refresh() reads it
interface ConsumedSession {
  id: string
  userId: string
  familyId: string
  expiresAt: Date
  familyExpiresAt: Date
  consumedAt: Date | null
  replacedById: string | null
  userAgent: string | null
  ipAddress: string | null
  user: SessionUser
}

// Access tokens are stateless JWTs; the refresh token is an opaque secret whose hash is the
// Session row. Using it rotates it: the row is marked consumed and the next one joins the same
// family. Presenting a consumed token means it leaked, so the whole family is revoked
// (TDD_01 section 7), unless it comes back once within REFRESH_REUSE_GRACE_SECONDS of being used
// while its successor is still unused: that is the answer of a refresh that got lost on the way to
// the browser, not a leak. The code that issues the pair is here so that any way of logging in, the
// magic link today and the invitation accept of Step 1.4, goes through the same door.
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    private readonly logger: PinoLogger,
    private readonly audit: AuditService
  ) {
    this.logger.setContext(SessionService.name)
  }

  // A new login: a new family. Pass the transaction to make the session part of a larger one.
  async issue(
    user: SessionUser,
    context: SessionContext = {},
    tx?: PrismaTransaction
  ): Promise<IssuedSession> {
    const familyExpiresAt = new Date(
      Date.now() + this.settings.sessionMaxAgeSeconds * MS_PER_SECOND
    )
    const { issued } = await this.createSession(
      user,
      randomUUID(),
      familyExpiresAt,
      context,
      tx ?? this.prisma.client
    )
    return issued
  }

  // Exchanges a refresh token for the next pair
  async refresh(refreshToken: string, context: SessionContext = {}): Promise<IssuedSession> {
    const session = await this.prisma.client.session.findUnique({
      where: { refreshTokenHash: hashToken(refreshToken) },
      include: { user: { select: { id: true, email: true } } }
    })
    // Unknown, or from a family that was revoked (logout, a reuse, the list of sessions)
    if (session === null || session.revokedAt !== null) throw invalidToken()
    if (session.consumedAt !== null) return this.graceOrReuse(session, context)
    // The row expires with the cap too (createSession), but the cap is checked on its own: it is the
    // end of the login, and a shortened cap in the data must hold even for rows that outlive it
    if (
      session.expiresAt.getTime() <= Date.now() ||
      session.familyExpiresAt.getTime() <= Date.now()
    ) {
      throw new PlatformException(
        ErrorCodes.AUTH_TOKEN_EXPIRED,
        'refresh token expired',
        HttpStatusCodes.UNAUTHORIZED
      )
    }
    const rotated = await this.prisma.transaction(async tx => {
      // The claim is the one atomic step: of two requests with the same token, only one gets count 1
      const claim = await tx.session.updateMany({
        where: { id: session.id, consumedAt: null, revokedAt: null },
        data: { consumedAt: new Date() }
      })
      if (claim.count === 0) return null
      const next = await this.createSession(
        session.user,
        session.familyId,
        session.familyExpiresAt,
        context,
        tx
      )
      await tx.session.update({
        where: { id: session.id },
        data: { replacedById: next.sessionId }
      })
      return next.issued
    })
    // Outside the transaction, so that revoking the family is not rolled back with it
    if (rotated !== null) return rotated
    // Lost the claim: another request with the same token rotated it a moment ago. Read it again,
    // now consumed, and judge it like any consumed token that came back.
    const current = await this.prisma.client.session.findUnique({
      where: { id: session.id },
      include: { user: { select: { id: true, email: true } } }
    })
    if (current === null || current.revokedAt !== null) throw invalidToken()
    return this.graceOrReuse(current, context)
  }

  // A consumed token came back. Inside the window, once, and only while the token that replaced it
  // has not been used, it gets the next pair on the same family; anything else is a leak. The claim
  // of the grace is one atomic step like the claim of the rotation, so two requests cannot both take
  // it. Of the two branches that result (the successor and the grace's pair) each lives only until
  // the family's cap, and a branch used after the other keeps working: this is the price of the
  // window (TDD_01 section 7).
  private async graceOrReuse(
    session: ConsumedSession,
    context: SessionContext
  ): Promise<IssuedSession> {
    const { consumedAt } = session
    const ageMs = consumedAt === null ? Number.POSITIVE_INFINITY : Date.now() - consumedAt.getTime()
    if (
      consumedAt === null ||
      session.replacedById === null ||
      session.expiresAt.getTime() <= Date.now() ||
      session.familyExpiresAt.getTime() <= Date.now() ||
      ageMs > REFRESH_REUSE_GRACE_SECONDS * MS_PER_SECOND
    ) {
      return this.reuseDetected(
        session.familyId,
        session.userId,
        session.replacedById === null ? 'no_successor' : 'outside_window'
      )
    }
    // Same browser or nothing: a copy of the token in other hands (another user agent) gets no grace.
    // The address may change (a phone moving between networks), so it is granted and recorded.
    const userAgent = context.userAgent?.slice(0, MAX_USER_AGENT_LENGTH) ?? null
    if (userAgent !== session.userAgent) {
      return this.reuseDetected(session.familyId, session.userId, 'grace_context_mismatch')
    }
    const ipChanged = (context.ipAddress ?? null) !== session.ipAddress
    const successorId = session.replacedById
    const granted = await this.prisma.transaction(async tx => {
      const claim = await tx.session.updateMany({
        where: {
          id: session.id,
          consumedAt: { gte: new Date(Date.now() - REFRESH_REUSE_GRACE_SECONDS * MS_PER_SECOND) },
          graceUsedAt: null,
          revokedAt: null
        },
        data: { graceUsedAt: new Date() }
      })
      if (claim.count === 0) return 'grace_not_available' as const
      // The successor must be alive and unused: if it was used, the login has moved on and this
      // token coming back is somebody holding a copy. This read does not serialize with a request
      // that rotates the successor at this very moment: the worst case is two live branches, which
      // a grace creates anyway, so it is left as a plain read.
      const successor = await tx.session.findFirst({
        where: { id: successorId, consumedAt: null, revokedAt: null }
      })
      if (successor === null) return 'successor_used' as const
      return (
        await this.createSession(
          session.user,
          session.familyId,
          session.familyExpiresAt,
          context,
          tx
        )
      ).issued
    })
    if (typeof granted === 'string') {
      return this.reuseDetected(session.familyId, session.userId, granted)
    }
    const log = ipChanged ? this.logger.warn.bind(this.logger) : this.logger.info.bind(this.logger)
    log(
      { familyId: session.familyId, userId: session.userId, ageMs, ipChanged },
      'a used refresh token came back inside the grace window: next pair issued'
    )
    this.audit.log({
      action: AuditAction.SESSION_REFRESH_GRACE,
      actor: { userId: session.userId },
      resourceType: 'session',
      resourceId: session.familyId,
      metadata: { ageMs, ipChanged },
      ipAddress: context.ipAddress,
      userAgent: context.userAgent
    })
    return granted
  }

  // Ends a login. Idempotent: a family that is already over stays over. The user is part of the
  // question, as in revokeOwn, so that no caller can end the login of someone else by mistake.
  async logout(userId: string, familyId: string): Promise<void> {
    await this.revokeFamily({ familyId, userId }, SessionRevokedReasons.LOGOUT)
  }

  async listActive(userId: string, currentFamilyId: string): Promise<ActiveSession[]> {
    const now = new Date()
    const rows = await this.prisma.client.session.findMany({
      // The end of the login too: a refresh past it is refused, so the login is not active
      where: {
        userId,
        revokedAt: null,
        consumedAt: null,
        expiresAt: { gt: now },
        familyExpiresAt: { gt: now }
      },
      orderBy: { createdAt: 'desc' }
    })
    // A grace leaves two live tokens in one family (TDD_01 section 7): one login, one entry. The rows
    // come newest first, so the newest of each family is the one that shows.
    const newestOfFamily = [
      ...new Map(rows.reverse().map(row => [row.familyId, row])).values()
    ].reverse()
    return newestOfFamily.map(row => ({
      id: row.familyId,
      userAgent: row.userAgent,
      ipAddress: row.ipAddress,
      lastActiveAt: row.createdAt,
      current: row.familyId === currentFamilyId
    }))
  }

  // From the list of sessions. A family of another user answers exactly like one that does not exist.
  async revokeOwn(userId: string, familyId: string): Promise<void> {
    const revoked = await this.revokeFamily(
      { familyId, userId },
      SessionRevokedReasons.REVOKED_BY_USER
    )
    if (revoked === 0) {
      throw resourceNotFound('session')
    }
  }

  private async reuseDetected(
    familyId: string,
    userId: string,
    cause: ReuseCause | 'consumed_token' = 'consumed_token'
  ): Promise<never> {
    await this.revokeFamily({ familyId }, SessionRevokedReasons.REUSE_DETECTED)
    this.logger.warn(
      { familyId, userId, cause },
      'a refresh token that was already used came back: login revoked'
    )
    throw new PlatformException(
      ErrorCodes.AUTH_REFRESH_TOKEN_REUSED,
      'refresh token already used',
      HttpStatusCodes.UNAUTHORIZED
    )
  }

  private async revokeFamily(
    where: { familyId: string; userId?: string },
    reason: SessionRevokedReason
  ): Promise<number> {
    const result = await this.prisma.client.session.updateMany({
      where: { ...where, revokedAt: null },
      data: { revokedAt: new Date(), revokedReason: reason }
    })
    return result.count
  }

  private async createSession(
    user: SessionUser,
    familyId: string,
    familyExpiresAt: Date,
    context: SessionContext,
    db: Database
  ): Promise<{ issued: IssuedSession; sessionId: string }> {
    const refreshToken = generateToken()
    // A refresh token lasts its own time, but never past the end of the login it belongs to
    const expiresAt = new Date(
      Math.min(
        Date.now() + this.settings.refreshTtlSeconds * MS_PER_SECOND,
        familyExpiresAt.getTime()
      )
    )
    const row = await db.session.create({
      data: {
        userId: user.id,
        familyId,
        refreshTokenHash: hashToken(refreshToken),
        userAgent: context.userAgent?.slice(0, MAX_USER_AGENT_LENGTH),
        ipAddress: context.ipAddress,
        expiresAt,
        familyExpiresAt
      }
    })
    const claims: AccessTokenClaims = { sub: user.id, sid: familyId, email: user.email }
    const issued: IssuedSession = {
      accessToken: await this.jwt.signAsync(claims),
      refreshToken,
      tokenType: 'Bearer',
      expiresIn: this.settings.accessTtlSeconds,
      refreshExpiresAt: expiresAt.toISOString()
    }
    return { issued, sessionId: row.id }
  }
}

function invalidToken(): PlatformException {
  return new PlatformException(
    ErrorCodes.AUTH_TOKEN_INVALID,
    'invalid refresh token',
    HttpStatusCodes.UNAUTHORIZED
  )
}
