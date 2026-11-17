import { Body, Controller, Delete, Get, HttpCode, Param, Put, Req } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { type AuthenticatedUser, Permissions } from '@platform/core/auth'
import { CurrentUser } from '@platform/core/auth-module'
import { HttpStatusCodes } from '@platform/core/errors'
import { NoStore, ZodValidationPipe } from '@platform/core/http'
import type { AuthenticatedRequest } from '@platform/core/logger'
import { FiscalCustomerDataService, type MaskedCustomerFiscalData } from '@platform/fiscal/runtime'

import {
  actorOf,
  CurrentOrganization,
  CurrentStore,
  RequirePermissions,
  type ResolvedTenant
} from '../tenancy'

import {
  type CustomerFiscalDataBody,
  customerFiscalDataSchema
} from './customer-fiscal-data.schemas'
import { idSchema } from './fiscal.schemas'

type Store = ResolvedTenant['store']
interface Organization {
  id: string
}

const id = () => new ZodValidationPipe(idSchema)

// The fiscal data of a customer of the store of X-Store-Id (TDD_18 §8, Step 4B.7b-3). The store comes from the guard, never from the
// body. Every answer is masked: the tax id and the registration show their last characters only, and the fiscal address is said to be set,
// never read back (the fiscal name, the kind of taxpayer and the activity are shown: they are what identifies the record). It is held by its own permissions, apart from `customers:view`, and it is not exposed to plugins (`/plugin-api/*`).
@Controller()
export class CustomerFiscalDataController {
  constructor(private readonly data: FiscalCustomerDataService) {}

  @RequirePermissions(Permissions.FISCAL_VIEW_CUSTOMER_DATA)
  @NoStore()
  @Get(ApiRoutes.fiscal.customerData.get(':customerId'))
  async get(
    @CurrentStore() store: Store,
    @Param('customerId', id()) customerId: string
  ): Promise<{ data: MaskedCustomerFiscalData | null }> {
    return { data: await this.data.get(store.id, customerId) }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE_CUSTOMER_DATA)
  @NoStore()
  @Put(ApiRoutes.fiscal.customerData.put(':customerId'))
  async put(
    @CurrentOrganization() organization: Organization,
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', id()) customerId: string,
    @Body(new ZodValidationPipe(customerFiscalDataSchema)) body: CustomerFiscalDataBody,
    @Req() req: AuthenticatedRequest
  ): Promise<{ data: { kept: boolean } }> {
    // The answer says whether data is kept and nothing of it: the permission to write is not the permission to read
    return {
      data: await this.data.put(
        organization.id,
        store.id,
        customerId,
        body,
        actorOf(user, store, req)
      )
    }
  }

  @RequirePermissions(Permissions.FISCAL_MANAGE_CUSTOMER_DATA)
  @NoStore()
  @Delete(ApiRoutes.fiscal.customerData.clear(':customerId'))
  @HttpCode(HttpStatusCodes.NO_CONTENT)
  async clear(
    @CurrentStore() store: Store,
    @CurrentUser() user: AuthenticatedUser,
    @Param('customerId', id()) customerId: string,
    @Req() req: AuthenticatedRequest
  ): Promise<void> {
    await this.data.clear(store.id, customerId, actorOf(user, store, req))
  }
}
