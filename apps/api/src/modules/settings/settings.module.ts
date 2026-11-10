import { Module } from '@nestjs/common'

import { TenancyModule } from '../tenancy'

import { BusinessHoursService } from './business-hours.service'
import { InboxSettingsService } from './inbox-settings.service'
import { InventorySettingsService } from './inventory-settings.service'
import { PreferencesService } from './preferences.service'
import { SettingsController } from './settings.controller'
import { SnippetsService } from './snippets.service'
import { TagsService } from './tags.service'

// Needs the database and audit modules of the app
@Module({
  imports: [TenancyModule],
  controllers: [SettingsController],
  providers: [
    TagsService,
    SnippetsService,
    BusinessHoursService,
    InboxSettingsService,
    InventorySettingsService,
    PreferencesService
  ]
})
export class SettingsModule {}
