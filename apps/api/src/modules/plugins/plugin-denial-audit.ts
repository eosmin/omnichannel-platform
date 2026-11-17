import type { Redis } from 'ioredis'
import type { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import type { AuditService } from '@platform/core/audit-module'
import { CacheKeys } from '@platform/core/cache'
import { PluginApiDenialAudit, type PluginApiDenialReason } from '@platform/core/domain'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { routePathOf } from '../tenancy/decorators'

export interface PluginDenialDeps {
  audit: AuditService
  redis: Redis
  logger: PinoLogger
}

export interface PluginDenial {
  reason: PluginApiDenialReason
  // Missing for a key no installation owns: the row then has no store and no installation
  installation?: { id: string; pluginId: string; storeId: string }
  // The scopes or permissions the call lacked: names the platform declares, never a value the caller sent
  missing?: readonly string[]
}

// The call that the guard of the plugin API refused, in the audit log (PLG-198): the platform is the actor (a plugin has no person),
// the installation and the reason are on the entry and the key never is. A plugin that probes the routes outside its scopes would
// write a row per request, so each installation and reason gets ONE entry per window, and the keys nobody owns share a small budget
// for the window. Never throws: the refusal that follows must not turn into a 500.
export async function auditPluginDenial(
  deps: PluginDenialDeps,
  request: AuthenticatedRequest,
  denial: PluginDenial
): Promise<void> {
  try {
    if (!(await withinBudget(deps, denial))) return
    const userAgent = request.get('user-agent')
    const { installation } = denial
    deps.audit.log({
      action: AuditAction.PLUGIN_API_DENIED,
      actor: { system: true },
      ...(installation === undefined
        ? {}
        : {
            storeId: installation.storeId,
            resourceType: 'plugin_installation',
            resourceId: installation.id
          }),
      metadata: {
        reason: denial.reason,
        method: request.method,
        path: routePathOf(request),
        ...(installation === undefined
          ? {}
          : { pluginId: installation.pluginId, installationId: installation.id }),
        ...(denial.missing === undefined ? {} : { missing: [...denial.missing] })
      },
      ...(request.ip === undefined ? {} : { ipAddress: request.ip }),
      ...(userAgent === undefined ? {} : { userAgent })
    })
  } catch (error) {
    deps.logger.warn({ err: String(error) }, 'a refusal of the plugin API could not be audited')
  }
}

async function withinBudget(deps: PluginDenialDeps, denial: PluginDenial): Promise<boolean> {
  const { installation, reason } = denial
  if (installation !== undefined) {
    // SET NX EX is one step: the first refusal of the window takes it and the rest find it taken. If Redis fails the entry is
    // skipped and not written: a budget that opens when its store fails is no budget, and the Pino log still has the refusal.
    const taken = await deps.redis.set(
      CacheKeys.audit.pluginDenial(installation.id, reason),
      '1',
      'EX',
      PluginApiDenialAudit.WINDOW_SECONDS,
      'NX'
    )
    return taken === 'OK'
  }
  const key = CacheKeys.audit.pluginDenialAnonymous
  const results = await deps.redis
    .multi()
    .incr(key)
    .expire(key, PluginApiDenialAudit.WINDOW_SECONDS, 'NX')
    .exec()
  const counted = results?.[0]
  if (counted === undefined || counted[0] !== null || typeof counted[1] !== 'number') return false
  return counted[1] <= PluginApiDenialAudit.ANONYMOUS_PER_WINDOW
}
