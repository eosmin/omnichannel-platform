import type { ExecutionContext } from '@nestjs/common'
import { ROUTE_ARGS_METADATA } from '@nestjs/common/constants'

import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  CurrentMembership,
  CurrentOrganization,
  CurrentPermissions,
  CurrentStore,
  routePathOf
} from './decorators'

// The factory of a param decorator, taken out of the metadata Nest keeps for it
function factoryOf(
  decorator: () => ParameterDecorator
): (data: unknown, ctx: ExecutionContext) => unknown {
  class Host {
    handler(@decorator() _value: unknown): void {
      return undefined
    }
  }
  const metadata = Reflect.getMetadata(ROUTE_ARGS_METADATA, Host, 'handler') as Record<
    string,
    { factory: (data: unknown, ctx: ExecutionContext) => unknown }
  >
  return Object.values(metadata)[0]?.factory as (data: unknown, ctx: ExecutionContext) => unknown
}

const contextOf = (request: object): ExecutionContext =>
  ({ switchToHttp: () => ({ getRequest: () => request }) }) as unknown as ExecutionContext

describe.each([
  ['CurrentStore', CurrentStore, 'store', { id: 's', organizationId: 'o', name: 'n' }],
  ['CurrentOrganization', CurrentOrganization, 'organization', { id: 'o' }],
  [
    'CurrentMembership',
    CurrentMembership,
    'membership',
    { id: 'm', roleId: 'r', roleName: 'Admin' }
  ],
  ['CurrentPermissions', CurrentPermissions, 'permissions', ['customers:view']]
] as const)('%s', (_name, decorator, field, value) => {
  const factory = factoryOf(decorator)

  it('hands over what the TenantGuard put on the request', () => {
    expect(factory(undefined, contextOf({ [field]: value }))).toBe(value)
  })

  it('refuses to run with an empty context: the route is not behind the guard', () => {
    expect(() => factory(undefined, contextOf({}))).toThrow(/TenantGuard did not run/)
  })
})

describe('routePathOf', () => {
  it('gives the pattern of the matched route', () => {
    expect(routePathOf({ route: { path: '/a/:id' } } as unknown as AuthenticatedRequest)).toBe(
      '/a/:id'
    )
  })

  it('gives nothing when there was no match, or the pattern is not text', () => {
    expect(routePathOf({} as AuthenticatedRequest)).toBeUndefined()
    expect(
      routePathOf({ route: { path: /regex/ } } as unknown as AuthenticatedRequest)
    ).toBeUndefined()
  })
})
