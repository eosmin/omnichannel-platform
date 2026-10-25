import { randomUUID } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PinoLogger } from 'nestjs-pino'

import {
  type AccessTokenClaims,
  type SessionRevokedReason,
  SessionRevokedReasons
} from '@platform/core/auth'
import { AUTH_SETTINGS, type AuthSettings } from '@platform/core/auth-module'
import { generateToken, hashToken } from '@platform/core/crypto'
import { PrismaService, type PrismaTransaction } from '@platform/core/database'
import { ErrorCodes, PlatformException } from '@platform/core/errors'

const MS_PER_SECOND = 1000
const UNAUTHORIZED = 401
const NOT_FOUND = 404
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

// Access tokens are stateless JWTs; the refresh token is an opaque secret whose hash is the
// Session row. Using it rotates it: the row is marked consumed and the next one joins the same
// family. Presenting a consumed token means it leaked, so the whole family is revoked
// (TDD_01 section 7). The code that issues the pair is here so that any way of logging in, the
// magic link today and the invitation accept of Step 1.4, goes through the same door.
@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    @Inject(AUTH_SETTINGS) private readonly settings: AuthSettings,
    private readonly logger: PinoLogger
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
    if (session.consumedAt !== null) return this.reuseDetected(session.familyId, session.userId)
    // The row expires with the cap too (createSession), but the cap is checked on its own: it is the
    // end of the login, and a shortened cap in the data must hold even for rows that outlive it
    if (
      session.expiresAt.getTime() <= Date.now() ||
      session.familyExpiresAt.getTime() <= Date.now()
    ) {
      throw new PlatformException(
        ErrorCodes.AUTH_TOKEN_EXPIRED,
        'refresh token expired',
        UNAUTHORIZED
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
    return rotated ?? this.reuseDetected(session.familyId, session.userId)
  }

  // Ends a login. Idempotent: a family that is already over stays over. The user is part of the
  // question, as in revokeOwn, so that no caller can end the login of someone else by mistake.
  async logout(userId: string, familyId: string): Promise<void> {
    await this.revokeFamily({ familyId, userId }, SessionRevokedReasons.LOGOUT)
  }

  async listActive(userId: string, currentFamilyId: string): Promise<ActiveSession[]> {
    const rows = await this.prisma.client.session.findMany({
      where: { userId, revokedAt: null, consumedAt: null, expiresAt: { gt: new Date() } },
      orderBy: { createdAt: 'desc' }
    })
    return rows.map(row => ({
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
      throw new PlatformException(ErrorCodes.RESOURCE_NOT_FOUND, 'session not found', NOT_FOUND)
    }
  }

  private async reuseDetected(familyId: string, userId: string): Promise<never> {
    await this.revokeFamily({ familyId }, SessionRevokedReasons.REUSE_DETECTED)
    this.logger.warn(
      { familyId, userId },
      'a refresh token that was already used came back: login revoked'
    )
    throw new PlatformException(
      ErrorCodes.AUTH_REFRESH_TOKEN_REUSED,
      'refresh token already used',
      UNAUTHORIZED
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
  return new PlatformException(ErrorCodes.AUTH_TOKEN_INVALID, 'invalid refresh token', UNAUTHORIZED)
}
