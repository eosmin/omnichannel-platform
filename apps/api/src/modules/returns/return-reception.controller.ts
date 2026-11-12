import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type ScanCodeBody,
  scanCodeSchema,
  type UpdateReceptionItemBody,
  updateReceptionItemSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { ReturnReceptionService } from './return-reception.service'
import type {
  ReceptionBatchSummaryView,
  ReceptionBatchView,
  ReceptionItemView,
  ScanResultView
} from './return-reception.views'
import {
  type ListReceptionBatchesQuery,
  listReceptionBatchesQuerySchema,
  receptionIdSchema
} from './returns.schemas'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(receptionIdSchema)

// The reception of the packages that come back, by scanner (TDD_17 §4.16). Reading a batch asks for returns:view; everything that
// changes one asks for returns:manage. Flagging a customer from a package asks for customers:flag_caution on top, checked by the
// service where the flag is decided and again where it is carried out.
@Controller()
export class ReturnReceptionController {
  constructor(private readonly reception: ReturnReceptionService) {}

  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(ApiRoutes.returns.reception.batches)
  list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listReceptionBatchesQuerySchema)) query: ListReceptionBatchesQuery
  ): Promise<ReceptionBatchSummaryView[]> {
    return this.reception.listBatches(store.id, query.status)
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.reception.batches)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<ReceptionBatchView> {
    return this.reception.createBatch(store.id, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.RETURNS_VIEW)
  @Get(ApiRoutes.returns.reception.batchById(':id'))
  get(
    @CurrentStore() store: Store,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) batchId: string
  ): Promise<ReceptionBatchView> {
    return this.reception.getBatch(store.id, batchId, held)
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.reception.scan(':id'))
  @HttpCode(HttpStatusCodes.OK)
  scan(
    @CurrentStore() store: Store,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) batchId: string,
    @Body(new ZodValidationPipe(scanCodeSchema)) body: ScanCodeBody
  ): Promise<ScanResultView> {
    return this.reception.scan(store.id, batchId, body, held)
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Patch(ApiRoutes.returns.reception.itemById(':id', ':itemId'))
  update(
    @CurrentStore() store: Store,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) batchId: string,
    @Param('itemId', id()) itemId: string,
    @Body(new ZodValidationPipe(updateReceptionItemSchema)) body: UpdateReceptionItemBody
  ): Promise<ReceptionItemView> {
    return this.reception.updateItem(store.id, batchId, itemId, body, held)
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Delete(ApiRoutes.returns.reception.itemById(':id', ':itemId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: Store,
    @Param('id', id()) batchId: string,
    @Param('itemId', id()) itemId: string
  ): Promise<void> {
    await this.reception.removeItem(store.id, batchId, itemId)
  }

  @RequirePermissions(Permissions.RETURNS_MANAGE)
  @Post(ApiRoutes.returns.reception.complete(':id'))
  @HttpCode(HttpStatusCodes.OK)
  complete(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) batchId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<ReceptionBatchView> {
    return this.reception.complete(store.id, batchId, actorOf(user, store, req), held)
  }
}
