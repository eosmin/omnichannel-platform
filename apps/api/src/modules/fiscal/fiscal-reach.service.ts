import { Injectable } from '@nestjs/common'

import type { Permission } from '@platform/core/auth'
import { JobContext, PrismaService } from '@platform/core/database'
import { FiscalLimits } from '@platform/core/domain'
import { resourceNotFound } from '@platform/core/errors'

import { storesOf } from '../counts/counts.support'

// What a person reaches of the fiscal documents (HC-128, owner 2026-11-18): the documents are the organization's in the data, but each one
// belongs to the store of its sale, and a person reaches it only in the stores where they hold the permission of the route (read or
// manage). A document out of that reach is a document that does not exist (404, never a 403 that tells it is there), on every route that
// takes a document by id and in the lists and the reconciliation, which are filtered by it. The ledger and its reports stay the
// organization's (TDD_18 §9.1): this is the fiscal document, whose rows carry their own store.
@Injectable()
export class FiscalReachService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobContext: JobContext
  ) {}

  // The stores of the organization where the person holds the permission, active member only
  stores(organizationId: string, userId: string, permission: Permission): Promise<string[]> {
    return storesOf(this.prisma.client, organizationId, userId, permission)
  }

  // The same for a route that is @NoTenantTransaction (the request holds no context): the read is one short unit of the organization
  storesInUnit(organizationId: string, userId: string, permission: Permission): Promise<string[]> {
    return this.jobContext.inOrganization(
      organizationId,
      () => this.stores(organizationId, userId, permission),
      { maxWait: FiscalLimits.CONTEXT_MAX_WAIT_MS, timeout: FiscalLimits.CONTEXT_TIMEOUT_MS }
    )
  }

  // Every one of the documents is the organization's and belongs to a store of the reach, or none of them is known
  async assertDocuments(
    organizationId: string,
    documentIds: readonly string[],
    stores: readonly string[]
  ): Promise<void> {
    const ids = [...new Set(documentIds)]
    if (ids.length === 0) return
    const known =
      stores.length === 0
        ? 0
        : await this.prisma.client.fiscalDocument.count({
            where: { id: { in: ids }, organizationId, storeId: { in: [...stores] } }
          })
    if (known !== ids.length) throw resourceNotFound('fiscal document')
  }
}
