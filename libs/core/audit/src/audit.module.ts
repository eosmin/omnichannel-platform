import { Global, Module } from '@nestjs/common'
import { APP_INTERCEPTOR } from '@nestjs/core'

import { AuditInterceptor } from './audit.interceptor'
import { AuditService } from './audit.service'

// The audit trail for the whole process: the service for anything that writes an entry by hand, and
// the interceptor behind @Audit(). Needs the database and the logger modules of the app.
@Global()
@Module({
  providers: [
    AuditService,
    AuditInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: AuditInterceptor }
  ],
  exports: [AuditService]
})
export class AuditModule {}
