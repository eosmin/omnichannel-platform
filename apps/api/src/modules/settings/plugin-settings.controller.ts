import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { PluginScopes } from '@platform/plugins/sdk'

import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentStore, pluginActorOf, RequirePermissions } from '../tenancy'

import { type PluginPreferencesView, pluginPreferencesView } from './plugin-settings.views'
import { PreferencesService } from './preferences.service'
import { type ReturnSettingsView, ReturnSettingsService } from './return-settings.service'
import {
  type CreateTagBody,
  createTagSchema,
  idSchema,
  type UpdateTagBody,
  updateTagSchema
} from './settings.schemas'
import { type SnippetView, SnippetsService } from './snippets.service'
import { type TagView, TagsService } from './tags.service'

const TAGS_READ = PluginScopes.TAGS_READ
const TAGS_WRITE = PluginScopes.TAGS_WRITE
const idParam = () => new ZodValidationPipe(idSchema)

// How the store is set up to work, read only (Step 5.6 PR E3a, scope `settings:read`): the preferences (an allowlist: not the approval controls) and the return rules. The
// security settings, the routing, the hours and the inbox behaviour stay human (the map says why), and no setting is written.
// The one thing it writes is the tag catalog (Step 5.6 PR E4a-2, scopes `tags:read` and `tags:write`): the tags of the store of the key,
// over the same `TagsService` as the screen, audited as the installation (the system with `pluginInstallationId`). A write holds the
// read scope as well, so a 404 never shows a tag the key may not read.
@Controller()
export class PluginSettingsController {
  constructor(
    private readonly preferences: PreferencesService,
    private readonly returns: ReturnSettingsService,
    private readonly tags: TagsService,
    private readonly snippets: SnippetsService
  ) {}

  @PluginApi(PluginScopes.SETTINGS_READ)
  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(PluginApiRoutes.settings.preferences)
  async getPreferences(@CurrentStore() store: { id: string }): Promise<PluginPreferencesView> {
    return pluginPreferencesView(await this.preferences.get(store.id))
  }

  @PluginApi(PluginScopes.SETTINGS_READ)
  @RequirePermissions(Permissions.SETTINGS_VIEW)
  @Get(PluginApiRoutes.settings.returns)
  getReturns(@CurrentStore() store: { id: string }): Promise<ReturnSettingsView> {
    return this.returns.get(store.id)
  }

  @PluginApi(TAGS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(PluginApiRoutes.settings.tags)
  listTags(@CurrentStore() store: { id: string }): Promise<TagView[]> {
    return this.tags.list(store.id)
  }

  @PluginApi(TAGS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(PluginApiRoutes.settings.tagById(':id'))
  getTag(
    @CurrentStore() store: { id: string },
    @Param('id', idParam()) id: string
  ): Promise<TagView> {
    return this.tags.get(store.id, id)
  }

  // The canned replies, read only (PR E7-2, scope `snippets:read`): the same service and the same fields as the composer. Writing one
  // is the owner's (SETTINGS_EDIT) and has no scope.
  @PluginApi(PluginScopes.SNIPPETS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(PluginApiRoutes.settings.snippets)
  listSnippets(@CurrentStore() store: { id: string }): Promise<SnippetView[]> {
    return this.snippets.list(store.id)
  }

  @PluginApi(PluginScopes.SNIPPETS_READ)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW)
  @Get(PluginApiRoutes.settings.snippetById(':id'))
  getSnippet(
    @CurrentStore() store: { id: string },
    @Param('id', idParam()) id: string
  ): Promise<SnippetView> {
    return this.snippets.get(store.id, id)
  }

  @PluginApi(TAGS_READ, TAGS_WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.SETTINGS_EDIT)
  @Post(PluginApiRoutes.settings.tags)
  @HttpCode(HttpStatusCodes.CREATED)
  createTag(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Body(new ZodValidationPipe(createTagSchema)) body: CreateTagBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TagView> {
    return this.tags.create(store.id, body, pluginActorOf(installation, store, req))
  }

  @PluginApi(TAGS_READ, TAGS_WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.SETTINGS_EDIT)
  @Patch(PluginApiRoutes.settings.tagById(':id'))
  updateTag(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Param('id', idParam()) id: string,
    @Body(new ZodValidationPipe(updateTagSchema)) body: UpdateTagBody,
    @Req() req: AuthenticatedRequest
  ): Promise<TagView> {
    return this.tags.update(store.id, id, body, pluginActorOf(installation, store, req))
  }

  @PluginApi(TAGS_READ, TAGS_WRITE)
  @RequirePermissions(Permissions.CONVERSATIONS_VIEW, Permissions.SETTINGS_EDIT)
  @Delete(PluginApiRoutes.settings.tagById(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeTag(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string; pluginId: string },
    @Param('id', idParam()) id: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.tags.remove(store.id, id, pluginActorOf(installation, store, req))
  }
}
