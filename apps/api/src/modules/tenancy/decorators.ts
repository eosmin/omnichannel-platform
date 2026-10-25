import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import type { Permission } from '@platform/core/auth'
import { IS_PUBLIC_KEY } from '@platform/core/auth-module'
import { ErrorCodes, PlatformException } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

export const SKIP_TENANT_KEY = 'skipTenant'
export const PERMISSIONS_KEY = 'requiredPermissions'

// For the routes that belong to a person and not to a store (the session, the account): they need a
// logged-in user but no X-Store-Id. Both tenancy guards are global and refuse everything else, so
// forgetting a decorator on a new route closes it, it never opens it.
export const SkipTenant = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_TENANT_KEY, true)

// Every permission listed is required (all of them, not any). On a controller and on a handler the
// lists add up.
export const RequirePermissions = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions)

function tenantRequest(context: ExecutionContext): AuthenticatedRequest {
  return context.switchToHttp().getRequest<AuthenticatedRequest>()
}

// The three below read what TenantGuard put on the request. A route that reads them and is not
// behind the guard is a mistake of the code (@SkipTenant or @Public on a route that needs the store),
// and it must not run with an empty context.
function missingTenant(): PlatformException {
  return new PlatformException(
    ErrorCodes.INTERNAL_ERROR,
    'the route reads the tenant but TenantGuard did not run for it',
    500
  )
}

export const CurrentStore = createParamDecorator(
  (_data: unknown, context: ExecutionContext): NonNullable<AuthenticatedRequest['store']> => {
    const { store } = tenantRequest(context)
    if (store === undefined) throw missingTenant()
    return store
  }
)

export const CurrentOrganization = createParamDecorator(
  (
    _data: unknown,
    context: ExecutionContext
  ): NonNullable<AuthenticatedRequest['organization']> => {
    const { organization } = tenantRequest(context)
    if (organization === undefined) throw missingTenant()
    return organization
  }
)

export const CurrentMembership = createParamDecorator(
  (_data: unknown, context: ExecutionContext): NonNullable<AuthenticatedRequest['membership']> => {
    const { membership } = tenantRequest(context)
    if (membership === undefined) throw missingTenant()
    return membership
  }
)

// A public route has no user, and a SkipTenant route has no store: neither guard has anything to do
export function isTenantExempt(reflector: Reflector, context: ExecutionContext): boolean {
  const targets = [context.getHandler(), context.getClass()]
  return (
    reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, targets) === true ||
    reflector.getAllAndOverride<boolean | undefined>(SKIP_TENANT_KEY, targets) === true
  )
}

// The pattern of the route that matched ("/probe/:id"), never the URL with its real ids
export function routePathOf(request: AuthenticatedRequest): string | undefined {
  const route = request.route as { path?: unknown } | undefined // Express types it as any
  return typeof route?.path === 'string' ? route.path : undefined
}
