import { Permissions } from '@platform/core/auth'
import { PluginScopes } from '@platform/plugins/sdk'

import { type PluginApiRouteFacts, pluginApiRouteViolations } from './plugin-api-route-rules'

const declared = new Set(['/plugin-api/orders', '/plugin-api/setup/exchange'])
const withoutKey = new Set(['/plugin-api/setup/exchange'])

const route = (over: Partial<PluginApiRouteFacts> = {}): PluginApiRouteFacts => ({
  label: 'OrdersPluginController.list',
  path: '/plugin-api/orders',
  scopes: [PluginScopes.ORDERS_READ],
  isPublic: true,
  permissions: [Permissions.ORDERS_VIEW],
  anyOf: [],
  ...over
})
const violations = (...routes: PluginApiRouteFacts[]) =>
  pluginApiRouteViolations(routes, declared, withoutKey)

describe('pluginApiRouteViolations', () => {
  it('accepts a route whose permissions are inside what its scopes grant', () => {
    expect(violations(route())).toEqual([])
  })

  it('accepts a route that needs several permissions that the scopes together grant', () => {
    expect(
      violations(
        route({
          scopes: [PluginScopes.ORDERS_READ, PluginScopes.ORDERS_WRITE],
          permissions: [Permissions.ORDERS_VIEW, Permissions.ORDERS_CHANGE_STATUS]
        })
      )
    ).toEqual([])
  })

  it('refuses a permission outside what the scopes grant (the escalation the check exists for)', () => {
    expect(
      violations(route({ permissions: [Permissions.ORDERS_VIEW, Permissions.ORDERS_CANCEL] }))
    ).toEqual([
      `OrdersPluginController.list: ${Permissions.ORDERS_CANCEL} is outside what its scopes grant`
    ])
    // A read scope does not stand for a write permission
    expect(violations(route({ permissions: [Permissions.ORDERS_CHANGE_STATUS] }))).toHaveLength(1)
  })

  it('refuses a route that names scopes and no permission at all (the guard would let every key of the scope in)', () => {
    expect(violations(route({ permissions: [], anyOf: [] }))).toEqual([
      'OrdersPluginController.list: it names scopes and no @RequirePermissions'
    ])
  })

  it('refuses a route with no scope that asks a person for a permission', () => {
    expect(violations(route({ scopes: [], permissions: [Permissions.ORDERS_VIEW] }))).toHaveLength(
      1
    )
  })

  it('accepts a route with no scopes and no permissions (who the key is)', () => {
    expect(violations(route({ path: '/plugin-api/orders', scopes: [], permissions: [] }))).toEqual(
      []
    )
  })

  it('needs one of the "any" permissions inside the scopes', () => {
    expect(violations(route({ permissions: [], anyOf: [Permissions.ORDERS_VIEW] }))).toEqual([])
    expect(violations(route({ permissions: [], anyOf: [Permissions.ORDERS_CANCEL] }))).toHaveLength(
      1
    )
  })

  it('refuses a scope that does not exist', () => {
    expect(
      violations(route({ scopes: ['orders:everything'], permissions: [Permissions.ORDERS_VIEW] }))
    ).toEqual([
      'OrdersPluginController.list: orders:everything is not a plugin scope',
      `OrdersPluginController.list: ${Permissions.ORDERS_VIEW} is outside what its scopes grant`
    ])
  })

  it('matches a parameterized route whatever its parameter is called', () => {
    const byId = route({ path: '/plugin-api/orders/:orderId' })

    expect(
      pluginApiRouteViolations([byId], new Set(['/plugin-api/orders/:p']), withoutKey)
    ).toEqual([])
    expect(
      pluginApiRouteViolations([byId], new Set(['/plugin-api/orders/:id']), withoutKey)
    ).toEqual([])
    expect(
      pluginApiRouteViolations([byId], new Set(['/plugin-api/orders']), withoutKey)
    ).toHaveLength(1)
  })

  it('refuses a route under /plugin-api/ that carries no @PluginApi', () => {
    expect(violations(route({ scopes: undefined, isPublic: false }))).toEqual([
      'OrdersPluginController.list: a route under /plugin-api/ must carry @PluginApi'
    ])
    // Public is not enough: only the route that trades the code for a key has no key
    expect(violations(route({ scopes: undefined }))).toHaveLength(1)
  })

  it('lets the exchange of the setup code have no key, and no permissions', () => {
    const exchange = route({
      label: 'PluginApiController.exchange',
      path: '/plugin-api/setup/exchange',
      scopes: undefined,
      permissions: []
    })
    expect(violations(exchange)).toEqual([])
    expect(violations({ ...exchange, permissions: [Permissions.ORDERS_VIEW] })).toHaveLength(1)
    expect(violations({ ...exchange, isPublic: false })).toHaveLength(1)
  })

  it('refuses a route that is not declared in PluginApiRoutes', () => {
    expect(violations(route({ path: '/plugin-api/refunds' }))).toEqual([
      'OrdersPluginController.list: /plugin-api/refunds is not in PluginApiRoutes'
    ])
  })

  it('refuses a @PluginApi route outside /plugin-api/, and one that is not public to the global guards', () => {
    expect(violations(route({ path: '/orders' }))).toHaveLength(1)
    expect(violations(route({ isPublic: false }))).toHaveLength(1)
  })

  it('leaves the routes of the interface alone', () => {
    expect(violations(route({ path: '/orders', scopes: undefined, isPublic: false }))).toEqual([])
    expect(violations(route({ path: undefined, scopes: undefined }))).toEqual([])
  })
})
