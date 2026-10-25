import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { OrganizationsController } from './organizations.controller'
import { OrganizationsService } from './organizations.service'

// Needs the database and audit modules of the app. TenancyModule exports the context cache that a
// change of a store or a member has to drop.
@Module({
  imports: [TenancyModule],
  controllers: [OrganizationsController],
  providers: [OrganizationsService]
})
export class OrganizationsModule {}
