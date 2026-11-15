import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common'

import { PluginApiRoutes } from '@platform/core/api'
import { type Permission, Permissions } from '@platform/core/auth'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import {
  confirmUploadSchema,
  type ConfirmUploadBody,
  downloadAllBodySchema,
  type DownloadAllBody,
  type MediaUrls,
  requestUploadUrlSchema,
  type RequestUploadUrlBody,
  type UploadUrlResult
} from '@platform/core/storage'
import { PluginScopes } from '@platform/plugins/sdk'

import type { ExportView } from '../exports'
import { CurrentPluginInstallation, PluginApi } from '../plugins/plugin-api.decorators'
import { CurrentPermissions, CurrentStore, RequirePermissions } from '../tenancy'
import { pluginUserId } from '../tenancy/actor'

import { MediaDownloadService } from './media-download.service'
import { type MediaView, MediaService } from './media.service'

// The files of the store of the key (Step 5.6 PR E7), over the same services and the same checks as the screen: the type, the size and
// the signature of an upload, the scan, and the signed links of minutes (a plugin is never given an address that is not signed). The store
// is the one of the key, so a file of another store is a 404. What a plugin uploads belongs to `plugin:<installation id>`; each route
// takes the permissions of ITS scopes (`@CurrentPermissions`), so `media:write` alone uploads only message files, as a person with
// MEDIA_UPLOAD alone does. Not here, on purpose: attaching an upload to a message of a plugin, and the uploads of the other purposes (PR E7-2).
@Controller()
export class PluginMediaController {
  constructor(
    private readonly media: MediaService,
    private readonly downloads: MediaDownloadService
  ) {}

  @PluginApi(PluginScopes.MEDIA_WRITE)
  @RequirePermissions(Permissions.MEDIA_UPLOAD)
  @Post(PluginApiRoutes.media.uploadUrl)
  @HttpCode(HttpStatusCodes.OK)
  uploadUrl(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(requestUploadUrlSchema)) body: RequestUploadUrlBody
  ): Promise<UploadUrlResult> {
    return this.media.requestUploadUrl(store.id, pluginUserId(installation.id), held, body)
  }

  @PluginApi(PluginScopes.MEDIA_WRITE)
  @RequirePermissions(Permissions.MEDIA_UPLOAD)
  @Post(PluginApiRoutes.media.confirmUpload)
  @HttpCode(HttpStatusCodes.OK)
  confirmUpload(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(confirmUploadSchema)) body: ConfirmUploadBody
  ): Promise<MediaView> {
    return this.media.confirmUpload(store.id, pluginUserId(installation.id), held, body)
  }

  @PluginApi(PluginScopes.MEDIA_READ)
  @RequirePermissions(Permissions.MEDIA_VIEW)
  @Get(PluginApiRoutes.media.byId(':id'))
  urls(
    @CurrentStore() store: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', new ParseUUIDPipe()) id: string
  ): Promise<MediaUrls> {
    return this.media.urlsFor(store.id, id, held)
  }

  // The ZIP of the gallery of a customer, as the exports centre of the key follows it. The files are those of the conversations the key
  // could open (`conversations:read`), as a person's gallery shows what their role opens; the archived and the spam ones stay out.
  @PluginApi(
    PluginScopes.CUSTOMERS_READ,
    PluginScopes.MEDIA_READ,
    PluginScopes.CONVERSATIONS_READ,
    PluginScopes.EXPORTS_WRITE
  )
  @RequirePermissions(
    Permissions.CUSTOMERS_VIEW,
    Permissions.MEDIA_VIEW,
    Permissions.MEDIA_DOWNLOAD_ALL
  )
  @Post(PluginApiRoutes.media.downloadAll)
  @HttpCode(HttpStatusCodes.ACCEPTED)
  downloadAll(
    @CurrentStore() store: { id: string },
    @CurrentPluginInstallation() installation: { id: string },
    @CurrentPermissions() held: readonly Permission[],
    @Body(new ZodValidationPipe(downloadAllBodySchema)) body: DownloadAllBody
  ): Promise<ExportView> {
    return this.downloads.requestZip(store.id, pluginUserId(installation.id), held, body)
  }
}
