import { Module } from '@nestjs/common'

import { CustomerIdentityService } from '@platform/core/messaging'

import { ChannelRegistryModule } from '../channel-registry'
import { ConversationsModule } from '../conversations'
import { ExportsModule } from '../exports'
import { TenancyModule } from '../tenancy'

import { AddressesService } from './addresses.service'
import { CustomerMediaService } from './customer-media.service'
import { CustomerMergePreviewService } from './customer-merge-preview.service'
import { CustomerMergeService } from './customer-merge.service'
import { CustomerTagsService } from './customer-tags.service'
import { CustomerTimelineService } from './customer-timeline.service'
import { CustomersController } from './customers.controller'
import { CustomersService } from './customers.service'
import { IdentitiesService } from './identities.service'
import { NotesService } from './notes.service'

// Needs the database and audit modules of the app. CustomerIdentityService is exported for the
// inbound pipeline (Step 2.6), which resolves the customer behind a handle.
@Module({
  imports: [ChannelRegistryModule, ConversationsModule, ExportsModule, TenancyModule],
  controllers: [CustomersController],
  providers: [
    CustomersService,
    IdentitiesService,
    AddressesService,
    NotesService,
    CustomerTagsService,
    CustomerMergeService,
    CustomerMergePreviewService,
    CustomerTimelineService,
    CustomerMediaService,
    CustomerIdentityService
  ],
  exports: [CustomersService, CustomerIdentityService]
})
export class CustomersModule {}
