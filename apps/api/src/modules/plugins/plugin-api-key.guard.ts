import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler'
import { PinoLogger } from 'nestjs-pino'

import { type Permission, RETRY_AFTER_METADATA_KEY } from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginApiRateLimit,
  PluginInstallationStatus,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { PluginScope } from '@platform/plugins/sdk'

import { ANY_PERMISSION_KEY, missingPermissions, PERMISSIONS_KEY } from '../tenancy'

import { PLUGIN_SCOPES_KEY } from './plugin-api.keys'
import { bearerTokenOf, knownScopes, permissionsOfScopes } from './plugin-install-rules'

function invalidKey(): PlatformException {
  // One answer for a key that is missing, malformed, unknown, revoked, disabled, of a suspended plugin or not set up yet: the
  // call says nothing about which keys exist
  return new PlatformException(
    ErrorCodes.PLUGIN_API_KEY_INVALID,
    'the plugin key is not valid',
    HttpStatusCodes.UNAUTHORIZED
  )
}

// Authenticates a call of a plugin to `/api/v1/plugin-api/*` (TDD_10 §6.4): `Authorization: Bearer plg_live_...`. A plugin has no
// user and no store header: the key is the installation, and the installation belongs to exactly one store, so the store of the
// call is the one in the row and nothing the caller sends can change it. It takes the place of the global AuthGuard, TenantGuard
// and PermissionGuard on a route marked with @PluginApi (which makes the route public to them), so it does what they do:
//   - the key is found by its hash, and the installation must be ACTIVE and its plugin APPROVED (revoking or suspending
//     stops the key at the next call, with no cache to wait for);
//   - the installation's own rate limit, counted in Redis and shared by every replica, answers 429 past it; Redis down refuses
//     the call, because a limit that is open when its store fails is no limit;
//   - every scope the route names must have been granted (403 PLUGIN_SCOPE_DENIED);
//   - what the route asks of a person with @RequirePermissions must be inside the permissions the scopes OF THE ROUTE stand for
//     (PluginScopePermissions), so a plugin can do no more than a human could, whatever the controller says;
//   - the request gets `store`, `organization` and `permissions` as TenantGuard sets them, so the services behave as for a
//     person, and `pluginInstallation`; it never gets `user` or `membership`.
// A route that names no scopes list at all is a mistake of the code and is refused, never opened to every key.
@Injectable()
export class PluginApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
    @Inject(getStorageToken()) private readonly throttle: ThrottlerStorage,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PluginApiKeyGuard.name)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const token = bearerTokenOf(request.headers.authorization)
    if (token === undefined || !token.startsWith(PLUGIN_API_KEY_TOKEN_PREFIX)) throw invalidKey()

    const installation = await this.prisma.client.pluginInstallation.findUnique({
      where: { apiKeyHash: hashToken(token) },
      select: {
        id: true,
        pluginId: true,
        scopes: true,
        status: true,
        rateLimitPerMinute: true,
        plugin: { select: { status: true } },
        store: { select: { id: true, organizationId: true, name: true } }
      }
    })
    if (
      installation === null ||
      installation.status !== String(PluginInstallationStatus.ACTIVE) ||
      installation.plugin.status !== String(PluginStatus.APPROVED)
    ) {
      throw invalidKey()
    }

    const targets = [context.getHandler(), context.getClass()]
    const required = this.reflector.getAllAndOverride<PluginScope[] | undefined>(
      PLUGIN_SCOPES_KEY,
      targets
    )
    if (required === undefined) {
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'a route behind PluginApiKeyGuard names no scopes',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }

    await this.limit(installation.id, installation.rateLimitPerMinute)

    // Only scopes the platform declares count: a row written some other way cannot give a plugin more
    const granted = knownScopes(installation.scopes)
    const lacking = required.filter(scope => !granted.includes(scope))
    if (lacking.length > 0) {
      this.denied(installation, 'scope', lacking)
      throw new PlatformException(
        ErrorCodes.PLUGIN_SCOPE_DENIED,
        'the plugin lacks a scope of the route',
        HttpStatusCodes.FORBIDDEN,
        { required: lacking }
      )
    }

    // What the route may ask of a person is checked against the scopes THE ROUTE names (the key holds them: checked above), never
    // the union of everything the key was granted: a scope that stands for a permission does not lend it to another scope's route
    const permissions = permissionsOfScopes(required)
    const needed = this.reflector.getAllAndMerge<Permission[]>(PERMISSIONS_KEY, targets)
    const anyOf =
      this.reflector.getAllAndOverride<Permission[] | undefined>(ANY_PERMISSION_KEY, targets) ?? []
    // As PermissionGuard does: a route that asks for scopes and names no permission is a mistake of the code, closed and not open
    if (required.length > 0 && needed.length === 0 && anyOf.length === 0) {
      this.logger.error(
        { installationId: installation.id, handler: context.getHandler().name },
        'a plugin-api route with scopes declares no @RequirePermissions: refused'
      )
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'this route declares no permission',
        HttpStatusCodes.FORBIDDEN
      )
    }
    const missing = [
      ...missingPermissions(permissions, needed),
      ...(anyOf.length > 0 && !anyOf.some(permission => permissions.includes(permission))
        ? anyOf
        : [])
    ]
    if (missing.length > 0) {
      this.denied(installation, 'permission', missing)
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'the scopes of the plugin do not cover what the route needs',
        HttpStatusCodes.FORBIDDEN,
        { required: missing }
      )
    }

    // Copies that cannot be changed, as TenantGuard leaves them
    request.store = Object.freeze({ ...installation.store })
    request.organization = Object.freeze({ id: installation.store.organizationId })
    request.permissions = Object.freeze([...permissions])
    request.pluginInstallation = Object.freeze({
      id: installation.id,
      pluginId: installation.pluginId,
      scopes: Object.freeze(granted)
    })
    return true
  }

  // Said in the log, with the installation and never the key: a key that probes the routes outside its scopes is seen
  private denied(
    installation: { id: string; pluginId: string },
    kind: string,
    missing: string[]
  ): void {
    this.logger.warn(
      { installationId: installation.id, pluginId: installation.pluginId, kind, missing },
      'a plugin key was refused for lack of access'
    )
  }

  private async limit(installationId: string, perMinute: number): Promise<void> {
    let record: Awaited<ReturnType<ThrottlerStorage['increment']>>
    try {
      record = await this.throttle.increment(
        installationId,
        PluginApiRateLimit.WINDOW_MS,
        perMinute,
        0,
        PluginApiRateLimit.THROTTLER_NAME
      )
    } catch (error) {
      this.logger.error(
        { err: String(error) },
        'the rate limit of the plugin API could not be read'
      )
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'the plugin API is not available right now',
        HttpStatusCodes.SERVICE_UNAVAILABLE
      )
    }
    if (record.isBlocked) {
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'the plugin is over its request limit',
        HttpStatusCodes.TOO_MANY_REQUESTS,
        { [RETRY_AFTER_METADATA_KEY]: record.timeToBlockExpire }
      )
    }
  }
}
