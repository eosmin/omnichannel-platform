import { Module } from '@nestjs/common'
import { APP_GUARD } from '@nestjs/core'

import { AccessDenialAuditor } from './access-denial-auditor'
import { PermissionGuard } from './permission.guard'
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
    { provide: APP_GUARD, useExisting: TenantGuard },
    { provide: APP_GUARD, useExisting: PermissionGuard }
  ],
  exports: [TenantContextService]
})
export class TenancyModule {}
