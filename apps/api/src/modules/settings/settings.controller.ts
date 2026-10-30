import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import { type BusinessHoursView, BusinessHoursService } from './business-hours.service'
import {
  type InboxBehaviorView,
  type InboxSettingsView,
  InboxSettingsService
} from './inbox-settings.service'
import {
  type CreateSnippetBody,
  createSnippetSchema,
  type CreateTagBody,
  createTagSchema,
  idSchema,
  type PutBusinessHoursBody,
  putBusinessHoursSchema,
  type UpdateInboxSettingsBody,
  updateInboxSettingsSchema,
  type UpdateSnippetBody,
  updateSnippetSchema,
  type UpdateTagBody,
  updateTagSchema
} from './settings.schemas'
import { type SnippetView, SnippetsService } from './snippets.service'
import { type TagView, TagsService } from './tags.service'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(idSchema)

// The settings of the store in X-Store-Id that the inbox is built on. Reading tags and snippets
// belongs to whoever works the inbox (they are what the composer and the filters offer); changing
// any setting needs SETTINGS_EDIT.
@Controller()
export class SettingsController {
  constructor(
    private readonly tags: TagsService,
    private readonly snippets: SnippetsService,
    private readonly businessHours: BusinessHoursService,
    private readonly inbox: InboxSettingsService
  ) {}

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.settings.tags)
  listTags(@CurrentStore() store: Store): Promise<TagView[]> {
    return this.tags.list(store.id)
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.settings.tagById(':id'))
  getTag(@CurrentStore() store: Store, @Param('id', id()) tagId: string): Promise<TagView> {
    return this.tags.get(store.id, tagId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Post(ApiRoutes.settings.tags)
  @HttpCode(HttpStatusCodes.CREATED)
  createTag(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createTagSchema)) body: CreateTagBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TagView> {
    return this.tags.create(store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Patch(ApiRoutes.settings.tagById(':id'))
  updateTag(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) tagId: string,
    @Body(new ZodValidationPipe(updateTagSchema)) body: UpdateTagBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TagView> {
    return this.tags.update(store.id, tagId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Delete(ApiRoutes.settings.tagById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeTag(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) tagId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.tags.remove(store.id, tagId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.settings.snippets)
  listSnippets(@CurrentStore() store: Store): Promise<SnippetView[]> {
    return this.snippets.list(store.id)
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.settings.snippetById(':id'))
  getSnippet(
    @CurrentStore() store: Store,
    @Param('id', id()) snippetId: string
  ): Promise<SnippetView> {
    return this.snippets.get(store.id, snippetId)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Post(ApiRoutes.settings.snippets)
  @HttpCode(HttpStatusCodes.CREATED)
  createSnippet(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createSnippetSchema)) body: CreateSnippetBody,
    @Req() req: AuthenticatedRequest
  ): Promise<SnippetView> {
    return this.snippets.create(store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Patch(ApiRoutes.settings.snippetById(':id'))
  updateSnippet(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) snippetId: string,
    @Body(new ZodValidationPipe(updateSnippetSchema)) body: UpdateSnippetBody,
    @Req() req: AuthenticatedRequest
  ): Promise<SnippetView> {
    return this.snippets.update(store.id, snippetId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Delete(ApiRoutes.settings.snippetById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeSnippet(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) snippetId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.snippets.remove(store.id, snippetId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.settings.businessHours)
  getBusinessHours(@CurrentStore() store: Store): Promise<BusinessHoursView> {
    return this.businessHours.get(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Put(ApiRoutes.settings.businessHours)
  putBusinessHours(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(putBusinessHoursSchema)) body: PutBusinessHoursBody,
    @Req() req: AuthenticatedRequest
  ): Promise<BusinessHoursView> {
    return this.businessHours.put(store.id, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(ApiRoutes.settings.inboxBehavior)
  getInboxBehavior(@CurrentStore() store: Store): Promise<InboxBehaviorView> {
    return this.inbox.behavior(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(ApiRoutes.settings.inbox)
  getInbox(@CurrentStore() store: Store): Promise<InboxSettingsView> {
    return this.inbox.get(store.id)
  }

  @RequirePermissions(Permissions.SETTINGS_EDIT)
  @Patch(ApiRoutes.settings.inbox)
  updateInbox(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(updateInboxSettingsSchema)) body: UpdateInboxSettingsBody,
    @Req() req: AuthenticatedRequest
  ): Promise<InboxSettingsView> {
    return this.inbox.update(store.id, body, actorOf(user, store, req))
  }
}
