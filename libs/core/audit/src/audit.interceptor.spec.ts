import type { CallHandler, ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import type { PinoLogger } from 'nestjs-pino'
import { lastValueFrom, of, throwError } from 'rxjs'

import { AuditAction } from '@platform/core/audit'

import { Audit } from './audit.decorator'
import { AuditInterceptor } from './audit.interceptor'
import type { AuditService } from './audit.service'

class Controller {
  @Audit(AuditAction.CUSTOMER_VIEWED, { resourceType: 'customer' })
  viewed(): string {
    return 'viewed'
  }

  @Audit(AuditAction.ORDER_CANCELLED, { resourceType: 'order', resourceIdParam: 'orderId' })
  cancelled(): string {
    return 'cancelled'
  }

  plain(): string {
    return 'plain'
  }
}

interface RequestFake {
  user?: { id: string }
  store?: { id: string }
  organization?: { id: string }
  params: Record<string, unknown>
  ip?: string
  get: (name: string) => string | undefined
}

function build(request: Partial<RequestFake>, handler: keyof Controller) {
  const log = jest.fn<void, [Record<string, unknown>]>()
  const error = jest.fn()
  const interceptor = new AuditInterceptor(
    new Reflector(),
    { log } as unknown as AuditService,
    { setContext: jest.fn(), error } as unknown as PinoLogger
  )
  const full: RequestFake = { params: {}, get: () => undefined, ...request }
  const context = {
    getHandler: () =>
      Object.getOwnPropertyDescriptor(Controller.prototype, handler)?.value as () => string,
    switchToHttp: () => ({ getRequest: () => full })
  } as unknown as ExecutionContext
  const run = (next: CallHandler): Promise<unknown> =>
    lastValueFrom(interceptor.intercept(context, next))
  return { run, log, error }
}

const ok: CallHandler = { handle: () => of('answer') }

describe('AuditInterceptor', () => {
  it('leaves a handler without @Audit alone', async () => {
    const { run, log } = build({ user: { id: 'u1' } }, 'plain')

    await expect(run(ok)).resolves.toBe('answer')

    expect(log).not.toHaveBeenCalled()
  })

  it('writes the entry after the handler answered, with the actor, the scope and the request', async () => {
    const { run, log } = build(
      {
        user: { id: 'u1' },
        store: { id: 's1' },
        organization: { id: 'o1' },
        params: { id: 'c1' },
        ip: '203.0.113.9',
        get: name => (name === 'user-agent' ? 'Firefox' : undefined)
      },
      'viewed'
    )

    await expect(run(ok)).resolves.toBe('answer')

    expect(log).toHaveBeenCalledWith({
      action: 'customer.viewed',
      actor: { userId: 'u1' },
      storeId: 's1',
      organizationId: 'o1',
      resourceType: 'customer',
      resourceId: 'c1',
      ipAddress: '203.0.113.9',
      userAgent: 'Firefox'
    })
  })

  it('reads the id from the route parameter the decorator names', async () => {
    const { run, log } = build(
      { user: { id: 'u1' }, params: { id: 'wrong', orderId: 'o9' } },
      'cancelled'
    )

    await run(ok)

    expect(log).toHaveBeenCalledWith(expect.objectContaining({ resourceId: 'o9' }))
  })

  it('writes nothing when the handler fails: an action that did not happen leaves no trace', async () => {
    const { run, log } = build({ user: { id: 'u1' }, params: { id: 'c1' } }, 'viewed')

    await expect(run({ handle: () => throwError(() => new Error('boom')) })).rejects.toThrow('boom')

    expect(log).not.toHaveBeenCalled()
  })

  it('does not guess an actor: with nobody logged in it writes nothing and says why', async () => {
    const { run, log, error } = build({ params: { id: 'c1' } }, 'viewed')

    await run(ok)

    expect(log).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(
      { action: 'customer.viewed' },
      expect.stringContaining('no authenticated user')
    )
  })

  it('leaves out an id that is not a single value', async () => {
    const { run, log } = build({ user: { id: 'u1' }, params: { id: ['a', 'b'] } }, 'viewed')

    await run(ok)

    expect(log.mock.calls[0]?.[0]).not.toHaveProperty('resourceId')
  })

  it('does not break the answer when the audit service throws', async () => {
    const { run, log } = build({ user: { id: 'u1' } }, 'viewed')
    log.mockImplementation(() => {
      throw new Error('should never happen, log() does not throw')
    })

    await expect(run(ok)).rejects.toThrow('should never happen')
  })
})
