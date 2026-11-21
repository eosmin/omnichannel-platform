import { AsyncLocalStorage } from 'node:async_hooks'

import type { PinoLogger } from 'nestjs-pino'

import { type EventContext, JobContextGoneError } from '@platform/core/database'
import { type WebhookEvent, WebhookDispatchLossReasons } from '@platform/core/domain'
import { type DomainEventPayloads, Events } from '@platform/core/events'
import { PluginScopes } from '@platform/plugins/sdk'

import { WebhookDispatcher } from './webhook-dispatcher'

const STORE = 'store-1'

// Compiles only while every event of the catalog carries the store in its payload: the dispatcher reads nothing else, and an
// event without it would be dropped with an error line each time
type EventsWithoutStore = {
  [E in WebhookEvent]: DomainEventPayloads[E] extends { storeId: string } ? never : E
}[WebhookEvent]
export const everyEventNamesItsStore: [EventsWithoutStore] extends [never] ? true : never = true

// A stand-in for the row security of the database: a read answers only when it runs inside a context of the store it asks for
function build(
  options: {
    goneStore?: boolean
    webhookReadFails?: boolean
    // The first N reads of the webhooks fail with the lock timeout of the database (SQLSTATE 55P03): a pause, not an answer
    transientWebhookReads?: number
    queueFails?: boolean
    // The installations read fails with the lock timeout this many times (a second side, read after the webhooks)
    transientInstallationReads?: number
    noWebhooks?: boolean
    installed?: boolean
    hiddenPlugin?: boolean
  } = {}
) {
  const open = new AsyncLocalStorage<string>()
  const opened: string[] = []
  const queued: { name: string; data: Record<string, unknown> }[][] = []
  const queuedOutside: boolean[] = []
  const errors: unknown[][] = []
  const lost: { labels: unknown; amount: number | undefined }[] = []
  let webhookReads = 0
  let installationReads = 0
  const events = {
    inStore: (storeId: string, work: () => Promise<unknown>) => {
      if (options.goneStore === true) return Promise.reject(new JobContextGoneError('gone'))
      opened.push(storeId)
      return open.run(storeId, work)
    }
  }
  const readsFor = <T>(rows: T[]): Promise<T[]> =>
    Promise.resolve(open.getStore() === STORE ? rows : [])
  const prisma = {
    client: {
      webhook: {
        findMany: () => {
          webhookReads += 1
          if (webhookReads <= (options.transientWebhookReads ?? 0)) {
            return Promise.reject(Object.assign(new Error('lock timeout'), { code: '55P03' }))
          }
          return options.webhookReadFails === true
            ? Promise.reject(new Error('read failed'))
            : readsFor(options.noWebhooks === true ? [] : [{ id: 'webhook-1' }])
        }
      },
      pluginInstallation: {
        findMany: () => {
          installationReads += 1
          if (installationReads <= (options.transientInstallationReads ?? 0)) {
            return Promise.reject(Object.assign(new Error('lock timeout'), { code: '55P03' }))
          }
          return readsFor(
            options.installed === true
              ? [
                  {
                    id: 'installation-1',
                    scopes: [PluginScopes.ORDERS_READ],
                    plugin:
                      options.hiddenPlugin === true
                        ? null
                        : {
                            manifest: {
                              webhooks: { events: [Events.ORDER_CREATED], signatureHeader: 'X-Sig' }
                            }
                          }
                  }
                ]
              : []
          )
        }
      }
    }
  }
  const queue = {
    addBulk: (jobs: { name: string; data: Record<string, unknown> }[]) => {
      if (options.queueFails === true) return Promise.reject(new Error('redis down'))
      queuedOutside.push(open.getStore() === undefined)
      queued.push(jobs)
      return Promise.resolve()
    }
  }
  const logger = {
    setContext: () => undefined,
    error: (...args: unknown[]) => errors.push(args),
    warn: () => undefined
  }
  const dispatcher = new WebhookDispatcher(
    { onAny: () => undefined, offAny: () => undefined } as never,
    prisma as never,
    events as unknown as EventContext,
    queue as never,
    logger as unknown as PinoLogger,
    {
      inc: (labels: unknown, amount?: number) => lost.push({ labels, amount })
    } as never
  )
  return { dispatcher, opened, queued, queuedOutside, errors, lost, reads: () => webhookReads }
}

describe('WebhookDispatcher under row security', () => {
  it('reads the webhooks inside the context of the store of the event', async () => {
    const { dispatcher, opened, queued } = build()
    const count = await dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE, orderId: 'o1' })
    expect(count).toBe(1)
    // One context for the event, whatever the sides that read in it
    expect(opened).toEqual([STORE])
    expect(queued).toHaveLength(1)
  })

  it('queues the jobs outside of the context, so no connection waits for Redis', async () => {
    const { dispatcher, queuedOutside } = build()
    await dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE, orderId: 'o1' })
    expect(queuedOutside).toEqual([true])
  })

  it('says it, as an error, when an event of the catalog carries no store', async () => {
    const { dispatcher, opened, errors } = build()
    expect(await dispatcher.dispatch(Events.ORDER_CREATED, { orderId: 'o1' })).toBe(0)
    expect(await dispatcher.dispatch(Events.ORDER_CREATED, { storeId: 42 })).toBe(0)
    expect(opened).toEqual([])
    expect(errors).toHaveLength(2)
  })

  it('stays quiet about an event that is not in the catalog', async () => {
    const { dispatcher, opened, errors } = build()
    expect(await dispatcher.dispatch(Events.CHANNEL_DISCONNECTED, {})).toBe(0)
    expect(opened).toEqual([])
    expect(errors).toEqual([])
  })

  it('does nothing, without an error, for a store that no longer exists', async () => {
    const { dispatcher, queued, errors } = build({ goneStore: true })
    expect(await dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE })).toBe(0)
    expect(queued).toEqual([])
    expect(errors).toEqual([])
  })

  it('does not fail the event when the webhooks of the store could not be read', async () => {
    const { dispatcher, errors } = build({ webhookReadFails: true })
    await expect(dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE })).resolves.toBe(0)
    expect(errors).toHaveLength(1)
  })

  it('reads the installations of the plugins inside the context and queues their jobs outside', async () => {
    const { dispatcher, queued, queuedOutside } = build({ installed: true })
    // One job for the webhook of the store, one for the plugin
    expect(await dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE, orderId: 'o1' })).toBe(
      2
    )
    expect(queued).toHaveLength(2)
    expect(queuedOutside).toEqual([true, true])
  })

  it('keeps the plugin side when the webhooks of the store could not be read', async () => {
    const { dispatcher, errors } = build({ webhookReadFails: true, installed: true })
    expect(await dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE, orderId: 'o1' })).toBe(
      1
    )
    expect(errors).toHaveLength(1)
  })

  it('skips an installation whose plugin is hidden, says so, and keeps the rest', async () => {
    const { dispatcher, errors } = build({ installed: true, hiddenPlugin: true })
    expect(await dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE, orderId: 'o1' })).toBe(
      1
    )
    expect(errors).toHaveLength(1)
  })

  const dispatchToEnd = async (run: Promise<number>): Promise<number> => {
    await jest.runAllTimersAsync()
    return run
  }

  describe('a delivery that is lost leaves a trace to alert on', () => {
    beforeEach(() => jest.useFakeTimers())
    afterEach(() => jest.useRealTimers())

    it('counts an event that carries no store', async () => {
      const { dispatcher, lost } = build()
      await dispatcher.dispatch(Events.ORDER_CREATED, { orderId: 'o1' })
      expect(lost).toEqual([{ labels: { reason: WebhookDispatchLossReasons.NO_STORE }, amount: 1 }])
    })

    it('counts a read that failed for good, once, and does not retry what is not transient', async () => {
      const { dispatcher, lost, reads } = build({ webhookReadFails: true })
      expect(
        await dispatchToEnd(dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE }))
      ).toBe(0)
      expect(reads()).toBe(1)
      expect(lost.map(entry => entry.labels)).toEqual([
        { reason: WebhookDispatchLossReasons.READ_FAILED }
      ])
    })

    it('asks again after a lock timeout and delivers when the read then answers', async () => {
      const { dispatcher, lost, reads, queued } = build({ transientWebhookReads: 2 })
      expect(
        await dispatchToEnd(dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE }))
      ).toBe(1)
      expect(reads()).toBe(3)
      expect(queued).toHaveLength(1)
      expect(lost).toEqual([])
    })

    it('gives up after a bounded number of tries and counts the loss', async () => {
      const { dispatcher, lost, reads, errors } = build({ transientWebhookReads: 99 })
      expect(
        await dispatchToEnd(dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE }))
      ).toBe(0)
      expect(reads()).toBe(4)
      expect(lost.map(entry => entry.labels)).toEqual([
        { reason: WebhookDispatchLossReasons.READ_FAILED }
      ])
      expect(errors).toHaveLength(1)
    })

    it('does not count a store with no subscribers, nor a store that is gone', async () => {
      const gone = build({ goneStore: true })
      await gone.dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE })
      expect(gone.lost).toEqual([])
      const none = build({ noWebhooks: true })
      expect(await none.dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE })).toBe(0)
      expect(none.lost).toEqual([])
    })

    it('keeps the webhooks it read when the installations read keeps timing out, and counts that read', async () => {
      const { dispatcher, lost, queued, errors } = build({
        installed: true,
        transientInstallationReads: 99
      })
      expect(
        await dispatchToEnd(dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE }))
      ).toBe(1)
      expect(queued).toHaveLength(1)
      expect(lost.map(entry => entry.labels)).toEqual([
        { reason: WebhookDispatchLossReasons.READ_FAILED }
      ])
      expect(errors).toHaveLength(1)
    })

    it('counts the plugin jobs that could not be queued', async () => {
      const { dispatcher, lost } = build({ installed: true, noWebhooks: true, queueFails: true })
      expect(
        await dispatchToEnd(dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE }))
      ).toBe(0)
      expect(lost).toEqual([
        { labels: { reason: WebhookDispatchLossReasons.QUEUE_FAILED }, amount: 1 }
      ])
    })

    it('counts the jobs that could not be queued, one for each', async () => {
      const { dispatcher, lost } = build({ queueFails: true })
      expect(
        await dispatchToEnd(dispatcher.dispatch(Events.ORDER_CREATED, { storeId: STORE }))
      ).toBe(0)
      expect(lost).toEqual([
        { labels: { reason: WebhookDispatchLossReasons.QUEUE_FAILED }, amount: 1 }
      ])
    })
  })
})
