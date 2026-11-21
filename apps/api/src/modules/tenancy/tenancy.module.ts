import { Module } from '@nestjs/common'
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core'

import { AuthenticatedUserRateLimitGuard } from '@platform/core/throttler'

import { AccessDenialAuditor } from './access-denial-auditor'
import { PermissionGuard } from './permission.guard'
import { TenantContextInterceptor } from './tenant-context.interceptor'
import { TenantContextService } from './tenant-context.service'
import { TenantGuard } from './tenant.guard'

// The two guards after the AuthGuard, global and in this order: who the store is and whether the
// user belongs to it, then whether the user may do this there. Import it after HttpPlatformModule
// (which registers the rate limit and the AuthGuard): the guards run in the order registered.
// It needs the database, Redis (cache), metrics and audit modules of the app.
@Module({
  providers: [
    TenantContextService,
    AccessDenialAuditor,
    TenantGuard,
    PermissionGuard,
    // First of the three, right after the AuthGuard: it needs only the user, and a request that the store or the permission
    // refuses (a token used with foreign store ids) must spend the budget too (the guard comes from the global ThrottlerPlatformModule)
    { provide: APP_GUARD, useExisting: AuthenticatedUserRateLimitGuard },
    { provide: APP_GUARD, useExisting: TenantGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard },
    // After the guards (an interceptor always runs after them): with RLS_CONTEXT on, the handler runs in one tenant transaction
    TenantContextInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: TenantContextInterceptor }
  ],
  exports: [TenantContextService]
})
export class TenancyModule {}
