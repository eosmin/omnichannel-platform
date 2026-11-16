import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req
} from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import {
  type FiscalDocumentPage,
  FiscalDocumentsService,
  type FiscalDocumentView,
  FiscalIssuerService,
  type FiscalIssuerView
} from '@platform/fiscal/runtime'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { FiscalSubmissionQueue } from './fiscal-submission.queue'
import {
  idSchema,
  type ListDocumentsQuery,
  listDocumentsQuerySchema,
  type PutIssuerBody,
  putIssuerSchema,
  type ReceiverPatchBody,
  receiverPatchSchema,
  type VoidDocumentBody,
  voidDocumentSchema
} from './fiscal.schemas'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The fiscal documents of the organization (TDD_18 §8, §12): the issuer and the documents of its sales. Organization-scoped like the
// books, read from the store of X-Store-Id. A document never changes after the authority accepts it.
@Controller()
export class FiscalController {
  constructor(
    private readonly issuer: FiscalIssuerService,
    private readonly documents: FiscalDocumentsService,
    private readonly queue: FiscalSubmissionQueue
  ) {}

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @Get(ApiRoutes.fiscal.providers)
  providers(): { data: ReturnType<FiscalIssuerService['listProviders']> } {
    return { data: this.issuer.listProviders() }
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @Get(ApiRoutes.fiscal.issuer)
  async getIssuer(
    @CurrentOrganization() organization: Organization
  ): Promise<{ data: FiscalIssuerView | null }> {
    return { data: await this.issuer.get(organization.id) }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @Put(ApiRoutes.fiscal.issuer)
  async putIssuer(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(putIssuerSchema)) body: PutIssuerBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: FiscalIssuerView }> {
    return { data: await this.issuer.upsert(organization.id, body, actorOf(user, store, req)) }
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @Get(ApiRoutes.fiscal.documents.list)
  list(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQuery
  ): Promise<FiscalDocumentPage> {
    return this.documents.list(organization.id, query)
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @Get(ApiRoutes.fiscal.documents.byId(':id'))
  async byId(
    @CurrentOrganization() organization: Organization,
    @Param('id', id()) documentId: string
  ): Promise<{ data: FiscalDocumentView }> {
    return { data: await this.documents.get(organization.id, documentId) }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @Patch(ApiRoutes.fiscal.documents.receiver(':id'))
  async receiver(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) documentId: string,
    @Body(new ZodValidationPipe(receiverPatchSchema)) body: ReceiverPatchBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: FiscalDocumentView }> {
    return {
      data: await this.documents.updateReceiver(
        organization.id,
        documentId,
        body,
        actorOf(user, store, req)
      )
    }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @Post(ApiRoutes.fiscal.documents.retry(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async retry(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) documentId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: { queued: true } }> {
    const retried = await this.documents.retry(
      organization.id,
      documentId,
      actorOf(user, store, req)
    )
    await this.queue.enqueue(organization.id, documentId, retried.submission)
    return { data: { queued: true } }
  }

  // HIGH tier of DestructiveActionTiers (VOID_FISCAL_DOCUMENT): the interface asks before it sends this
  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @Post(ApiRoutes.fiscal.documents.void(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async voidDocument(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) documentId: string,
    @Body(new ZodValidationPipe(voidDocumentSchema)) body: VoidDocumentBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: FiscalDocumentView }> {
    return {
      data: await this.documents.void(
        organization.id,
        documentId,
        body.reason,
        actorOf(user, store, req)
      )
    }
  }
}
