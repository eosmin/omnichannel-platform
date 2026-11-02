import { Body, Controller, Get, HttpCode, Post, Put, Query } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import type { AuthenticatedUser } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import type { CursorPage } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'

import { CurrentStore, MemberOfStore } from '../tenancy'

import { NotificationPreferencesService } from './notification-preferences.service'
import {
  type ListNotificationsQuery,
  listNotificationsQuerySchema,
  type MarkReadBody,
  markReadBodySchema,
  type PushSubscriptionBody,
  pushSubscriptionBodySchema,
  type PutPreferencesBody,
  putPreferencesBodySchema,
  type RemovePushSubscriptionBody,
  removePushSubscriptionBodySchema
} from './notifications.schemas'
import { NotificationsService } from './notifications.service'
import type { NotificationView, PreferencesView } from './notifications.views'
import { PushSubscriptionsService } from './push-subscriptions.service'

// A member's own notifications in the store of the header. Nothing here reads another person's rows,
// so no role permission applies (MemberOfStore): TenantGuard has proved the membership.
@MemberOfStore()
@Controller()
export class NotificationsController {
  constructor(
    private readonly notifications: NotificationsService,
    private readonly preferences: NotificationPreferencesService,
    private readonly pushSubscriptions: PushSubscriptionsService
  ) {}

  @NoStore()
  @Get(ApiRoutes.notifications.list)
  list(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listNotificationsQuerySchema)) query: ListNotificationsQuery
  ): Promise<CursorPage<NotificationView>> {
    return this.notifications.list(user.id, store.id, query)
  }

  @NoStore()
  @Get(ApiRoutes.notifications.unreadCount)
  async unreadCount(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser
  ): Promise<{ count: number }> {
    return { count: await this.notifications.unreadCount(user.id, store.id) }
  }

  @HttpCode(HttpStatusCodes.OK)
  @Post(ApiRoutes.notifications.markRead)
  async markRead(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(markReadBodySchema)) body: MarkReadBody
  ): Promise<{ updated: number }> {
    return { updated: await this.notifications.markRead(user.id, store.id, body.ids) }
  }

  @HttpCode(HttpStatusCodes.OK)
  @Post(ApiRoutes.notifications.markAllRead)
  async markAllRead(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser
  ): Promise<{ updated: number }> {
    return { updated: await this.notifications.markAllRead(user.id, store.id) }
  }

  @NoStore()
  @Get(ApiRoutes.notifications.preferences)
  getPreferences(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser
  ): Promise<PreferencesView> {
    return this.preferences.get(user.id, store.id)
  }

  @Put(ApiRoutes.notifications.preferences)
  putPreferences(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(putPreferencesBodySchema)) body: PutPreferencesBody
  ): Promise<PreferencesView> {
    return this.preferences.put(user.id, store.id, body)
  }

  @HttpCode(HttpStatusCodes.NO_CONTENT)
  @Post(ApiRoutes.notifications.pushSubscription)
  async registerPushSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(pushSubscriptionBodySchema)) body: PushSubscriptionBody
  ): Promise<void> {
    await this.pushSubscriptions.register(user.id, body)
  }

  @HttpCode(HttpStatusCodes.NO_CONTENT)
  @Post(ApiRoutes.notifications.pushSubscriptionRemove)
  async removePushSubscription(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(removePushSubscriptionBodySchema)) body: RemovePushSubscriptionBody
  ): Promise<void> {
    await this.pushSubscriptions.remove(user.id, body.endpoint)
  }
}
