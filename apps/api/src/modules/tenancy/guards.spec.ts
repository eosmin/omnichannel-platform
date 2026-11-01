import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { Counter } from '@prometheus-io/client'
import type { PinoLogger } from 'nestjs-pino'

import type { Permission } from '@platform/core/auth'
import { Permissions } from '@platform/core/auth'
import { IS_PUBLIC_KEY } from '@platform/core/auth-module'
import { PlatformException } from '@platform/core/errors'

import type { AccessDenialAuditor } from './access-denial-auditor'
import { ANY_PERMISSION_KEY, PERMISSIONS_KEY, SKIP_TENANT_KEY } from './decorators'
import { PermissionGuard } from './permission.guard'
import type { TenantContextService } from './tenant-context.service'
import { TenantGuard } from './tenant.guard'

const USER = { id: '0b5f3f0e-6c36-4a4f-9d16-5b1d1c2f7a10', sessionFamilyId: 'f', email: 'a@b.co' }
const STORE_ID = '7c1e9a52-3d4b-4f6a-8b1c-2e5d7f9a0b34'

type Metadata = Partial<Record<'handler' | 'controller', Record<string, unknown>>>

// A request context whose handler and controller carry the given metadata
function contextOf(request: Record<string, unknown>, metadata: Metadata = {}): ExecutionContext {
  const handler = function handler(): void {
    return undefined
  }
  class Controller {}
  for (const [key, value] of Object.entries(metadata.handler ?? {})) {
    Reflect.defineMetadata(key, value, handler)
  }
  for (const [key, value] of Object.entries(metadata.controller ?? {})) {
    Reflect.defineMetadata(key, value, Controller)
  }
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext
}

async function failureOf(promise: Promise<unknown>): Promise<PlatformException> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PlatformException) return error
    throw error
  }
  throw new Error('it did not fail')
}

describe('TenantGuard', () => {
  function build(resolved: unknown = null) {
    const resolve = jest.fn(() => Promise.resolve(resolved))
    const record = jest.fn(() => Promise.resolve())
    const guard = new TenantGuard(
      new Reflector(),
      { resolve } as unknown as TenantContextService,
      { record } as unknown as AccessDenialAuditor
    )
    return { guard, resolve, record }
  }
  const header = (value: string | undefined) => (name: string) =>
    name === 'x-store-id' ? value : undefined

  it.each([
    ['a public route', { handler: { [IS_PUBLIC_KEY]: true } }],
    ['a route of a person', { handler: { [SKIP_TENANT_KEY]: true } }],
    ['a controller of persons', { controller: { [SKIP_TENANT_KEY]: true } }]
  ])('lets %s through without looking at the request', async (_name, metadata) => {
    const { guard, resolve } = build()

    await expect(guard.canActivate(contextOf({}, metadata))).resolves.toBe(true)

    expect(resolve).not.toHaveBeenCalled()
  })

  it('refuses with 401 when no user reached it, instead of looking for a store', async () => {
    const { guard, resolve } = build()

    const failure = await failureOf(guard.canActivate(contextOf({ header: header(STORE_ID) })))

    expect(failure.code).toBe('AUTH_UNAUTHORIZED')
    expect(failure.statusCode).toBe(401)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('asks the context of the user for the store of the header, lower-cased, and fills the request', async () => {
    const tenant = {
      store: { id: STORE_ID, organizationId: 'org', name: 'Shop' },
      membership: { id: 'm', roleId: 'r', roleName: 'Admin' },
      permissions: [Permissions.CUSTOMERS_VIEW]
    }
    const { guard, resolve } = build(tenant)
    const request: Record<string, unknown> = {
      user: USER,
      header: header(STORE_ID.toUpperCase())
    }

    await expect(guard.canActivate(contextOf(request))).resolves.toBe(true)

    expect(resolve).toHaveBeenCalledWith(USER.id, STORE_ID)
    expect(request).toMatchObject({
      store: tenant.store,
      organization: { id: 'org' },
      membership: tenant.membership,
      permissions: tenant.permissions
    })
  })

  it('hands the request copies it cannot change, so that a handler cannot alter what others share', async () => {
    const tenant = {
      store: { id: STORE_ID, organizationId: 'org', name: 'Shop' },
      membership: { id: 'm', roleId: 'r', roleName: 'Admin' },
      permissions: [Permissions.CUSTOMERS_VIEW]
    }
    const { guard } = build(tenant)
    const request: Record<string, unknown> = { user: USER, header: header(STORE_ID) }

    await guard.canActivate(contextOf(request))

    expect(Object.isFrozen(request['store'])).toBe(true)
    expect(Object.isFrozen(request['organization'])).toBe(true)
    expect(Object.isFrozen(request['membership'])).toBe(true)
    expect(Object.isFrozen(request['permissions'])).toBe(true)
    expect(request['store']).not.toBe(tenant.store) // A copy: the cached object is untouched
    expect(Object.isFrozen(tenant.store)).toBe(false)
  })

  it('records and refuses a store without access', async () => {
    const { guard, record } = build(null)
    const request = { user: USER, header: header(STORE_ID) }

    const failure = await failureOf(guard.canActivate(contextOf(request)))

    expect(failure.code).toBe('TENANT_ACCESS_DENIED')
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'tenant.access_denied',
        userId: USER.id,
        metadata: { requestedStoreId: STORE_ID }
      })
    )
  })
})

describe('PermissionGuard', () => {
  function build() {
    const record = jest.fn((_denial: Record<string, unknown>) => Promise.resolve())
    const inc = jest.fn()
    const error = jest.fn()
    const guard = new PermissionGuard(
      new Reflector(),
      { record } as unknown as AccessDenialAuditor,
      { setContext: jest.fn(), error } as unknown as PinoLogger,
      { inc } as unknown as Counter<string>
    )
    return { guard, record, inc, error }
  }
  const member = (permissions: Permission[]): Record<string, unknown> => ({
    user: USER,
    permissions,
    store: { id: STORE_ID },
    method: 'GET'
  })

  it('lets an exempt route through', async () => {
    const { guard } = build()

    await expect(
      guard.canActivate(contextOf({}, { handler: { [SKIP_TENANT_KEY]: true } }))
    ).resolves.toBe(true)
  })

  it('refuses when the TenantGuard did not run, because nothing can be decided', async () => {
    const { guard } = build()

    const noPermissions = await failureOf(
      guard.canActivate(contextOf({ user: USER }, { handler: { [PERMISSIONS_KEY]: ['x'] } }))
    )
    const noUser = await failureOf(
      guard.canActivate(contextOf({ permissions: [] }, { handler: { [PERMISSIONS_KEY]: ['x'] } }))
    )

    expect([noPermissions.code, noPermissions.statusCode]).toEqual(['INTERNAL_ERROR', 500])
    expect(noUser.code).toBe('INTERNAL_ERROR')
  })

  it('refuses a route that declares no permission, and says so in the log', async () => {
    const { guard, error } = build()

    const failure = await failureOf(
      guard.canActivate(contextOf(member([Permissions.CUSTOMERS_VIEW])))
    )

    expect(failure.code).toBe('PERMISSION_DENIED')
    expect(error).toHaveBeenCalledWith(expect.anything(), expect.stringContaining('declares no'))
  })

  it('wants every permission listed, not any of them', async () => {
    const { guard } = build()
    const metadata = {
      handler: { [PERMISSIONS_KEY]: [Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT] }
    }

    await expect(
      guard.canActivate(
        contextOf(member([Permissions.CUSTOMERS_VIEW, Permissions.CUSTOMERS_EDIT]), metadata)
      )
    ).resolves.toBe(true)
    const failure = await failureOf(
      guard.canActivate(contextOf(member([Permissions.CUSTOMERS_VIEW]), metadata))
    )
    expect(failure.metadata).toEqual({ required: [Permissions.CUSTOMERS_EDIT] })
  })

  it('lets in who holds one of the "any" list, and names the whole list when none is held', async () => {
    const { guard } = build()
    const metadata = {
      handler: {
        [ANY_PERMISSION_KEY]: [Permissions.CUSTOMERS_EXPORT, Permissions.MEDIA_DOWNLOAD_ALL]
      }
    }

    await expect(
      guard.canActivate(contextOf(member([Permissions.MEDIA_DOWNLOAD_ALL]), metadata))
    ).resolves.toBe(true)
    const failure = await failureOf(
      guard.canActivate(contextOf(member([Permissions.CUSTOMERS_VIEW]), metadata))
    )
    expect(failure.code).toBe('PERMISSION_DENIED')
    expect(failure.metadata).toEqual({
      required: [Permissions.CUSTOMERS_EXPORT, Permissions.MEDIA_DOWNLOAD_ALL]
    })
  })

  it('still wants all of @RequirePermissions next to an "any" list', async () => {
    const { guard } = build()
    const metadata = {
      handler: {
        [PERMISSIONS_KEY]: [Permissions.CUSTOMERS_VIEW],
        [ANY_PERMISSION_KEY]: [Permissions.CUSTOMERS_EXPORT]
      }
    }

    const failure = await failureOf(
      guard.canActivate(contextOf(member([Permissions.CUSTOMERS_EXPORT]), metadata))
    )
    expect(failure.metadata).toEqual({ required: [Permissions.CUSTOMERS_VIEW] })
  })

  it('adds the permissions of the controller to those of the handler', async () => {
    const { guard } = build()
    const metadata = {
      controller: { [PERMISSIONS_KEY]: [Permissions.CUSTOMERS_VIEW] },
      handler: { [PERMISSIONS_KEY]: [Permissions.CUSTOMERS_EDIT] }
    }

    const onlyHandler = await failureOf(
      guard.canActivate(contextOf(member([Permissions.CUSTOMERS_EDIT]), metadata))
    )
    const onlyController = await failureOf(
      guard.canActivate(contextOf(member([Permissions.CUSTOMERS_VIEW]), metadata))
    )

    expect(onlyHandler.metadata).toEqual({ required: [Permissions.CUSTOMERS_VIEW] })
    expect(onlyController.metadata).toEqual({ required: [Permissions.CUSTOMERS_EDIT] })
  })

  it('counts one refusal for each missing permission and records it with the store', async () => {
    const { guard, inc, record } = build()
    const metadata = {
      handler: { [PERMISSIONS_KEY]: [Permissions.CUSTOMERS_EDIT, Permissions.ORDERS_CANCEL] }
    }

    await failureOf(guard.canActivate(contextOf(member([]), metadata)))

    expect(inc.mock.calls).toEqual([
      [{ permission: Permissions.CUSTOMERS_EDIT }],
      [{ permission: Permissions.ORDERS_CANCEL }]
    ])
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'permission.denied',
        storeId: STORE_ID,
        metadata: { missing: [Permissions.CUSTOMERS_EDIT, Permissions.ORDERS_CANCEL] }
      })
    )
  })

  it('records a refusal without a store when the request has none', async () => {
    const { guard, record } = build()
    const request = { ...member([]), store: undefined }

    await failureOf(
      guard.canActivate(
        contextOf(request, { handler: { [PERMISSIONS_KEY]: [Permissions.CUSTOMERS_EDIT] } })
      )
    )

    expect(record.mock.calls[0]?.[0]).not.toHaveProperty('storeId')
  })
})
