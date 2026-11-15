import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res
} from '@nestjs/common'
import type { Response } from 'express'

import { PluginApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import { CHANNEL_ANONYMITY, type ChannelAnonymitySource } from '@platform/core/domain'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  type ConversationPage,
  ConversationsService,
  type ListConversationsQuery,
  listConversationsQuerySchema,
  invalidInput,
  type Viewer
} from '@platform/core/messaging'
import { PluginScopes } from '@platform/plugins/sdk'

import {
  type WithAnonymous,
  withAnonymousCustomers,
  withAnonymousIdentities,
  type WithAnonymousIdentities,
  withAnonymousPage,
  type WithAnonymousPage
} from '../channel-registry'
import {
  CurrentPluginInstallation,
  CurrentPluginViewer,
  PluginApi
} from '../plugins/plugin-api.decorators'
import { CurrentStore, pluginActorOf, RequirePermissions } from '../tenancy'

import { AddressesService } from './addresses.service'
import { type CautionView, CustomerCautionService } from './customer-caution.service'
import { CustomerOrdersService, type CustomerOrdersPage } from './customer-orders.service'
import { CustomerTagsService } from './customer-tags.service'
import { CustomerTimelineService, type TimelinePage } from './customer-timeline.service'
import {
  type AttachTagBody,
  attachTagSchema,
  type CreateAddressBody,
  createAddressSchema,
  type CreateCustomerBody,
  createCustomerSchema,
  type SetCautionBody,
  setCautionSchema,
  idSchema,
  type LinkIdentityBody,
  linkIdentitySchema,
  type ListCustomersQuery,
  listCustomersQuerySchema,
  type ListCustomerOrdersQuery,
  listCustomerOrdersQuerySchema,
  type ListTimelineQuery,
  listTimelineQuerySchema,
  type UpdateAddressBody,
  updateAddressSchema,
  type UpdateCustomerBody,
  updateCustomerSchema
} from './customers.schemas'
import { CustomersService } from './customers.service'
import type {
  AddressView,
  CreatedCustomer,
  CustomerDetail,
  CustomerPage,
  IdentityView,
  TagView
} from './customers.views'
import { IdentitiesService } from './identities.service'
import { NotesService } from './notes.service'
import {
  type PluginNoteView,
  pluginNote,
  pluginTimeline,
  type PluginTimelineEntry
} from './plugin-customers.views'

const id = () => new ZodValidationPipe(idSchema)

type Installation = { id: string; pluginId: string }
type Store = { id: string }

const READ = PluginScopes.CUSTOMERS_READ
const WRITE = PluginScopes.CUSTOMERS_WRITE

// The customers of the store of the key (Step 5.6 PR E2), over the same services as the profile of the interface. Every route holds
// `customers:read`, even the ones that answer nothing: a key must not learn that a customer exists, or what keeps it from being
// deleted (the 404 and the 409 with its counts), through a scope it was not given. Contact data (names, e-mail addresses, phones)
// is what these routes carry. A write takes `customers:write` besides, and a permission each method asks for is the one the same
// route of the interface asks for, inside the scopes of THE ROUTE (the guard checks it): deleting a customer and flagging it
// have scopes of their own, because no other scope grants those permissions. The team members who wrote a note or merged are
// never answered (`plugin-customers.views.ts`).
//
// Not here, on purpose (the map says why): the notes (POST and DELETE: the author of a note is a person, and the profile shows
// them by name), the merge, its undo and its preview (`mergedById` is a person too), the gallery of the customer (scope
// `media:read`, PR E7) and the export (`exports:write`, PR E7).
@Controller()
export class PluginCustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly identities: IdentitiesService,
    private readonly addresses: AddressesService,
    private readonly notes: NotesService,
    private readonly caution: CustomerCautionService,
    private readonly tags: CustomerTagsService,
    private readonly timeline: CustomerTimelineService,
    private readonly customerOrders: CustomerOrdersService,
    private readonly conversations: ConversationsService,
    @Inject(CHANNEL_ANONYMITY) private readonly anonymity: ChannelAnonymitySource
  ) {}

  @PluginApi(READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(PluginApiRoutes.customers.list)
  list(
    @CurrentStore() store: Store,
    @Query(new ZodValidationPipe(listCustomersQuerySchema)) query: ListCustomersQuery
  ): Promise<CustomerPage> {
    return this.customers.list(store.id, query)
  }

  // The route holds `customers:read` too, so the answer may say which customers look like the new one (what a person sees)
  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_CREATE)
  @Post(PluginApiRoutes.customers.list)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: Store,
    @Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerBody
  ): Promise<WithAnonymousIdentities<CreatedCustomer>> {
    return this.customers
      .create(store.id, body, true)
      .then(created => withAnonymousIdentities(this.anonymity, created))
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(PluginApiRoutes.customers.byId(':id'))
  get(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string
  ): Promise<WithAnonymousIdentities<CustomerDetail>> {
    return this.customers
      .get(store.id, customerId)
      .then(customer => withAnonymousIdentities(this.anonymity, customer))
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Patch(PluginApiRoutes.customers.byId(':id'))
  update(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerBody
  ): Promise<WithAnonymousIdentities<CustomerDetail>> {
    return this.customers
      .update(store.id, customerId, body)
      .then(customer => withAnonymousIdentities(this.anonymity, customer))
  }

  // Only a customer with no conversations and no orders can go (the service refuses the rest with a 409)
  @PluginApi(READ, PluginScopes.CUSTOMERS_DELETE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_DELETE)
  @Delete(PluginApiRoutes.customers.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) customerId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.customers.remove(store.id, customerId, pluginActorOf(installation, store, req))
  }

  // The caution flag informs and never blocks (TDD_17 §4.16). The setter that is kept is `plugin:<installation id>`: nothing
  // shows it or joins it to `users` (see the plan, "Left by PR E2").
  @PluginApi(READ, PluginScopes.CUSTOMERS_FLAG_CAUTION)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_FLAG_CAUTION)
  @Put(PluginApiRoutes.customers.caution(':id'))
  setCaution(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(setCautionSchema)) body: SetCautionBody,
    @Req() req: AuthenticatedRequest
  ): Promise<CautionView> {
    return this.caution.set(store.id, customerId, body, pluginActorOf(installation, store, req))
  }

  @PluginApi(READ, PluginScopes.CUSTOMERS_FLAG_CAUTION)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_FLAG_CAUTION)
  @Delete(PluginApiRoutes.customers.caution(':id'))
  clearCaution(
    @CurrentStore() store: Store,
    @CurrentPluginInstallation() installation: Installation,
    @Param('id', id()) customerId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<CautionView> {
    return this.caution.clear(store.id, customerId, pluginActorOf(installation, store, req))
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Post(PluginApiRoutes.customers.identities(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  async linkIdentity(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(linkIdentitySchema)) body: LinkIdentityBody,
    @Res({ passthrough: true }) res: Response
  ): Promise<WithAnonymous<IdentityView>> {
    const { identity, created } = await this.identities.link(store.id, customerId, body)
    // 201 for a new identity, 200 for the one the customer already had
    if (!created) res.status(HttpStatusCodes.OK)
    return withAnonymousCustomers(this.anonymity, identity)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Delete(PluginApiRoutes.customers.identityById(':id', ':identityId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async unlinkIdentity(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Param('identityId', id()) identityId: string
  ): Promise<void> {
    await this.identities.unlink(store.id, customerId, identityId)
  }

  // The conversations and the orders of the customer follow what the route holds: with `customers:read` alone the timeline has the
  // notes and the merges and neither of them (a viewer without CONVERSATIONS_VIEW or ORDERS_VIEW gets the rest only)
  @PluginApi(READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(PluginApiRoutes.customers.timeline(':id'))
  listTimeline(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) customerId: string,
    @Query(new ZodValidationPipe(listTimelineQuerySchema)) query: ListTimelineQuery
  ): Promise<Omit<TimelinePage, 'data'> & { data: PluginTimelineEntry[] }> {
    return this.timeline.list(store.id, customerId, query, viewer).then(pluginTimeline)
  }

  @PluginApi(READ, PluginScopes.ORDERS_READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.ORDERS_VIEW)
  @Get(PluginApiRoutes.customers.orders(':id'))
  listOrders(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Query(new ZodValidationPipe(listCustomerOrdersQuerySchema)) query: ListCustomerOrdersQuery
  ): Promise<CustomerOrdersPage> {
    return this.customerOrders.list(store.id, customerId, query)
  }

  // The same page as GET /plugin-api/conversations, for one customer
  @PluginApi(READ, PluginScopes.CONVERSATIONS_READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CONVERSATIONS_VIEW)
  @Get(PluginApiRoutes.customers.conversations(':id'))
  async listConversations(
    @CurrentStore() store: Store,
    @CurrentPluginViewer() viewer: Viewer,
    @Param('id', id()) customerId: string,
    @Query(new ZodValidationPipe(listConversationsQuerySchema)) query: ListConversationsQuery
  ): Promise<WithAnonymousPage<ConversationPage>> {
    // The counts are the business of GET /plugin-api/conversations; this route answers pages only
    if (query.countsOnly) throw invalidInput('countsOnly is not a filter of this route')
    // 404 for a customer that is not in this store, not an empty page
    await this.timeline.requireCustomer(store.id, customerId)
    return withAnonymousPage(
      this.anonymity,
      await this.conversations.list(store.id, query, viewer, customerId)
    )
  }

  @PluginApi(READ)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(PluginApiRoutes.customers.notes(':id'))
  listNotes(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string
  ): Promise<PluginNoteView[]> {
    return this.notes.list(store.id, customerId).then(notes => notes.map(pluginNote))
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Post(PluginApiRoutes.customers.addresses(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  createAddress(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(createAddressSchema)) body: CreateAddressBody
  ): Promise<AddressView> {
    return this.addresses.create(store.id, customerId, body)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Patch(PluginApiRoutes.customers.addressById(':id', ':addressId'))
  updateAddress(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Param('addressId', id()) addressId: string,
    @Body(new ZodValidationPipe(updateAddressSchema)) body: UpdateAddressBody
  ): Promise<AddressView> {
    return this.addresses.update(store.id, customerId, addressId, body)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Delete(PluginApiRoutes.customers.addressById(':id', ':addressId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeAddress(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Param('addressId', id()) addressId: string
  ): Promise<void> {
    await this.addresses.remove(store.id, customerId, addressId)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Post(PluginApiRoutes.customers.tags(':id'))
  @HttpCode(HttpStatusCodes.OK)
  attachTag(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(attachTagSchema)) body: AttachTagBody
  ): Promise<TagView[]> {
    return this.tags.attach(store.id, customerId, body.tagId)
  }

  @PluginApi(READ, WRITE)
  @RequirePermissions(Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT)
  @Delete(PluginApiRoutes.customers.tagById(':id', ':tagId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async detachTag(
    @CurrentStore() store: Store,
    @Param('id', id()) customerId: string,
    @Param('tagId', id()) tagId: string
  ): Promise<void> {
    await this.tags.detach(store.id, customerId, tagId)
  }
}
