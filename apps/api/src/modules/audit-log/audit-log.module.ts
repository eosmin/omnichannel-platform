import { Module } from '@nestjs/common'

import { ExportsModule } from '../exports'
import { TenancyModule } from '../tenancy'

import { AuditLogController } from './audit-log.controller'
import { AuditLogService } from './audit-log.service'

// Needs the database and audit modules of the app
@Module({
  imports: [ExportsModule, TenancyModule],
  controllers: [AuditLogController],
  providers: [AuditLogService]
})
export class AuditLogModule {}
