import { PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants'
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum'

import { ApiKeysController } from './api-keys/api-keys.controller'
import { FinanceBankController } from './finance/finance-bank.controller'
import { FinanceBooksController } from './finance/finance-books.controller'
import { FinanceMarginController } from './finance/finance-margin.controller'
import { FinanceReportsController } from './finance/finance-reports.controller'
import { FinanceStatementsController } from './finance/finance-statements.controller'
import { FinanceTransactionsController } from './finance/finance-transactions.controller'
import { FinanceController } from './finance/finance.controller'
import { CustomerFiscalDataController } from './fiscal/customer-fiscal-data.controller'
import { FiscalController } from './fiscal/fiscal.controller'
import { PluginWidgetsController } from './plugin-widgets/plugin-widgets.controller'
import { PurchaseOrdersController } from './purchases/purchase-orders.controller'
import { SuppliersController } from './purchases/suppliers.controller'
import { PluginSearchController } from './search/plugin-search.controller'
import { SearchController } from './search/search.controller'
import { TenantWebhooksController } from './tenant-webhooks/tenant-webhooks.controller'

const HEADERS_METADATA = '__headers__'

type Controller = { prototype: object }

// Every route of these controllers answers with money, a fiscal document, a secret or a session, or with customers and messages found
// by a search (QA N-A7-01)
const MONEY_CONTROLLERS: readonly Controller[] = [
  FiscalController,
  CustomerFiscalDataController,
  FinanceController,
  FinanceBankController,
  FinanceBooksController,
  FinanceMarginController,
  FinanceReportsController,
  FinanceStatementsController,
  FinanceTransactionsController,
  PurchaseOrdersController,
  SuppliersController,
  SearchController,
  PluginSearchController
]

// Of these only the routes that mint a secret or a session
const SECRET_ROUTES: readonly { controller: Controller; handlers: readonly string[] }[] = [
  { controller: ApiKeysController, handlers: ['create'] },
  { controller: TenantWebhooksController, handlers: ['create', 'rotateSecret'] },
  // The lists of the widgets name the plugins installed and what each one shows (QA N-A7-02)
  { controller: PluginWidgetsController, handlers: ['openSession', 'bridge', 'list', 'settings'] }
]

function handlersOf(controller: Controller): string[] {
  const names = new Set<string>()
  // The routes a base class gives are routes of the controller too
  for (
    let proto: object | null = controller.prototype;
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto) as object | null
  ) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      const handler = (proto as Record<string, unknown>)[name]
      if (typeof handler === 'function' && Reflect.hasMetadata(METHOD_METADATA, handler)) {
        names.add(name)
      }
    }
  }
  return [...names]
}

function handlerOf(controller: Controller, name: string): object {
  const handler = (controller.prototype as Record<string, object | undefined>)[name]
  if (!handler) throw new Error(`${controller.prototype.constructor.name} has no handler ${name}`)
  return handler
}

function hasNoStore(controller: Controller, name: string): boolean {
  const headers = Reflect.getMetadata(HEADERS_METADATA, handlerOf(controller, name)) as
    { name: string; value: string }[] | undefined
  return (headers ?? []).some(
    header => header.name === 'Cache-Control' && header.value === 'no-store'
  )
}

// A route that takes the response sets its own headers (the CSV files)
function takesResponse(controller: Controller, name: string): boolean {
  const args = (Reflect.getMetadata(ROUTE_ARGS_METADATA, controller.prototype.constructor, name) ??
    {}) as Record<string, unknown>
  return Object.keys(args).some(key => key.startsWith(`${RouteParamtypes.RESPONSE}:`))
}

describe('Cache-Control: no-store on the routes of money, fiscal documents, secrets and sessions', () => {
  // A Nest upgrade that renames the metadata would turn the checks below into vacuous passes
  const [firstHandler = ''] = handlersOf(FiscalController)
  it('reads the metadata Nest keeps: a known route has the header and a known file route takes the response', () => {
    expect(hasNoStore(FiscalController, firstHandler)).toBe(true)
    expect(
      handlersOf(FinanceBooksController).some(n => takesResponse(FinanceBooksController, n))
    ).toBe(true)
  })

  it.each(MONEY_CONTROLLERS.map(c => [c.prototype.constructor.name, c] as const))(
    '%s answers every route with no-store',
    (_name, controller) => {
      const handlers = handlersOf(controller)
      expect(handlers.length).toBeGreaterThan(0)
      const missing = handlers.filter(
        name => !takesResponse(controller, name) && !hasNoStore(controller, name)
      )
      expect(missing).toEqual([])
    }
  )

  it.each(
    SECRET_ROUTES.flatMap(r =>
      r.handlers.map(h => [r.controller.prototype.constructor.name, h, r.controller] as const)
    )
  )('%s.%s answers with no-store', (_name, handler, controller) => {
    expect(Reflect.hasMetadata(PATH_METADATA, handlerOf(controller, handler))).toBe(true)
    expect(hasNoStore(controller, handler)).toBe(true)
  })
})
