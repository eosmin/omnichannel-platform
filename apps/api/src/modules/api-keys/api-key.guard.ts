import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata
} from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Request } from 'express'
import { PinoLogger } from 'nestjs-pino'

import type { Permission } from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  API_KEY_TOKEN_PREFIX,
  ApiKeyLimits,
  ApiKeyStatus,
  isApiKeyScope
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

// The status column is text: compared with the value of the enum as text
const ACTIVE: string = ApiKeyStatus.ACTIVE

export const API_KEY_SCOPES_KEY = 'requiredApiKeyScopes'

// The scopes a route of the public API needs: every one listed (all of them, not any)
export const RequireApiKeyScopes = (
  ...scopes: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(API_KEY_SCOPES_KEY, scopes)

// What a route that this guard let in knows of its caller: the key, and the store the key belongs to
export interface ApiKeyContext {
  keyId: string
  storeId: string
  scopes: readonly string[]
}

type ApiKeyRequest = Request & { apiKey?: ApiKeyContext }

// The store of a call made with a key is the store of the key, never a header or a value of the request
export const CurrentApiKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): ApiKeyContext => {
    const { apiKey } = context.switchToHttp().getRequest<ApiKeyRequest>()
    if (apiKey === undefined) {
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'the route reads the api key but ApiKeyGuard did not run for it',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }
    return apiKey
  }
)

// The scheme is case-insensitive (RFC 7235)
const BEARER = /^Bearer (\S+)$/i

function invalidKey(): PlatformException {
  // One answer for a key that is missing, unknown, revoked or expired: the call says nothing about which keys exist
  return new PlatformException(
    ErrorCodes.API_KEY_INVALID,
    'the api key is not valid',
    HttpStatusCodes.UNAUTHORIZED
  )
}

// Authenticates a call to the public API with the key of a store (`Authorization: Bearer pk_live_...`). A route that uses it is
// @Public() (no user session and no X-Store-Id: the key is the credential and names the store) and says what it needs with
// @RequireApiKeyScopes. The key is found by its hash, must be active and unexpired, and a scope it does not hold is a 403.
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ApiKeyGuard.name)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ApiKeyRequest>()
    const token = BEARER.exec(request.headers.authorization ?? '')?.[1]
    if (token === undefined || !token.startsWith(API_KEY_TOKEN_PREFIX)) throw invalidKey()

    const key = await this.prisma.client.apiKey.findUnique({
      where: { keyHash: hashToken(token) },
      select: { id: true, storeId: true, scopes: true, status: true, expiresAt: true }
    })
    const now = new Date()
    if (key === null || key.status !== ACTIVE || (key.expiresAt !== null && key.expiresAt <= now)) {
      throw invalidKey()
    }

    // Only what a key may hold counts: a row written some other way cannot give it more
    const scopes = key.scopes.filter(isApiKeyScope)
    const required = this.reflector.getAllAndOverride<Permission[] | undefined>(
      API_KEY_SCOPES_KEY,
      [context.getHandler(), context.getClass()]
    )
    // A route that names no scope is a mistake of the code, and it must not be open to every key
    if (required === undefined) {
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'a route behind ApiKeyGuard names no scope',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }
    if (!required.every(scope => scopes.includes(scope))) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'the api key lacks a scope of the route',
        HttpStatusCodes.FORBIDDEN
      )
    }

    request.apiKey = { keyId: key.id, storeId: key.storeId, scopes }
    // Written at most once a minute per key, and never waited for: a busy key would otherwise turn every call into a write
    void this.prisma.client.apiKey
      .updateMany({
        where: {
          id: key.id,
          OR: [
            { lastUsedAt: null },
            {
              lastUsedAt: { lt: new Date(now.getTime() - ApiKeyLimits.LAST_USED_WRITE_INTERVAL_MS) }
            }
          ]
        },
        data: { lastUsedAt: now }
      })
      .catch((error: unknown) => {
        // Said, not hidden: a write that keeps failing leaves the page with a stale date and nothing else to explain it
        this.logger.warn(
          { keyId: key.id, err: String(error) },
          'the last use of an api key could not be written'
        )
      })
    return true
  }
}
