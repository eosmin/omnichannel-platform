import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { getStorageToken, type ThrottlerStorage } from '@nestjs/throttler'
import type { Redis } from 'ioredis'
import { PinoLogger } from 'nestjs-pino'

import { AuditService } from '@platform/core/audit-module'
import {
  type Permission,
  PluginApiKeyRefusalFloorMs,
  RETRY_AFTER_METADATA_KEY
} from '@platform/core/auth'
import { hashToken } from '@platform/core/crypto'
import {
  contextOf,
  PrismaService,
  resolvePluginInstallation,
  resolvePluginInstallationPluginStatus
} from '@platform/core/database'
import {
  PLUGIN_API_KEY_TOKEN_PREFIX,
  PluginApiDenialReasons,
  type PluginApiDenialReason,
  PluginApiRateLimit,
  PluginInstallationStatus,
  PluginStatus
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { PluginKeyProbeLimiter } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { REDIS_CLIENT } from '@platform/core/redis'
import type { PluginScope } from '@platform/plugins/sdk'

import { ANY_PERMISSION_KEY, missingPermissions, PERMISSIONS_KEY } from '../tenancy'

import { PLUGIN_SCOPES_KEY } from './plugin-api.keys'
import { auditPluginDenial } from './plugin-denial-audit'
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
    private readonly logger: PinoLogger,
    private readonly audit: AuditService,
    @Inject(REDIS_CLIENT) private readonly redis: Redis,
    private readonly probes: PluginKeyProbeLimiter
  ) {
    this.logger.setContext(PluginApiKeyGuard.name)
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const startedAt = Date.now()
    // First of all, before the key is looked up in the database: an address that has sent too many keys that did not open the door
    // waits, and the lookup (and the large body of the events route, see pluginEventsBodyParser) is never paid for it
    const wait = await this.probes.retryAfter(request.ip ?? '')
    if (wait > 0) {
      this.probes.countRefusal()
      throw new PlatformException(
        ErrorCodes.RATE_LIMIT_EXCEEDED,
        'too many requests',
        HttpStatusCodes.TOO_MANY_REQUESTS,
        { [RETRY_AFTER_METADATA_KEY]: wait }
      )
    }
    const token = bearerTokenOf(request.headers.authorization)
    if (token === undefined || !token.startsWith(PLUGIN_API_KEY_TOKEN_PREFIX)) {
      return this.refuseKey(startedAt, request, PluginApiDenialReasons.INVALID_KEY)
    }

    // The key tells the database, and nobody else, which store it opens: the lookup answers the installation and its store, and the
    // row is read inside the context of that store (never a store the caller names)
    const keyHash = hashToken(token)
    const found = await resolvePluginInstallation(this.prisma.client, keyHash)
    const installation =
      found === null
        ? null
        : await this.prisma.tenantTransaction(contextOf(found), () =>
            this.prisma.client.pluginInstallation.findFirst({
              where: { id: found.id, storeId: found.storeId },
              select: {
                id: true,
                pluginId: true,
                scopes: true,
                status: true,
                rateLimitPerMinute: true,
                store: { select: { id: true, organizationId: true, name: true } }
              }
            })
          )
    if (installation === null)
      return this.refuseKey(startedAt, request, PluginApiDenialReasons.INVALID_KEY)
    // The status of the plugin is not read with a nested select inside the context of the store: the policy of `plugins` hides the
    // plugin of another organization there and the row would come back null. The lookup of the key answers it; no answer is a
    // refusal, the same one as for an unknown key, never an error
    const pluginStatus = await resolvePluginInstallationPluginStatus(this.prisma.client, keyHash)
    if (
      installation.status !== String(PluginInstallationStatus.ACTIVE) ||
      pluginStatus !== String(PluginStatus.APPROVED)
    ) {
      // The caller gets the same answer as for an unknown key; the audit log knows which installation it was
      return this.refuseKey(startedAt, request, PluginApiDenialReasons.INACTIVE, installation, {
        status: { installation: installation.status, plugin: pluginStatus }
      })
    }

    const targets = [context.getHandler(), context.getClass()]
    const required = this.reflector.getAllAndOverride<PluginScope[] | undefined>(
      PLUGIN_SCOPES_KEY,
      targets
    )
    if (required === undefined) {
      this.denied(request, installation, PluginApiDenialReasons.ROUTE_UNDECLARED, [])
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
      this.denied(request, installation, PluginApiDenialReasons.SCOPE, lacking)
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
    // As PermissionGuard does: a route whose scopes stand for permissions and that names none is a mistake of the code, closed and
    // not open. A route whose scopes stand for no human permission (the channel scopes of §6.7: they exist only for the routes of
    // the plugin's own accounts and events, and a person has no counterpart) has none to name.
    if (permissions.length > 0 && needed.length === 0 && anyOf.length === 0) {
      this.logger.error(
        { installationId: installation.id, handler: context.getHandler().name },
        'a plugin-api route with scopes declares no @RequirePermissions: refused'
      )
      this.denied(request, installation, PluginApiDenialReasons.ROUTE_UNDECLARED, [])
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
      this.denied(request, installation, PluginApiDenialReasons.PERMISSION, missing)
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
    request: AuthenticatedRequest,
    installation: { id: string; pluginId: string; store: { id: string } },
    reason: PluginApiDenialReason,
    missing: readonly string[]
  ): void {
    this.logger.warn(
      { installationId: installation.id, pluginId: installation.pluginId, kind: reason, missing },
      'a plugin key was refused for lack of access'
    )
    void this.record(request, reason, installation, { missing })
  }

  // A key that does not open the door: audited (with a cap) and answered with the one answer for every such key
  // The answer is the same for every kind of key and takes the same time at least: the call waits for the floor, counted from the
  // start of the guard, so a key that was never looked up and one that went through three queries cannot be told apart by the clock.
  // The failure is counted against the address (PluginApiKeyProbeThrottle) before the answer.
  private async refuseKey(
    startedAt: number,
    request: AuthenticatedRequest,
    reason: PluginApiDenialReason,
    installation?: { id: string; pluginId: string; store: { id: string } },
    detail: { status?: { installation: string; plugin: string | null } } = {}
  ): Promise<never> {
    await this.probes.recordFailure(request.ip ?? '')
    const remaining = PluginApiKeyRefusalFloorMs - (Date.now() - startedAt)
    if (remaining > 0) await new Promise(resolve => setTimeout(resolve, remaining))
    // The audit is capped, so the log keeps every one of these (never the key)
    this.logger.warn(
      { installationId: installation?.id, reason },
      'a plugin key that does not open the door was refused'
    )
    // Not awaited: it never throws, and an answer for a key that does not open the door must not wait for Redis
    void this.record(request, reason, installation, detail)
    throw invalidKey()
  }

  private record(
    request: AuthenticatedRequest,
    reason: PluginApiDenialReason,
    installation?: { id: string; pluginId: string; store: { id: string } },
    detail: {
      missing?: readonly string[]
      status?: { installation: string; plugin: string | null }
    } = {}
  ): Promise<void> {
    return auditPluginDenial(
      { audit: this.audit, redis: this.redis, logger: this.logger },
      request,
      {
        reason,
        ...(installation === undefined
          ? {}
          : {
              installation: {
                id: installation.id,
                pluginId: installation.pluginId,
                storeId: installation.store.id
              }
            }),
        ...(detail.missing === undefined ? {} : { missing: detail.missing }),
        ...(detail.status === undefined ? {} : { status: detail.status })
      }
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
