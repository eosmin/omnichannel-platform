import { Body, Controller, Get, HttpCode, Param, Put, Query, Req, Res } from '@nestjs/common'
import type { Response } from 'express'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, type Permission, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { LegalBookHeaders, LegalBookKind } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { ExportContentTypes, ExportFileExtensions } from '@platform/core/exports'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  actorOf,
  CurrentOrganization,
  CurrentPermissions,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  type BookLayoutBody,
  bookLayoutBodySchema,
  type BookQuery,
  bookQuerySchema,
  type FrozenBooksQuery,
  frozenBooksQuerySchema,
  legalBookKindSchema
} from './finance-books.schemas'
import {
  type BookLayoutView,
  type BookView,
  FinanceBooksService,
  type FrozenBookView
} from './finance-books.service'
import { idSchema } from './finance.schemas'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)
const kind = () => new ZodValidationPipe(legalBookKindSchema)

// The legal books of the organization (TDD_18 §7; Step 4B.8b-3), read-only reports over the ledger. **[ACCOUNTANT]** The layout of each
// book is the organization's own data until the accountant confirms it; the proposal says it is unvalidated in every answer.
// A book lists supplier names and tax ids, so reading it (as JSON, from the frozen list or as a file) asks for finance:view_reports AND
// finance:export; the layouts need only the first, and writing a layout for
// finance:manage_accounts (the settings of the books).
@Controller()
export class FinanceBooksController {
  constructor(private readonly books: FinanceBooksService) {}

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS)
  @NoStore()
  @Get(ApiRoutes.finance.bookLayouts.list)
  layouts(@CurrentOrganization() organization: Organization): Promise<BookLayoutView[]> {
    return this.books.layouts(organization.id)
  }

  // Writes a NEW version of the layout of a kind of book; an earlier version is never changed
  @RequirePermissions(Permissions.FINANCE_MANAGE_ACCOUNTS)
  @NoStore()
  @Put(ApiRoutes.finance.bookLayouts.byKind(':kind'))
  @HttpCode(HttpStatusCodes.OK)
  writeLayout(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind', kind()) bookKind: LegalBookKind,
    @Body(new ZodValidationPipe(bookLayoutBodySchema)) body: BookLayoutBody,
    @CurrentPermissions() held: readonly Permission[],
    @Req() req: AuthenticatedRequest
  ): Promise<BookLayoutView> {
    // Saying the accountant vouched for the layout takes the permission of its own: whoever manages the settings may write a layout, not
    // make a draft look validated (QA FIS-426)
    if (body.accountantConfirmed && !held.includes(Permissions.FINANCE_CONFIRM_BOOKS)) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'confirming the layout of a book needs finance:confirm_books',
        HttpStatusCodes.FORBIDDEN
      )
    }
    return this.books.writeLayout(organization.id, bookKind, body, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @NoStore()
  @Get(ApiRoutes.finance.frozenBooks.list)
  frozen(
    @CurrentOrganization() organization: Organization,
    @Query(new ZodValidationPipe(frozenBooksQuerySchema)) query: FrozenBooksQuery
  ): Promise<FrozenBookView[]> {
    return this.books.frozenList(organization.id, query)
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @NoStore()
  @Get(ApiRoutes.finance.frozenBooks.byId(':id'))
  frozenById(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('id', id()) frozenId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<BookView> {
    return this.books.frozenById(organization.id, frozenId, actorOf(user, store, req))
  }

  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @NoStore()
  @Get(ApiRoutes.finance.books.byKind(':kind'))
  book(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind', kind()) bookKind: LegalBookKind,
    @Query(new ZodValidationPipe(bookQuerySchema)) query: BookQuery,
    @Req() req: AuthenticatedRequest
  ): Promise<BookView> {
    return this.books.book(organization.id, bookKind, query, actorOf(user, store, req))
  }

  // A file is an attachment and no shared cache keeps it
  @RequirePermissions(Permissions.FINANCE_VIEW_REPORTS, Permissions.FINANCE_EXPORT)
  @NoStore()
  @Get(ApiRoutes.finance.books.csvByKind(':kind'))
  async bookCsv(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('kind', kind()) bookKind: LegalBookKind,
    @Query(new ZodValidationPipe(bookQuerySchema)) query: BookQuery,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response
  ): Promise<string> {
    const { csv, fileName, book } = await this.books.csv(
      organization.id,
      bookKind,
      query,
      actorOf(user, store, req)
    )
    res.setHeader('Content-Type', ExportContentTypes.CSV)
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${fileName}.${ExportFileExtensions.CSV}"`
    )
    res.setHeader('Cache-Control', 'no-store')
    // What the layout is: the file carries only the rows, so the state of the book travels beside it
    res.setHeader(LegalBookHeaders.UNVALIDATED, String(book.unvalidated))
    res.setHeader(LegalBookHeaders.SHA256, book.contentSha256)
    return csv
  }
}
