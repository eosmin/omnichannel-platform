import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UseGuards,
  UseInterceptors
} from '@nestjs/common'

import { PluginApiIpThrottle } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { RateLimit } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { type Viewer, viewerOf } from '@platform/core/messaging'
import type { PluginScope } from '@platform/plugins/sdk'

import { pluginUserId } from '../tenancy/actor'

import { PluginApiKeyGuard } from './plugin-api-key.guard'
import { PLUGIN_SCOPES_KEY } from './plugin-api.keys'
import { PluginIdempotencyInterceptor } from './plugin-idempotency.interceptor'
import { permissionsOfScopes } from './plugin-install-rules'

// The mark of a route of the plugin API: the key of an installation is the credential, and the scopes listed are all of them
// needed (not any). It makes the route public for the two global guards (a plugin has no user and no X-Store-Id: the key names
// the store) and puts PluginApiKeyGuard in their place, which also checks every @RequirePermissions of the route against what the
// scopes grant. A write that carries `Idempotency-Key` is made once per installation and key (PluginIdempotencyInterceptor). A route with no scope at all (the one that says who the key is) lists none on purpose.
export const PluginApi = (...scopes: PluginScope[]): MethodDecorator & ClassDecorator =>
  applyDecorators(
    Public(),
    RateLimit(PluginApiIpThrottle),
    UseGuards(PluginApiKeyGuard),
    UseInterceptors(PluginIdempotencyInterceptor),
    SetMetadata(PLUGIN_SCOPES_KEY, scopes)
  )

// What a route that the guard let in knows of its caller: the installation, never a user
export const CurrentPluginInstallation = createParamDecorator(
  (_data: unknown, context: ExecutionContext) => {
    const { pluginInstallation } = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (pluginInstallation === undefined) {
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'the route reads the plugin installation but PluginApiKeyGuard did not run for it',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }
    return pluginInstallation
  }
)

// Whether the key HOLDS a scope the route does not name: the route stays open to whoever holds its own scopes, and what it answers
// of another kind of data (the identity of a customer on an order or on a message) is added only for a key that was also granted
// the scope that guards that data. It never lends a permission: the guard and `CurrentPluginViewer` still look at the scopes of the
// route alone. Reads the frozen copy of the granted scopes that PluginApiKeyGuard left on the request.
export const PluginHoldsScope = createParamDecorator(
  (scope: PluginScope, context: ExecutionContext): boolean => {
    const { pluginInstallation } = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (pluginInstallation === undefined) {
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'the route reads the scopes of the plugin but PluginApiKeyGuard did not run for it',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }
    return pluginInstallation.scopes.includes(scope)
  }
)

// The viewer the services of the inbox answer for (`plugin:<installation id>`), holding the permissions of the scopes THE ROUTE
// names and not of every scope the key holds: a route declared `conversations:read` must not show what `messages:read` guards
// (the preview of the last message) because the same key happens to have both. The guard already checked that the key holds them.
export const CurrentPluginViewer = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Viewer => {
    const { pluginInstallation } = context.switchToHttp().getRequest<AuthenticatedRequest>()
    if (pluginInstallation === undefined) {
      throw new PlatformException(
        ErrorCodes.INTERNAL_ERROR,
        'the route reads the plugin viewer but PluginApiKeyGuard did not run for it',
        HttpStatusCodes.INTERNAL_SERVER_ERROR
      )
    }
    // Where the guard finds them: on the handler, else on the class
    const scopes = (Reflect.getMetadata(PLUGIN_SCOPES_KEY, context.getHandler()) ??
      Reflect.getMetadata(PLUGIN_SCOPES_KEY, context.getClass()) ??
      []) as PluginScope[]
    return viewerOf(pluginUserId(pluginInstallation.id), permissionsOfScopes(scopes))
  }
)
