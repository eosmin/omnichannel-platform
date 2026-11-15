import {
  applyDecorators,
  createParamDecorator,
  type ExecutionContext,
  SetMetadata,
  UseGuards
} from '@nestjs/common'

import { PluginApiIpThrottle } from '@platform/core/auth'
import { Public } from '@platform/core/auth-module'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { RateLimit } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { PluginScope } from '@platform/plugins/sdk'

import { PluginApiKeyGuard } from './plugin-api-key.guard'
import { PLUGIN_SCOPES_KEY } from './plugin-api.keys'

// The mark of a route of the plugin API: the key of an installation is the credential, and the scopes listed are all of them
// needed (not any). It makes the route public for the two global guards (a plugin has no user and no X-Store-Id: the key names
// the store) and puts PluginApiKeyGuard in their place, which also checks every @RequirePermissions of the route against what the
// scopes grant. A route with no scope at all (the one that says who the key is) lists none on purpose.
export const PluginApi = (...scopes: PluginScope[]): MethodDecorator & ClassDecorator =>
  applyDecorators(
    Public(),
    RateLimit(PluginApiIpThrottle),
    UseGuards(PluginApiKeyGuard),
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
