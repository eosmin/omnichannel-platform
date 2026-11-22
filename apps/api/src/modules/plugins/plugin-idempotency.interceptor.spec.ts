import type { CallHandler, ExecutionContext } from '@nestjs/common'
import type { PinoLogger } from 'nestjs-pino'
import { lastValueFrom, of, throwError } from 'rxjs'

import { DatabaseNull, type PrismaService } from '@platform/core/database'
import {
  PluginIdempotency,
  PluginIdempotencyConflicts,
  PluginIdempotencyState
} from '@platform/core/domain'

import { PluginIdempotencyInterceptor } from './plugin-idempotency.interceptor'

interface Row {
  id: string
  storeId: string
  installationId: string
  key: string
  requestHash: string
  state: string
  responseStatus: number | null
  responseBody: unknown
  responseOmitted: boolean
  claimedAt: Date
  expiresAt: Date
}

const NO_BODY = Symbol('no body')

// The part of the table the interceptor uses, over an array: what each call does to the rows is what Postgres does
class FakeTable {
  rows: Row[] = []
  failClose = false
  private next = 1

  createMany({ data }: { data: Partial<Row>[] }): { count: number } {
    let count = 0
    for (const item of data) {
      const taken = this.rows.some(
        row => row.installationId === item.installationId && row.key === item.key
      )
      if (taken) continue
      this.rows.push({
        id: `row-${this.next++}`,
        responseStatus: null,
        responseBody: null,
        responseOmitted: false,
        ...item
      } as Row)
      count += 1
    }
    return { count }
  }

  findFirst({ where }: { where: Partial<Row> }): Row | null {
    return this.rows.find(row => this.matches(row, where)) ?? null
  }

  updateMany({ where, data }: { where: Partial<Row>; data: Partial<Row> }): { count: number } {
    if (this.failClose && data.state === PluginIdempotencyState.COMPLETED) {
      throw new Error('the database is gone')
    }
    const hit = this.rows.filter(row => this.matches(row, where))
    for (const row of hit) Object.assign(row, data, { responseBody: this.json(data.responseBody) })
    return { count: hit.length }
  }

  deleteMany({ where }: { where: Partial<Row> }): { count: number } {
    const hit = this.rows.filter(row => this.matches(row, where))
    this.rows = this.rows.filter(row => !hit.includes(row))
    return { count: hit.length }
  }

  // The database null of the Json column reads back as null
  private json(value: unknown): unknown {
    return value === DatabaseNull ? null : (value ?? null)
  }

  private matches(row: Row, where: Partial<Row>): boolean {
    return Object.entries(where).every(([name, wanted]) => {
      const have = row[name as keyof Row]
      return have instanceof Date && wanted instanceof Date
        ? have.getTime() === wanted.getTime()
        : have === wanted
    })
  }
}

function firstRow(table: FakeTable): Row {
  const row = table.rows[0]
  if (row === undefined) throw new Error('the table has no row')
  return row
}

const STORE = { id: 'store-1', organizationId: 'org-1' }
const INSTALLATION = { id: 'inst-1', pluginId: 'plug', scopes: [] }

function build(table = new FakeTable(), inRequestTransaction = false) {
  const opened = jest.fn()
  const prisma = {
    tenantTransaction: <T>(_tenant: unknown, work: () => Promise<T>) => {
      opened()
      return work()
    },
    hasTenantContext: () => inRequestTransaction,
    client: { pluginIdempotencyKey: table }
  }
  const logger = { setContext: jest.fn(), warn: jest.fn(), error: jest.fn() }
  const interceptor = new PluginIdempotencyInterceptor(
    prisma as unknown as PrismaService,
    logger as unknown as PinoLogger
  )
  return { interceptor, table, logger, opened }
}

function call(
  interceptor: PluginIdempotencyInterceptor,
  options: {
    method?: string
    header?: string | undefined
    body?: unknown
    url?: string
    installation?: unknown
    handler?: () => unknown
    status?: number
    contentType?: string
  } = {}
) {
  const headers: Record<string, string> = {}
  const response = {
    statusCode: options.status ?? 201,
    headers,
    status(code: number) {
      this.statusCode = code
      return this
    },
    setHeader(name: string, value: string) {
      headers[name] = value
    }
  }
  const request = {
    method: options.method ?? 'POST',
    originalUrl: options.url ?? '/api/v1/plugin-api/orders',
    body: options.body ?? { a: 1 },
    headers: {
      ...(options.header === undefined ? {} : { [PluginIdempotency.HEADER]: options.header }),
      ...(options.contentType === undefined ? {} : { 'content-type': options.contentType })
    },
    pluginInstallation: 'installation' in options ? options.installation : INSTALLATION,
    store: STORE
  }
  const context = {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => response })
  } as unknown as ExecutionContext
  const run = jest.fn(() => {
    const result = options.handler === undefined ? { id: 'order-1' } : options.handler()
    return result instanceof Error ? throwError(() => result) : of(result)
  })
  const next = { handle: run } as unknown as CallHandler
  const outcome = interceptor
    .intercept(context, next)
    .then(stream => lastValueFrom(stream, { defaultValue: NO_BODY }))
  return { outcome, run, response }
}

const conflictReason = (error: unknown) =>
  (error as { metadata?: { reason?: string } }).metadata?.reason

describe('PluginIdempotencyInterceptor', () => {
  it('leaves a call with no key, a read, or a route that is not a plugin one as it is', async () => {
    const { interceptor, table } = build()

    const noKey = call(interceptor)
    const read = call(interceptor, { method: 'GET', header: 'k' })
    const notPlugin = call(interceptor, { header: 'k', installation: undefined })

    await expect(noKey.outcome).resolves.toEqual({ id: 'order-1' })
    await expect(read.outcome).resolves.toEqual({ id: 'order-1' })
    await expect(notPlugin.outcome).resolves.toEqual({ id: 'order-1' })
    expect(table.rows).toHaveLength(0)
  })

  it('refuses a key a plugin may not send, before anything runs', async () => {
    const { interceptor, table } = build()

    const refused = call(interceptor, { header: 'has space' })

    await expect(refused.outcome).rejects.toMatchObject({ statusCode: 400 })
    expect(refused.run).not.toHaveBeenCalled()
    expect(table.rows).toHaveLength(0)
  })

  it('runs the first call, keeps its status and answer, and gives them back to the same call without running it', async () => {
    const { interceptor, table } = build()

    const first = call(interceptor, { header: 'k1' })
    await expect(first.outcome).resolves.toEqual({ id: 'order-1' })
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({
      storeId: STORE.id,
      installationId: INSTALLATION.id,
      key: 'k1',
      state: PluginIdempotencyState.COMPLETED,
      responseStatus: 201,
      responseBody: { id: 'order-1' },
      responseOmitted: false
    })
    const kept = firstRow(table)
    const ttl = kept.expiresAt.getTime() - kept.claimedAt.getTime()
    expect(ttl).toBe(PluginIdempotency.TTL_HOURS * 3_600_000)

    const again = call(interceptor, {
      header: 'k1',
      status: 200,
      handler: () => ({ id: 'order-2' })
    })
    await expect(again.outcome).resolves.toEqual({ id: 'order-1' })
    expect(again.run).not.toHaveBeenCalled()
    expect(again.response.statusCode).toBe(201)
    expect(again.response.headers[PluginIdempotency.REPLAY_HEADER]).toBe('true')
    expect(table.rows).toHaveLength(1)
  })

  it('keeps the status the route chose, such as 200 for what already existed', async () => {
    const { interceptor, table } = build()

    await call(interceptor, { header: 'k2', status: 200 }).outcome

    expect(table.rows[0]?.responseStatus).toBe(200)
  })

  it('takes a JSON body, or none, and refuses a key on a file or another raw body', async () => {
    const { interceptor, table } = build()

    for (const type of [
      'application/json',
      'application/json; charset=utf-8',
      'application/vnd.api+json'
    ]) {
      await expect(
        call(interceptor, { header: `ok-${type.length}`, contentType: type }).outcome
      ).resolves.toEqual({ id: 'order-1' })
    }
    for (const type of [
      'multipart/form-data; boundary=x',
      'application/octet-stream',
      'text/plain'
    ]) {
      const refused = call(interceptor, { header: 'k16', contentType: type })
      await expect(refused.outcome).rejects.toMatchObject({ statusCode: 400 })
      expect(refused.run).not.toHaveBeenCalled()
    }
    expect(table.rows.map(row => row.key)).not.toContain('k16')
  })

  it('treats a body that differs only in the order of its keys as the same request', async () => {
    const { interceptor } = build()
    await call(interceptor, { header: 'k3', body: { a: 1, b: 2 } }).outcome

    const again = call(interceptor, { header: 'k3', body: { b: 2, a: 1 } })

    await expect(again.outcome).resolves.toEqual({ id: 'order-1' })
    expect(again.run).not.toHaveBeenCalled()
  })

  it('refuses the key for another body, another route or another query, and does not run them', async () => {
    const { interceptor } = build()
    await call(interceptor, { header: 'k4' }).outcome

    for (const other of [
      call(interceptor, { header: 'k4', body: { a: 2 } }),
      call(interceptor, { header: 'k4', url: '/api/v1/plugin-api/transfers' }),
      call(interceptor, { header: 'k4', url: '/api/v1/plugin-api/orders?x=1' }),
      call(interceptor, { header: 'k4', method: 'PUT' })
    ]) {
      const error = await other.outcome.catch((caught: unknown) => caught)
      expect(error).toMatchObject({ statusCode: 409 })
      expect(conflictReason(error)).toBe(PluginIdempotencyConflicts.KEY_REUSED)
      expect(other.run).not.toHaveBeenCalled()
    }
  })

  it('keeps the keys of two installations apart', async () => {
    const { interceptor, table } = build()
    await call(interceptor, { header: 'k5' }).outcome

    const other = call(interceptor, {
      header: 'k5',
      installation: { ...INSTALLATION, id: 'inst-2' },
      handler: () => ({ id: 'order-9' })
    })

    await expect(other.outcome).resolves.toEqual({ id: 'order-9' })
    expect(other.run).toHaveBeenCalledTimes(1)
    expect(table.rows.map(row => row.installationId).sort()).toEqual(['inst-1', 'inst-2'])
  })

  it('makes a call wait with a 409 while the first one is still running', async () => {
    const { interceptor, table } = build()
    const now = new Date()
    table.rows.push({
      id: 'row-x',
      storeId: STORE.id,
      installationId: INSTALLATION.id,
      key: 'k6',
      requestHash: 'whatever',
      state: PluginIdempotencyState.IN_PROGRESS,
      responseStatus: null,
      responseBody: null,
      responseOmitted: false,
      claimedAt: now,
      expiresAt: new Date(now.getTime() + 3_600_000)
    })

    const waiting = call(interceptor, { header: 'k6' })

    const error = await waiting.outcome.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ statusCode: 409 })
    expect(waiting.run).not.toHaveBeenCalled()
  })

  it('takes a claim that nobody closed for longer than the limit, and runs again', async () => {
    const { interceptor, table } = build()
    const old = new Date(Date.now() - (PluginIdempotency.STALE_CLAIM_SECONDS + 5) * 1000)
    table.rows.push({
      id: 'row-y',
      storeId: STORE.id,
      installationId: INSTALLATION.id,
      key: 'k7',
      requestHash: 'older request',
      state: PluginIdempotencyState.IN_PROGRESS,
      responseStatus: null,
      responseBody: null,
      responseOmitted: false,
      claimedAt: old,
      expiresAt: new Date(old.getTime() + 24 * 3_600_000)
    })

    const retry = call(interceptor, { header: 'k7' })

    await expect(retry.outcome).resolves.toEqual({ id: 'order-1' })
    expect(retry.run).toHaveBeenCalledTimes(1)
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({ state: PluginIdempotencyState.COMPLETED })
  })

  it('does not take a claim that the first call closed after it was read as abandoned', async () => {
    const { interceptor, table } = build()
    const old = new Date(Date.now() - (PluginIdempotency.STALE_CLAIM_SECONDS + 5) * 1000)
    table.rows.push({
      id: 'row-z',
      storeId: STORE.id,
      installationId: INSTALLATION.id,
      key: 'k13',
      requestHash: 'x',
      state: PluginIdempotencyState.IN_PROGRESS,
      responseStatus: null,
      responseBody: null,
      responseOmitted: false,
      claimedAt: old,
      expiresAt: new Date(old.getTime() + 24 * 3_600_000)
    })
    // The retry reads the claim as abandoned; before it writes, the slow first call closes it
    const read = table.findFirst.bind(table)
    table.findFirst = args => {
      const snapshot = { ...(read(args) as Row) }
      Object.assign(table.rows[0] as Row, {
        state: PluginIdempotencyState.COMPLETED,
        responseStatus: 201
      })
      return snapshot
    }

    const retry = call(interceptor, { header: 'k13' })

    await expect(retry.outcome).rejects.toMatchObject({ statusCode: 409 })
    expect(retry.run).not.toHaveBeenCalled()
    expect(firstRow(table)).toMatchObject({ state: PluginIdempotencyState.COMPLETED })
  })

  it('opens no transaction of its own inside the one of the request, and leaves the removal of a failed claim to its rollback', async () => {
    const { interceptor, table, opened } = build(new FakeTable(), true)

    const ok = call(interceptor, { header: 'k14' })
    await expect(ok.outcome).resolves.toEqual({ id: 'order-1' })
    const failed = call(interceptor, { header: 'k15', handler: () => new Error('boom') })
    await expect(failed.outcome).rejects.toThrow('boom')

    expect(opened).not.toHaveBeenCalled()
    expect(table.rows.map(row => row.key)).toEqual(['k14', 'k15'])
  })

  it('runs again a key whose day is over, with the new request', async () => {
    const { interceptor, table } = build()
    await call(interceptor, { header: 'k8' }).outcome
    firstRow(table).expiresAt = new Date(Date.now() - 1000)

    const later = call(interceptor, {
      header: 'k8',
      body: { a: 2 },
      handler: () => ({ id: 'new' })
    })

    await expect(later.outcome).resolves.toEqual({ id: 'new' })
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({ responseBody: { id: 'new' } })
    expect(firstRow(table).expiresAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('removes its claim when the call fails, so the retry runs, and gives the error as it was', async () => {
    const { interceptor, table } = build()
    const failure = new Error('boom')

    const failed = call(interceptor, { header: 'k9', handler: () => failure })
    await expect(failed.outcome).rejects.toBe(failure)
    expect(table.rows).toHaveLength(0)

    const retry = call(interceptor, { header: 'k9' })
    await expect(retry.outcome).resolves.toEqual({ id: 'order-1' })
    expect(retry.run).toHaveBeenCalledTimes(1)
  })

  it('does not keep an answer that is too big, and says so to the retry instead of repeating the write', async () => {
    const { interceptor, table, logger } = build()
    const big = { text: 'x'.repeat(PluginIdempotency.BODY_MAX_BYTES + 1) }

    const first = call(interceptor, { header: 'k10', handler: () => big })
    await expect(first.outcome).resolves.toEqual(big)
    expect(table.rows[0]).toMatchObject({
      state: PluginIdempotencyState.COMPLETED,
      responseOmitted: true,
      responseBody: null
    })
    expect(logger.warn).toHaveBeenCalledTimes(1)

    const retry = call(interceptor, { header: 'k10' })
    const error = await retry.outcome.catch((caught: unknown) => caught)
    expect(error).toMatchObject({ statusCode: 409 })
    expect(conflictReason(error)).toBe(PluginIdempotencyConflicts.RESULT_NOT_KEPT)
    expect(retry.run).not.toHaveBeenCalled()
  })

  it('still answers the call when its answer cannot be kept, and keeps the claim so a retry waits', async () => {
    const { interceptor, table, logger } = build()
    table.failClose = true

    const first = call(interceptor, { header: 'k11' })

    await expect(first.outcome).resolves.toEqual({ id: 'order-1' })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(table.rows).toHaveLength(1)
    expect(table.rows[0]).toMatchObject({ state: PluginIdempotencyState.IN_PROGRESS })
    const retry = call(interceptor, { header: 'k11' })
    await expect(retry.outcome).rejects.toMatchObject({ statusCode: 409 })
    expect(retry.run).not.toHaveBeenCalled()
  })

  it('keeps a call with no body: a replay answers with no body', async () => {
    const { interceptor } = build()
    await call(interceptor, { header: 'k12', status: 204, handler: () => undefined }).outcome

    const again = call(interceptor, { header: 'k12', status: 200 })

    await expect(again.outcome).resolves.toBeUndefined()
    expect(again.response.statusCode).toBe(204)
  })
})
