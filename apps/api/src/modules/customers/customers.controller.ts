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
  Req,
  Res
} from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
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

import { AddressesService } from './addresses.service'
import { CustomerMergeService } from './customer-merge.service'
import { CustomerTagsService } from './customer-tags.service'
import {
  type AttachTagBody,
  attachTagSchema,
  type CreateAddressBody,
  createAddressSchema,
  type CreateCustomerBody,
  createCustomerSchema,
  type CreateNoteBody,
  createNoteSchema,
  idSchema,
  type LinkIdentityBody,
  linkIdentitySchema,
  type ListCustomersQuery,
  listCustomersQuerySchema,
  type MergeCustomersBody,
  mergeCustomersSchema,
  type UnmergeCustomersBody,
  unmergeCustomersSchema,
  type UpdateAddressBody,
  updateAddressSchema,
  type UpdateCustomerBody,
  updateCustomerSchema
} from './customers.schemas'
import { CustomersService } from './customers.service'
import type {
  AddressView,
  CustomerDetail,
  CustomerPage,
  IdentityView,
  TagView
} from './customers.views'
import { IdentitiesService } from './identities.service'
import { type NoteView, NotesService } from './notes.service'

const id = () => new ZodValidationPipe(idSchema)

// The customers of the store in X-Store-Id
@Controller()
export class CustomersController {
  constructor(
    private readonly customers: CustomersService,
    private readonly identities: IdentitiesService,
    private readonly addresses: AddressesService,
    private readonly notes: NotesService,
    private readonly tags: CustomerTagsService,
    private readonly merges: CustomerMergeService
  ) {}

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(ApiRoutes.customers.list)
  list(
    @CurrentStore() store: { id: string },
    @Query(new ZodValidationPipe(listCustomersQuerySchema)) query: ListCustomersQuery
  ): Promise<CustomerPage> {
    return this.customers.list(store.id, query)
  }

  @RequirePermissions(Permissions.CUSTOMERS_CREATE)
  @Post(ApiRoutes.customers.list)
  @HttpCode(HttpStatusCodes.CREATED)
  create(
    @CurrentStore() store: { id: string },
    @Body(new ZodValidationPipe(createCustomerSchema)) body: CreateCustomerBody
  ): Promise<CustomerDetail> {
    return this.customers.create(store.id, body)
  }

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(ApiRoutes.customers.byId(':id'))
  get(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string
  ): Promise<CustomerDetail> {
    return this.customers.get(store.id, customerId)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Patch(ApiRoutes.customers.byId(':id'))
  update(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(updateCustomerSchema)) body: UpdateCustomerBody
  ): Promise<CustomerDetail> {
    return this.customers.update(store.id, customerId, body)
  }

  @RequirePermissions(Permissions.CUSTOMERS_DELETE)
  @Delete(ApiRoutes.customers.byId(':id'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async remove(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) customerId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.customers.remove(store.id, customerId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Post(ApiRoutes.customers.identities(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  async linkIdentity(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(linkIdentitySchema)) body: LinkIdentityBody,
    @Res({ passthrough: true }) res: Response
  ): Promise<IdentityView> {
    const { identity, created } = await this.identities.link(store.id, customerId, body)
    // 201 for a new identity, 200 for the one the customer already had
    if (!created) res.status(HttpStatusCodes.OK)
    return identity
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Delete(ApiRoutes.customers.identityById(':id', ':identityId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async unlinkIdentity(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Param('identityId', id()) identityId: string
  ): Promise<void> {
    await this.identities.unlink(store.id, customerId, identityId)
  }

  @RequirePermissions(Permissions.CUSTOMERS_MERGE)
  @Post(ApiRoutes.customers.merge(':id'))
  @HttpCode(HttpStatusCodes.OK)
  merge(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) survivorId: string,
    @Body(new ZodValidationPipe(mergeCustomersSchema)) body: MergeCustomersBody,
    @Req() req: AuthenticatedRequest
  ): Promise<CustomerDetail> {
    return this.merges.merge(store.id, survivorId, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CUSTOMERS_MERGE)
  @Post(ApiRoutes.customers.unmerge(':id'))
  @HttpCode(HttpStatusCodes.OK)
  unmerge(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) survivorId: string,
    @Body(new ZodValidationPipe(unmergeCustomersSchema)) body: UnmergeCustomersBody,
    @Req() req: AuthenticatedRequest
  ): Promise<CustomerDetail> {
    return this.merges.unmerge(store.id, survivorId, body.mergeId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.CUSTOMERS_VIEW)
  @Get(ApiRoutes.customers.notes(':id'))
  listNotes(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string
  ): Promise<NoteView[]> {
    return this.notes.list(store.id, customerId)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Post(ApiRoutes.customers.notes(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  createNote(
    @CurrentStore() store: { id: string },
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(createNoteSchema)) body: CreateNoteBody
  ): Promise<NoteView> {
    return this.notes.create(store.id, customerId, user.id, body)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Delete(ApiRoutes.customers.noteById(':id', ':noteId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeNote(
    @CurrentStore() store: ResolvedTenant['store'],
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() held: readonly Permission[],
    @Param('id', id()) customerId: string,
    @Param('noteId', id()) noteId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.notes.remove(store.id, customerId, noteId, actorOf(user, store, req), held)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Post(ApiRoutes.customers.addresses(':id'))
  @HttpCode(HttpStatusCodes.CREATED)
  createAddress(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(createAddressSchema)) body: CreateAddressBody
  ): Promise<AddressView> {
    return this.addresses.create(store.id, customerId, body)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Patch(ApiRoutes.customers.addressById(':id', ':addressId'))
  updateAddress(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Param('addressId', id()) addressId: string,
    @Body(new ZodValidationPipe(updateAddressSchema)) body: UpdateAddressBody
  ): Promise<AddressView> {
    return this.addresses.update(store.id, customerId, addressId, body)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Delete(ApiRoutes.customers.addressById(':id', ':addressId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async removeAddress(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Param('addressId', id()) addressId: string
  ): Promise<void> {
    await this.addresses.remove(store.id, customerId, addressId)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Post(ApiRoutes.customers.tags(':id'))
  @HttpCode(HttpStatusCodes.OK)
  attachTag(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Body(new ZodValidationPipe(attachTagSchema)) body: AttachTagBody
  ): Promise<TagView[]> {
    return this.tags.attach(store.id, customerId, body.tagId)
  }

  @RequirePermissions(Permissions.CUSTOMERS_EDIT)
  @Delete(ApiRoutes.customers.tagById(':id', ':tagId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async detachTag(
    @CurrentStore() store: { id: string },
    @Param('id', id()) customerId: string,
    @Param('tagId', id()) tagId: string
  ): Promise<void> {
    await this.tags.detach(store.id, customerId, tagId)
  }
}
