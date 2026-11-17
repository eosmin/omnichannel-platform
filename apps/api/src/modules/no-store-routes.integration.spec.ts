import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { RequestMethod } from '@nestjs/common'
import { PATH_METADATA, METHOD_METADATA, ROUTE_ARGS_METADATA } from '@nestjs/common/constants'
import { RouteParamtypes } from '@nestjs/common/enums/route-paramtypes.enum'

import { ApiKeysController } from './api-keys/api-keys.controller'
import { ConversationsController } from './conversations/conversations.controller'
import { PluginConversationsController } from './conversations/plugin-conversations.controller'
import { CustomersController } from './customers/customers.controller'
import { PluginCustomersController } from './customers/plugin-customers.controller'
import { FinanceBankController } from './finance/finance-bank.controller'
import { FinanceBooksController } from './finance/finance-books.controller'
import { FinanceMarginController } from './finance/finance-margin.controller'
import { FinanceReportsController } from './finance/finance-reports.controller'
import { FinanceStatementsController } from './finance/finance-statements.controller'
import { FinanceTransactionsController } from './finance/finance-transactions.controller'
import { FinanceController } from './finance/finance.controller'
import { CustomerFiscalDataController } from './fiscal/customer-fiscal-data.controller'
import { FiscalContingencyController } from './fiscal/fiscal-contingency.controller'
import { FiscalController } from './fiscal/fiscal.controller'
import { MessagesController } from './messages/messages.controller'
import { PluginMessagesController } from './messages/plugin-messages.controller'
import { OrderMessagesController } from './order-messages/order-messages.controller'
import { OrdersController } from './orders/orders.controller'
import { PluginOrdersController } from './orders/plugin-orders.controller'
import { PluginWidgetsController } from './plugin-widgets/plugin-widgets.controller'
import { PurchaseOrdersController } from './purchases/purchase-orders.controller'
import { SuppliersController } from './purchases/suppliers.controller'
import { ReturnsController } from './returns/returns.controller'
import { PluginSearchController } from './search/plugin-search.controller'
import { SearchController } from './search/search.controller'
import { TenantWebhooksController } from './tenant-webhooks/tenant-webhooks.controller'

const HEADERS_METADATA = '__headers__'

type Controller = { prototype: object }

// Every route of these controllers answers with money, a fiscal document, a secret or a session, or with customers and messages found
// by a search (QA N-A7-01) or the customers, conversations, messages and orders themselves
const MONEY_CONTROLLERS: readonly Controller[] = [
  FiscalController,
  FiscalContingencyController,
  OrderMessagesController,
  ReturnsController,
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
  PluginSearchController,
  CustomersController,
  PluginCustomersController,
  ConversationsController,
  PluginConversationsController,
  MessagesController,
  PluginMessagesController,
  OrdersController,
  PluginOrdersController
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

// A route that takes the response sets its own headers (the CSV files, which take it with `passthrough: true` and set the
// header by hand): the spec cannot tell them from other routes that take it, so it skips them all (debt (b) of the plan)
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

// Every GET of every controller of the api (and of the libraries that bring one) answers with data of a store, a person or a
// secret, so it says no-store, unless it is on the short list below with its reason or takes the response itself (the files).
// A route added without the header fails here: nobody has to remember to add it to a list.
const CONTROLLER_ROOTS = [join(__dirname, '..'), join(__dirname, '../../../../libs')]

// A GET that may be kept by a cache, and why. Nothing of a store or a person belongs here.
const MAY_BE_CACHED: Record<string, string> = {
  'HealthController.live': 'liveness probe: no data',
  'HealthController.ready': 'readiness probe: no data',
  'MetricsController.scrape':
    'the metrics of the process, read by the scraper inside the network, not by a person'
}

function controllerFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    // The probe of the tests (`testing/`) is not a route of the product
    if (name === 'node_modules' || name === '.next' || name === 'testing') return []
    const path = join(dir, name)
    if (statSync(path).isDirectory()) return controllerFiles(path)
    return name.endsWith('.controller.ts') ? [path] : []
  })
}

// The file each controller was read from, for the routes that set their header by hand
const sourceOf = new Map<Controller, string>()

async function allControllers(): Promise<Controller[]> {
  const found: Controller[] = []
  for (const file of CONTROLLER_ROOTS.flatMap(controllerFiles)) {
    const exported = (await import(file)) as Record<string, unknown>
    for (const value of Object.values(exported)) {
      // A class of Nest with a path is a controller
      if (typeof value === 'function' && Reflect.hasMetadata(PATH_METADATA, value)) {
        found.push(value)
        sourceOf.set(value, file)
      }
    }
  }
  return found
}

describe('Cache-Control: no-store on every GET of the api', () => {
  it('answers no-store on every GET, except the ones that say why they may be cached', async () => {
    const controllers = await allControllers()
    const names = controllers.map(controller => controller.prototype.constructor.name)
    // The walk has to find the routes: a path that moved would turn this into a pass over nothing
    expect(names).toEqual(expect.arrayContaining(['ShipmentsController', 'SettingsController']))
    let checked = 0
    const missing: string[] = []
    const listed = new Set<string>()
    const handByHand: string[] = []
    for (const controller of controllers) {
      const controllerName = controller.prototype.constructor.name
      for (const name of handlersOf(controller)) {
        const handler = handlerOf(controller, name)
        if (Reflect.getMetadata(METHOD_METADATA, handler) !== RequestMethod.GET) continue
        const id = `${controllerName}.${name}`
        if (id in MAY_BE_CACHED) {
          listed.add(id)
          continue
        }
        if (takesResponse(controller, name)) {
          // A route that takes the response says it with the decorator, or sets the header by hand: then its file is read, so that
          // a new one is not skipped and a line that was removed is seen
          const source = readFileSync(sourceOf.get(controller) ?? '', 'utf8')
          if (
            !hasNoStore(controller, name) &&
            !/setHeader\(\s*'Cache-Control',\s*'no-store'\s*\)/.test(source)
          ) {
            handByHand.push(id)
          }
          continue
        }
        checked += 1
        if (!hasNoStore(controller, name)) missing.push(id)
      }
    }
    expect(checked).toBeGreaterThan(240)
    expect(missing).toEqual([])
    expect(handByHand).toEqual([])
    // A line of the list that names no route is a route that was renamed: the list is kept honest
    expect([...listed].sort()).toEqual(Object.keys(MAY_BE_CACHED).sort())
  })
})
