import { createParamDecorator, type ExecutionContext, SetMetadata } from '@nestjs/common'
import type { Reflector } from '@nestjs/core'

import type { Permission } from '@platform/core/auth'
import { IS_PUBLIC_KEY } from '@platform/core/auth-module'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

export const SKIP_TENANT_KEY = 'skipTenant'
export const PERMISSIONS_KEY = 'requiredPermissions'
export const ANY_PERMISSION_KEY = 'requiredAnyPermission'
export const MEMBER_ONLY_KEY = 'memberOnly'
export const NO_TENANT_TRANSACTION_KEY = 'noTenantTransaction'
export const TENANT_ORGANIZATION_STORES_KEY = 'tenantOrganizationStores'

// For the routes that belong to a person and not to a store (the session, the account): they need a
// logged-in user but no X-Store-Id. Both tenancy guards are global and refuse everything else, so
// forgetting a decorator on a new route closes it, it never opens it.
export const SkipTenant = (): MethodDecorator & ClassDecorator => SetMetadata(SKIP_TENANT_KEY, true)

// Every permission listed is required (all of them, not any). On a controller and on a handler the
// lists add up.
export const RequirePermissions = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(PERMISSIONS_KEY, permissions)

// For a route that serves what several permissions each open a part of (the exports center: whoever may
// make one kind of export sees the list), and whose service then narrows the answer to those parts.
// One of the permissions listed is enough; it adds to @RequirePermissions, which still needs all of its own.
export const RequireAnyPermission = (
  ...permissions: [Permission, ...Permission[]]
): MethodDecorator & ClassDecorator => SetMetadata(ANY_PERMISSION_KEY, permissions)

// For the routes that serve a member what is theirs alone in a store (their notifications): TenantGuard
// has already proved an active membership of the store of the header, and the service filters by the
// user, so no role permission applies. It replaces @RequirePermissions only; naming both is a mistake
// that route-protection.spec refuses.
export const MemberOfStore = (): MethodDecorator & ClassDecorator =>
  SetMetadata(MEMBER_ONLY_KEY, true)

// For a route that must NOT run inside the one transaction of the request (Row-Level Security, Step 7.1): it calls something outside
// the database (a carrier, a channel, the bucket, the mail) or commits a row before it does, or it streams. The reason is
// required and written in the code; the route then opens its own short contexts with PrismaService.tenantTransaction and every
// query that is not inside one finds no rows once RLS is on. Without this the interceptor wraps the whole handler.
export const NoTenantTransaction = (reason: string): MethodDecorator & ClassDecorator => {
  if (reason.trim() === '') throw new Error('NoTenantTransaction needs a reason')
  return SetMetadata(NO_TENANT_TRANSACTION_KEY, reason)
}

// For a route of a resource that belongs to the ORGANIZATION and carries rows of several of its stores (a transfer and a count between
// stores, TDD_16 §1): the context of the request holds every store of the organization TenantGuard resolved, not only the store of the
// header. Without it the lines of the other stores are invisible to the database, "the caller sees every line" is decided on what is
// left, and a dispatch or an apply goes through for one store and skips the others. The organization comes from the guard, never from the
// request; who may see or move the lines of each store stays decided by the service (the permissions of the caller in EACH store),
// exactly as with the switch off. The reason is required and written in the code.
export const TenantOfOrganizationStores = (reason: string): MethodDecorator & ClassDecorator => {
  if (reason.trim() === '') throw new Error('TenantOfOrganizationStores needs a reason')
  return SetMetadata(TENANT_ORGANIZATION_STORES_KEY, reason)
}

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
    HttpStatusCodes.INTERNAL_SERVER_ERROR
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

// What the member may do in the store of the request: for the rules that compare the caller with
// someone else (nobody grants a permission they lack)
export const CurrentPermissions = createParamDecorator(
  (_data: unknown, context: ExecutionContext): readonly Permission[] => {
    const { permissions } = tenantRequest(context)
    if (permissions === undefined) throw missingTenant()
    return permissions
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
