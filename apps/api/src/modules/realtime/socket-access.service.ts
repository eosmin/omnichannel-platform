import { Inject, Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import type { Redis } from 'ioredis'
import { z } from 'zod'

import { Permissions } from '@platform/core/auth'
import { toAuthenticatedUser } from '@platform/core/auth-module'
import { CacheKeys } from '@platform/core/cache'
import { PrismaService } from '@platform/core/database'
import { ErrorCodes, type ErrorCode } from '@platform/core/errors'
import { SocketLimits } from '@platform/core/realtime'
import { REDIS_CLIENT } from '@platform/core/redis'

import { canSeeConversation, isHiddenStatus, viewerOf } from '../conversations'
import { TenantContextService } from '../tenancy'

import type { SocketData } from './realtime.types'

// What the client sends to connect: the access token and the store it works in. Never the user or
// the permissions: those are read here.
const handshakeSchema = z.object({
  token: z.string().min(1).max(4096),
  storeId: z.uuid()
})

const expirySchema = z.object({ exp: z.number() })

// A connection or a socket the platform does not accept (any more). It carries the code the client
// reads, and nothing else about why.
export class SocketRefused extends Error {
  constructor(
    readonly code: ErrorCode,
    // Who was refused and for what, for the log. The code is all the client is told.
    readonly context: { userId?: string; requestedStoreId?: string } = {}
  ) {
    super(code)
  }
}

// Who a socket is and what it may see. The same checks as a request (the access token, an active
// membership in the store, the visibility of a conversation), made again as time passes because a
// socket lives for hours and a request for milliseconds.
@Injectable()
export class SocketAccessService {
  constructor(
    private readonly jwt: JwtService,
    private readonly tenants: TenantContextService,
    private readonly prisma: PrismaService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis
  ) {}

  async authenticate(handshake: unknown, address: string): Promise<SocketData> {
    // First of all: the cost of what follows (a signature, a lookup) is for who is within the budget
    await this.spend(
      CacheKeys.realtime.addressHandshakes(address),
      SocketLimits.MAX_HANDSHAKES_PER_ADDRESS_PER_MINUTE,
      {}
    )
    const parsed = handshakeSchema.safeParse(handshake)
    if (!parsed.success) throw new SocketRefused(ErrorCodes.AUTH_TOKEN_INVALID)

    const claims = await this.verify(parsed.data.token)
    const user = toAuthenticatedUser(claims)
    const expiry = expirySchema.safeParse(claims)
    if (user === false || !expiry.success) throw new SocketRefused(ErrorCodes.AUTH_TOKEN_INVALID)

    await this.spend(
      CacheKeys.realtime.handshakes(user.id),
      SocketLimits.MAX_HANDSHAKES_PER_MINUTE,
      { userId: user.id }
    )

    const storeId = parsed.data.storeId.toLowerCase()
    const tenant = await this.tenants.resolve(user.id, storeId)
    if (tenant === null) {
      throw new SocketRefused(ErrorCodes.TENANT_ACCESS_DENIED, {
        userId: user.id,
        requestedStoreId: storeId
      })
    }

    // The users are not tenant data: no tenant context is needed to read one
    const row = await this.prisma.client.user.findUnique({
      where: { id: user.id },
      select: { name: true }
    })
    if (row === null) throw new SocketRefused(ErrorCodes.AUTH_TOKEN_INVALID)

    return {
      userId: user.id,
      userName: row.name,
      storeId,
      organizationId: tenant.store.organizationId,
      held: tenant.permissions,
      tokenExpiresAt: expiry.data.exp * 1000
    }
  }

  // Run by every heartbeat and every join: the socket may not outlive its token or its membership.
  // A client that is refused reconnects with a fresh token, which is how a session that is still
  // good goes on.
  async refresh(data: SocketData): Promise<SocketData> {
    if (Date.now() >= data.tokenExpiresAt) throw new SocketRefused(ErrorCodes.AUTH_TOKEN_EXPIRED)
    const tenant = await this.tenants.resolve(data.userId, data.storeId)
    if (tenant === null) throw new SocketRefused(ErrorCodes.TENANT_ACCESS_DENIED)
    return { ...data, organizationId: tenant.store.organizationId, held: tenant.permissions }
  }

  // The rule of the REST route that opens a conversation: it exists in this store and the user sees
  // it. A conversation of another store, one that is not there and one the user may not see are the
  // same answer. `data` is what refresh just returned.
  async mayJoin(data: SocketData, conversationId: string): Promise<boolean> {
    return (await this.visibleAmong(data, [conversationId])).has(conversationId)
  }

  // Which of the conversations the user may see, in one query
  async visibleAmong(data: SocketData, conversationIds: readonly string[]): Promise<Set<string>> {
    if (conversationIds.length === 0) return new Set()
    // Before any database access. The room carries who is typing in a thread, which is what reading it
    // shows: the REST thread asks for the right to read messages as well.
    if (!data.held.includes(Permissions.MESSAGES_VIEW)) return new Set()
    const rows = await this.prisma.tenantTransaction(
      { storeIds: [data.storeId], organizationIds: [data.organizationId] },
      () =>
        this.prisma.client.conversation.findMany({
          where: { id: { in: [...conversationIds] }, storeId: data.storeId },
          select: { id: true, status: true, assignedTo: true }
        })
    )
    const viewer = viewerOf(data.userId, data.held)
    return new Set(
      rows
        .filter(row =>
          canSeeConversation(viewer, {
            hidden: isHiddenStatus(row.status),
            assignedTo: row.assignedTo
          })
        )
        .map(row => row.id)
    )
  }

  // Every try counts, a refused one too: each costs a read. A Redis that fails does not turn people
  // away.
  private async spend(key: string, limit: number, context: { userId?: string }): Promise<void> {
    const results = await this.redis
      .multi()
      .incr(key)
      // Only the first try of a window sets the clock: attempts that go on must not push it forward
      .expire(key, SocketLimits.HANDSHAKE_WINDOW_SECONDS, 'NX')
      .exec()
      .catch(() => null)
    const tries = Number(results?.[0]?.[1] ?? 0)
    if (tries > limit) throw new SocketRefused(ErrorCodes.RATE_LIMIT_EXCEEDED, context)
  }

  private async verify(token: string): Promise<unknown> {
    try {
      return await this.jwt.verifyAsync<object>(token)
    } catch (error) {
      // The library names an expired token by the class of the error
      const expired = error instanceof Error && error.name === 'TokenExpiredError'
      throw new SocketRefused(
        expired ? ErrorCodes.AUTH_TOKEN_EXPIRED : ErrorCodes.AUTH_TOKEN_INVALID
      )
    }
  }
}
