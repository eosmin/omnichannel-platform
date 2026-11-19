import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { firstValueFrom, of } from 'rxjs'

import type { PrismaService, TenantContext } from '@platform/core/database'
import type { AuthenticatedRequest } from '@platform/core/logger'

import {
  NO_TENANT_TRANSACTION_KEY,
  NoTenantTransaction,
  TENANT_ORGANIZATION_STORES_KEY,
  TenantOfOrganizationStores
} from './decorators'
import { TenantContextInterceptor, tenantContextOf } from './tenant-context.interceptor'

const STORE = { id: 'store-1', organizationId: 'org-1', name: 'Store' }

function requestOf(parts: Partial<AuthenticatedRequest>): AuthenticatedRequest {
  return parts as AuthenticatedRequest
}

class Plain {
  handler(): string {
    return 'plain'
  }
}
class Marked {
  @NoTenantTransaction('calls a carrier')
  handler(): string {
    return 'marked'
  }
}

class Wide {
  @TenantOfOrganizationStores('lines of several stores')
  handler(): string {
    return 'wide'
  }
}

// The method as a value, read from the descriptor so that the spec never holds an unbound method
const handlerOf = (target: typeof Plain | typeof Marked | typeof Wide): (() => string) =>
  Object.getOwnPropertyDescriptor(target.prototype, 'handler')?.value as () => string

function contextFor(
  target: typeof Plain | typeof Marked | typeof Wide,
  request: AuthenticatedRequest,
  type = 'http'
): ExecutionContext {
  return {
    getType: () => type,
    getHandler: () => handlerOf(target),
    getClass: () => target,
    switchToHttp: () => ({ getRequest: () => request })
  } as unknown as ExecutionContext
}

function build(
  enabled: boolean,
  storesOfOrganization: string[] = []
): {
  interceptor: TenantContextInterceptor
  opened: TenantContext[]
  reads: unknown[]
} {
  const opened: TenantContext[] = []
  const reads: unknown[] = []
  const prisma = {
    client: {
      store: {
        findMany: (args: unknown) => {
          reads.push(args)
          return Promise.resolve(storesOfOrganization.map(id => ({ id })))
        }
      }
    },
    tenantTransaction: async (context: TenantContext, fn: () => Promise<unknown>) => {
      opened.push(context)
      return fn()
    }
  } as unknown as PrismaService
  return {
    interceptor: new TenantContextInterceptor(new Reflector(), prisma, enabled),
    opened,
    reads
  }
}

const next = (value: unknown): CallHandler => ({ handle: () => of(value) })

describe('tenantContextOf', () => {
  it('gives the store, its organization and the person of a request of a store', () => {
    expect(tenantContextOf(requestOf({ store: STORE, user: { id: 'u-1' } as never }))).toEqual({
      storeIds: ['store-1'],
      organizationIds: ['org-1'],
      userId: 'u-1'
    })
  })

  it('gives only the person to a route of a person (no store)', () => {
    expect(tenantContextOf(requestOf({ user: { id: 'u-1' } as never }))).toEqual({
      storeIds: [],
      organizationIds: [],
      userId: 'u-1'
    })
  })

  it('gives nothing to a request nobody is behind', () => {
    expect(tenantContextOf(requestOf({}))).toBeUndefined()
  })

  it('does not read a store from the body or the query', () => {
    const request = requestOf({
      user: { id: 'u-1' } as never,
      body: { storeId: 'evil' },
      query: { storeId: 'evil' }
    })
    expect(tenantContextOf(request)?.storeIds).toEqual([])
  })
})

describe('TenantContextInterceptor', () => {
  const request = requestOf({ store: STORE, user: { id: 'u-1' } as never })

  it('does nothing while RLS_CONTEXT is off', async () => {
    const { interceptor, opened } = build(false)
    expect(
      await firstValueFrom(interceptor.intercept(contextFor(Plain, request), next('ok')))
    ).toBe('ok')
    expect(opened).toEqual([])
  })

  it('runs the handler inside one tenant transaction with the context of the request', async () => {
    const { interceptor, opened } = build(true)
    expect(
      await firstValueFrom(interceptor.intercept(contextFor(Plain, request), next('ok')))
    ).toBe('ok')
    expect(opened).toEqual([{ storeIds: ['store-1'], organizationIds: ['org-1'], userId: 'u-1' }])
  })

  it('leaves a route marked @NoTenantTransaction alone, and the mark needs a reason', async () => {
    const { interceptor, opened } = build(true)
    await firstValueFrom(interceptor.intercept(contextFor(Marked, request), next('ok')))
    expect(opened).toEqual([])
    expect(Reflect.getMetadata(NO_TENANT_TRANSACTION_KEY, handlerOf(Marked))).toBe(
      'calls a carrier'
    )
    expect(() => NoTenantTransaction('  ')).toThrow('needs a reason')
  })

  it('leaves alone a server-sent stream, and is off when the switch is not provided', async () => {
    const { interceptor, opened } = build(true)
    class Stream {
      handler(): string {
        return 'stream'
      }
    }
    Reflect.defineMetadata('__sse__', true, handlerOf(Stream))
    await firstValueFrom(interceptor.intercept(contextFor(Stream as never, request), next('ok')))
    expect(opened).toEqual([])
    const bare = new TenantContextInterceptor(new Reflector(), {
      tenantTransaction: () => Promise.reject(new Error('no'))
    } as never)
    expect(await firstValueFrom(bare.intercept(contextFor(Plain, request), next('ok')))).toBe('ok')
  })

  it('leaves alone what is not HTTP and a request nobody is behind', async () => {
    const { interceptor, opened } = build(true)
    await firstValueFrom(interceptor.intercept(contextFor(Plain, request, 'ws'), next('ok')))
    await firstValueFrom(interceptor.intercept(contextFor(Plain, requestOf({})), next('ok')))
    expect(opened).toEqual([])
  })

  it('answers undefined for a handler that emits nothing, and passes an error through', async () => {
    const { interceptor } = build(true)
    const empty: CallHandler = { handle: () => of() }
    expect(
      await firstValueFrom(interceptor.intercept(contextFor(Plain, request), empty))
    ).toBeUndefined()
    const failing: CallHandler = {
      handle: () => {
        throw new Error('boom')
      }
    }
    await expect(
      firstValueFrom(interceptor.intercept(contextFor(Plain, request), failing))
    ).rejects.toThrow('boom')
  })
})

describe('@TenantOfOrganizationStores', () => {
  const request = requestOf({ store: STORE, user: { id: 'u-1' } as never })

  it('opens the context with every store of the organization of the request, the store of the header first', async () => {
    const { interceptor, opened, reads } = build(true, ['store-0', 'store-1', 'store-2'])

    await firstValueFrom(interceptor.intercept(contextFor(Wide, request), next('ok')))

    expect(opened).toEqual([
      { storeIds: ['store-1', 'store-0', 'store-2'], organizationIds: ['org-1'], userId: 'u-1' }
    ])
    // Read by the organization the guard resolved, never by anything the request said
    expect(reads).toEqual([
      { where: { organizationId: { in: ['org-1'] } }, select: { id: true }, orderBy: { id: 'asc' } }
    ])
  })

  it('keeps the store of the header when the read comes back empty, and does not read for a plain route', async () => {
    const { interceptor, opened, reads } = build(true, [])

    await firstValueFrom(interceptor.intercept(contextFor(Wide, request), next('ok')))
    await firstValueFrom(interceptor.intercept(contextFor(Plain, request), next('ok')))

    expect(opened.map(context => context.storeIds)).toEqual([['store-1'], ['store-1']])
    expect(reads).toHaveLength(1)
  })

  it('reads nothing while the switch is off, and the mark needs a reason', async () => {
    const { interceptor, opened, reads } = build(false, ['store-2'])

    await firstValueFrom(interceptor.intercept(contextFor(Wide, request), next('ok')))

    expect(opened).toEqual([])
    expect(reads).toEqual([])
    expect(Reflect.getMetadata(TENANT_ORGANIZATION_STORES_KEY, handlerOf(Wide))).toBe(
      'lines of several stores'
    )
    expect(() => TenantOfOrganizationStores(' ')).toThrow('needs a reason')
  })
})
