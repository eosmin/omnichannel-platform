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
import { PinoLogger } from 'nestjs-pino'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import type { FiscalEvidenceKind } from '@platform/core/domain'
import { errorName, HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import type { MediaUrls } from '@platform/core/storage'
import {
  type FiscalDocumentDetailView,
  type FiscalDocumentPage,
  FiscalDocumentsService,
  type FiscalDocumentView,
  FiscalIssuerService,
  type FiscalIssuerView,
  type FiscalSeriesView,
  type FiscalFindingsPage,
  FiscalSweepService
} from '@platform/fiscal/runtime'

import {
  actorOf,
  CurrentOrganization,
  CurrentPermissions,
  CurrentStore,
  NoTenantTransaction,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import { FiscalEvidenceUrlsService } from './fiscal-evidence-urls.service'
import { FiscalReachService } from './fiscal-reach.service'
import { FiscalSubmissionQueue } from './fiscal-submission.queue'
import {
  type ConfirmIssuerChangeBody,
  confirmIssuerChangeSchema,
  evidenceKindSchema,
  idSchema,
  type ListDocumentsQuery,
  listDocumentsQuerySchema,
  type PutIssuerBody,
  putIssuerSchema,
  type ReconciliationQuery,
  reconciliationQuerySchema,
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
    private readonly sweep: FiscalSweepService,
    private readonly queue: FiscalSubmissionQueue,
    private readonly evidenceUrls: FiscalEvidenceUrlsService,
    private readonly reach: FiscalReachService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalController.name)
  }

  // A document by id is the caller's only when it belongs to a store where they hold the permission of the route (HC-128): another store's
  // is a 404, as a document that does not exist
  private async mayRead(organizationId: string, userId: string, ids: readonly string[]) {
    await this.reach.assertDocuments(
      organizationId,
      ids,
      await this.reach.stores(organizationId, userId, Permissions.FISCAL_VIEW)
    )
  }

  private async mayManage(organizationId: string, userId: string, ids: readonly string[]) {
    await this.reach.assertDocuments(
      organizationId,
      ids,
      await this.reach.stores(organizationId, userId, Permissions.FISCAL_MANAGE)
    )
  }

  // The check of the reach for the routes that write: the service runs it inside the unit that writes (the routes are not one transaction)
  private manageGuard(organizationId: string, userId: string, ids: readonly string[]) {
    return () => this.mayManage(organizationId, userId, ids)
  }

  // The document is committed before it is queued (the route is not one transaction): a queue that blinked does not fail the request, which
  // a repeat would refuse. The document stays QUEUED and the fiscal sweep queues it again; a person can also retry it from its route.
  private async enqueueAfterCommit(
    organizationId: string,
    documentId: string,
    submission: number
  ): Promise<void> {
    try {
      await this.queue.enqueue(organizationId, documentId, submission)
    } catch (error) {
      this.logger.error(
        { err: errorName(error), documentId },
        'a fiscal document was committed and could not be queued'
      )
    }
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @NoStore()
  @Get(ApiRoutes.fiscal.providers)
  providers(): { data: ReturnType<FiscalIssuerService['listProviders']> } {
    return { data: this.issuer.listProviders() }
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @NoStore()
  @Get(ApiRoutes.fiscal.issuer)
  async getIssuer(
    @CurrentOrganization() organization: Organization
  ): Promise<{ data: FiscalIssuerView | null }> {
    return { data: await this.issuer.get(organization.id) }
  }

  // The series of correlatives of the organization of the store of the request
  @RequirePermissions(Permissions.FISCAL_VIEW)
  @NoStore()
  @Get(ApiRoutes.fiscal.series)
  async series(
    @CurrentOrganization() organization: Organization
  ): Promise<{ data: FiscalSeriesView[] }> {
    return { data: await this.issuer.listSeries(organization.id) }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @NoStore()
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

  // The dry run of the daily check of the documents: what the night would ask the queue for, and the documents that disagree with their
  // entry. It reads only, by the organization of the store, and shows ids and statuses, never the receiver's data.
  @RequirePermissions(Permissions.FISCAL_VIEW)
  @NoStore()
  @Get(ApiRoutes.fiscal.reconciliation)
  async reconciliation(
    @CurrentOrganization() organization: Organization,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(reconciliationQuerySchema)) query: ReconciliationQuery
  ): Promise<FiscalFindingsPage> {
    return this.sweep.find(organization.id, query.kind, {
      cursor: query.cursor,
      limit: query.limit,
      storeIds: await this.reach.stores(organization.id, user.id, Permissions.FISCAL_VIEW)
    })
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @NoStore()
  @Get(ApiRoutes.fiscal.documents.list)
  async list(
    @CurrentOrganization() organization: Organization,
    @CurrentUser() user: AuthenticatedUser,
    @Query(new ZodValidationPipe(listDocumentsQuerySchema)) query: ListDocumentsQuery
  ): Promise<FiscalDocumentPage> {
    const stores = await this.reach.stores(organization.id, user.id, Permissions.FISCAL_VIEW)
    return this.documents.list(organization.id, query, stores)
  }

  @RequirePermissions(Permissions.FISCAL_VIEW)
  @NoStore()
  @Get(ApiRoutes.fiscal.documents.byId(':id'))
  async byId(
    @CurrentOrganization() organization: Organization,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) documentId: string
  ): Promise<{ data: FiscalDocumentDetailView }> {
    await this.mayRead(organization.id, user.id, [documentId])
    return { data: await this.documents.getDetail(organization.id, documentId) }
  }

  // The signed link of one file of evidence (the document as it was built, the answer to its acceptance or to its void). The files hold the
  // receiver's data: a short-lived link, clean files only, audited.
  @RequirePermissions(Permissions.FISCAL_VIEW)
  @NoStore()
  @NoTenantTransaction(
    'makes the evidence file and then answers 409 while its scan is pending: one transaction for the request would roll the file back and it would never exist; the service keeps it in units of its own and reads in others'
  )
  @Get(ApiRoutes.fiscal.documents.evidence(':id', ':kind'))
  async evidence(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @CurrentPermissions() granted: readonly Permission[],
    @Param('id', id()) documentId: string,
    @Param('kind', new ZodValidationPipe(evidenceKindSchema)) kind: FiscalEvidenceKind,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: MediaUrls }> {
    // The reach of the person (HC-128) is checked by `urls`, in a context of its own and before any file is made
    return {
      data: await this.evidenceUrls.urls(
        organization.id,
        documentId,
        kind,
        actorOf(user, store, req),
        granted
      )
    }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @NoStore()
  @NoTenantTransaction(
    'writes a document of the organization that may belong to another store than the one of the header: its trigger reads the rows of the store of the DOCUMENT, so the service writes in units of its own, each in the context of the whole organization, and the reach of the person (HC-128) is checked inside them'
  )
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
        actorOf(user, store, req),
        this.manageGuard(organization.id, user.id, [documentId])
      )
    }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @NoStore()
  @NoTenantTransaction(
    'writes a document of the organization that may belong to another store than the one of the header: its trigger reads the rows of the store of the DOCUMENT, so the service writes in units of its own, each in the context of the whole organization, and the reach of the person (HC-128) is checked inside them'
  )
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
      actorOf(user, store, req),
      this.manageGuard(organization.id, user.id, [documentId])
    )
    await this.enqueueAfterCommit(organization.id, documentId, retried.submission)
    return { data: { queued: true } }
  }

  // A document that may be at the issuer it was made with, which was changed since: a person who checked with the authority that it is
  // not there says so, with the reason, and it is made again with the issuer as it is now. HIGH tier like the void: the interface asks
  // for the confirmation before it sends this.
  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @NoStore()
  @NoTenantTransaction(
    'writes a document of the organization that may belong to another store than the one of the header: its trigger reads the rows of the store of the DOCUMENT, so the service writes in units of its own, each in the context of the whole organization, and the reach of the person (HC-128) is checked inside them'
  )
  @Post(ApiRoutes.fiscal.documents.confirmIssuerChange(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async confirmIssuerChange(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) documentId: string,
    @Body(new ZodValidationPipe(confirmIssuerChangeSchema)) body: ConfirmIssuerChangeBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: { queued: true } }> {
    const confirmed = await this.documents.confirmIssuerChange(
      organization.id,
      documentId,
      body.reason,
      actorOf(user, store, req),
      this.manageGuard(organization.id, user.id, [documentId])
    )
    await this.enqueueAfterCommit(organization.id, documentId, confirmed.submission)
    return { data: { queued: true } }
  }

  // HIGH tier of DestructiveActionTiers (VOID_FISCAL_DOCUMENT): the interface asks before it sends this
  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @NoStore()
  @NoTenantTransaction(
    'writes a document of the organization that may belong to another store than the one of the header: its trigger reads the rows of the store of the DOCUMENT, so the service writes in units of its own, each in the context of the whole organization, and the reach of the person (HC-128) is checked inside them; the call to the authority is never inside one'
  )
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
    // The document that takes the place of this one is a document of the caller's reach too
    const guard = this.manageGuard(
      organization.id,
      user.id,
      body.replacementDocumentId === undefined
        ? [documentId]
        : [documentId, body.replacementDocumentId]
    )
    return {
      data: await this.documents.void(
        organization.id,
        documentId,
        body.reason,
        actorOf(user, store, req),
        guard,
        {
          ...(body.kind === undefined ? {} : { kind: body.kind }),
          ...(body.responsible === undefined ? {} : { responsible: body.responsible }),
          ...(body.requester === undefined ? {} : { requester: body.requester }),
          ...(body.replacementDocumentId === undefined
            ? {}
            : { replacementDocumentId: body.replacementDocumentId })
        }
      )
    }
  }

  // The sale document made again after the one before was voided (and its credit notes): a new document with a new number, queued
  @RequirePermissions(Permissions.FISCAL_MANAGE)
  @NoStore()
  @NoTenantTransaction(
    'writes a document of the organization that may belong to another store than the one of the header: its trigger reads the rows of the store of the DOCUMENT, so the service writes in units of its own, each in the context of the whole organization, and the reach of the person (HC-128) is checked inside them'
  )
  @Post(ApiRoutes.fiscal.documents.replace(':id'))
  @HttpCode(HttpStatusCodes.OK)
  async replace(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) documentId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: FiscalDocumentView }> {
    const made = await this.documents.replace(
      organization.id,
      documentId,
      actorOf(user, store, req),
      this.manageGuard(organization.id, user.id, [documentId])
    )
    // The sale document first; each credit note waits for it (its job asks again until the sale is accepted)
    // The documents are committed: one that cannot be queued (the queue blinked) does not stop the others and does not fail the request,
    // which a repeat would refuse. It stays QUEUED and a person retries it from its route.
    for (const created of [made.id, ...made.creditNoteIds]) {
      try {
        await this.queue.enqueue(organization.id, created, 1)
      } catch (error) {
        this.logger.error(
          { err: errorName(error), documentId: created },
          'a fiscal document was made and could not be queued'
        )
      }
    }
    return { data: await this.documents.viewOf(organization.id, made.id) }
  }
}
