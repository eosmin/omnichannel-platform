import { Body, Controller, Get, HttpCode, Param, Post, Put, Query, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import {
  type CursorPage,
  type GuidePolicyBody,
  guidePolicySchema,
  type RecordGuideAdjustmentBody,
  recordGuideAdjustmentSchema,
  type RecordGuidePurchaseBody,
  recordGuidePurchaseSchema,
  type VoidGuidePurchaseBody,
  voidGuidePurchaseSchema
} from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { actorOf, CurrentStore, RequirePermissions, type ResolvedTenant } from '../tenancy'

import {
  carrierIdSchema,
  type ListGuideMovementsQuery,
  listGuideMovementsQuerySchema,
  movementIdSchema
} from './carrier-guides.schemas'
import { CarrierGuidesApiService } from './carrier-guides.service'
import type {
  BenefitPeriodView,
  BenefitView,
  GuideBalanceView,
  GuideMovementView,
  GuidePolicyView
} from './carrier-guides.views'

type Store = ResolvedTenant['store']

const id = () => new ZodValidationPipe(carrierIdSchema)
const movementId = () => new ZodValidationPipe(movementIdSchema)

// The balance of prepaid guides and the refund benefit of a carrier connection (TDD_17 §4.18, §6). Reading them asks for
// carriers:view_guide_balance; recording a purchase, an adjustment or the void of a purchase, and replacing the policy, ask for
// carriers:manage_guide_balance (they show what the owner paid for guides). The store is the one TenantGuard resolved, never a
// value of the request.
@Controller()
export class CarrierGuidesController {
  constructor(private readonly guides: CarrierGuidesApiService) {}

  @NoStore()
  @RequirePermissions(Permissions.CARRIERS_VIEW_GUIDE_BALANCE)
  @Get(ApiRoutes.carriers.guideBalance(':id'))
  balance(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<GuideBalanceView> {
    return this.guides.balance(store.id, connectionId)
  }

  @NoStore()
  @RequirePermissions(Permissions.CARRIERS_VIEW_GUIDE_BALANCE)
  @Get(ApiRoutes.carriers.guideMovements(':id'))
  movements(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Query(new ZodValidationPipe(listGuideMovementsQuerySchema)) query: ListGuideMovementsQuery
  ): Promise<CursorPage<GuideMovementView>> {
    return this.guides.movements(store.id, connectionId, query)
  }

  @RequirePermissions(Permissions.CARRIERS_MANAGE_GUIDE_BALANCE)
  @Post(ApiRoutes.carriers.guidePurchases(':id'))
  recordPurchase(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Body(new ZodValidationPipe(recordGuidePurchaseSchema)) body: RecordGuidePurchaseBody,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<GuideMovementView> {
    return this.guides.recordPurchase(store.id, connectionId, body, actorOf(user, store, req))
  }

  @HttpCode(HttpStatusCodes.OK)
  @RequirePermissions(Permissions.CARRIERS_MANAGE_GUIDE_BALANCE)
  @Post(ApiRoutes.carriers.guidePurchaseVoid(':id', ':movementId'))
  voidPurchase(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Param('movementId', movementId()) purchaseId: string,
    @Body(new ZodValidationPipe(voidGuidePurchaseSchema)) body: VoidGuidePurchaseBody,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<GuideMovementView> {
    return this.guides.voidPurchase(
      store.id,
      connectionId,
      purchaseId,
      body,
      actorOf(user, store, req)
    )
  }

  @RequirePermissions(Permissions.CARRIERS_MANAGE_GUIDE_BALANCE)
  @Post(ApiRoutes.carriers.guideAdjustments(':id'))
  adjust(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Body(new ZodValidationPipe(recordGuideAdjustmentSchema)) body: RecordGuideAdjustmentBody,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<GuideMovementView> {
    return this.guides.adjust(store.id, connectionId, body, actorOf(user, store, req))
  }

  @NoStore()
  @RequirePermissions(Permissions.CARRIERS_VIEW_GUIDE_BALANCE)
  @Get(ApiRoutes.carriers.guidePolicy(':id'))
  policy(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<GuidePolicyView> {
    return this.guides.policy(store.id, connectionId)
  }

  @HttpCode(HttpStatusCodes.OK)
  @RequirePermissions(Permissions.CARRIERS_MANAGE_GUIDE_BALANCE)
  @Put(ApiRoutes.carriers.guidePolicy(':id'))
  setPolicy(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string,
    @Body(new ZodValidationPipe(guidePolicySchema)) body: GuidePolicyBody,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: AuthenticatedRequest
  ): Promise<GuidePolicyView> {
    return this.guides.setPolicy(store.id, connectionId, body, actorOf(user, store, req))
  }

  @NoStore()
  @RequirePermissions(Permissions.CARRIERS_VIEW_GUIDE_BALANCE)
  @Get(ApiRoutes.carriers.benefit(':id'))
  benefit(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<BenefitView> {
    return this.guides.benefit(store.id, connectionId)
  }

  @NoStore()
  @RequirePermissions(Permissions.CARRIERS_VIEW_GUIDE_BALANCE)
  @Get(ApiRoutes.carriers.benefitPeriods(':id'))
  benefitPeriods(
    @CurrentStore() store: Store,
    @Param('id', id()) connectionId: string
  ): Promise<BenefitPeriodView[]> {
    return this.guides.benefitPeriods(store.id, connectionId)
  }
}
