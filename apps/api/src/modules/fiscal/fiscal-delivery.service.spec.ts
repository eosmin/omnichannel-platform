import type { PinoLogger } from 'nestjs-pino'

import {
  ConversationStatus,
  FiscalDeliveryReason,
  FiscalDeliveryRoute,
  FiscalDeliveryStatus,
  FiscalDocumentStatus,
  FiscalEvidenceKind,
  MediaStatus,
  MessageType
} from '@platform/core/domain'
import { Events } from '@platform/core/events'

import { FiscalDeliveryOutcome, FiscalDeliveryService } from './fiscal-delivery.service'

let mockConversationStatus = 'open'

// These pull the env of the platform with them: the service only needs their names
jest.mock('@platform/core/audit-module', () => ({ AuditService: class {} }))
jest.mock('@platform/core/storage-module', () => ({ StorageService: class {} }))
jest.mock('@platform/plugins/runtime', () => ({ PluginRegistry: class {} }))
jest.mock('@platform/fiscal/runtime', () => ({
  FiscalEvidenceService: class {},
  FiscalProviderRegistry: class {}
}))
jest.mock('../order-messages/order-messages.service', () => ({ OrderMessagesService: class {} }))
jest.mock('@platform/core/messaging', () => ({
  ConversationsService: class {},
  OutboundQueue: class {},
  isHiddenStatus: () => false,
  lockConversationForWrite: () =>
    Promise.resolve({ status: mockConversationStatus, assignedTo: null })
}))

const ORG = 'org-1'
const STORE = 'store-1'
const DOCUMENT = 'doc-1'
const INPUT = { organizationId: ORG, storeId: STORE, documentId: DOCUMENT }

interface Options {
  status?: string
  delivered?: boolean
  email?: string | null
  erasedAt?: Date | null
  // What the channel of the customer is, by what it declares
  channel?: { windowOpen: boolean; documents: boolean; types?: string[] | null; maxBytes?: number }
  made?: (FiscalEvidenceKind | null)[]
  sizes?: number[]
  mediaStatus?: string
  bucketHas?: boolean
  noRepresent?: boolean
  failSecondCopy?: boolean
  // The transaction of the channel throws; `rowWritten`: its commit had happened (the rows of the files exist)
  txFails?: boolean
  rowWritten?: boolean
}

function build(options: Options = {}) {
  const created: Record<string, unknown>[] = []
  const messages: Record<string, unknown>[] = []
  const published: { event: string; payload: unknown }[] = []
  const emails: { data: Record<string, unknown>; options: Record<string, unknown> }[] = []
  const audit: Record<string, unknown>[] = []
  const copies: string[] = []
  const objects = new Set<string>()
  const mediaKeys: string[] = []
  const deleted: string[] = []
  const sizes = options.sizes ?? [1000, 2000]
  const tx = {
    fiscalDelivery: {
      createMany: ({ data }: { data: Record<string, unknown>[] }) => {
        if (options.delivered === true || created.length > 0) return Promise.resolve({ count: 0 })
        created.push(...data)
        return Promise.resolve({ count: data.length })
      }
    },
    message: {
      create: ({ data }: { data: Record<string, unknown> }) => {
        messages.push(data)
        return Promise.resolve({ id: `message-${messages.length}` })
      }
    },
    media: {
      create: ({ data }: { data: { key: string } }) => {
        mediaKeys.push(data.key)
        return Promise.resolve({})
      }
    }
  }
  const prisma = {
    client: {
      fiscalDocument: {
        findFirst: () =>
          Promise.resolve({
            status: options.status ?? FiscalDocumentStatus.ACCEPTED,
            storeId: STORE,
            orderId: 'order-1',
            providerId: 'provider-1',
            delivery:
              options.delivered === true || created.length > 0 ? { id: 'delivery-1' } : null,
            order: {
              orderNumber: '1001',
              conversationId: 'conversation-1',
              customerId: 'customer-1',
              store: { name: 'Shop', defaultLocale: 'es' },
              customer: {
                email: options.email === undefined ? 'client@example.invalid' : options.email,
                locale: 'es',
                erasedAt: options.erasedAt ?? null
              }
            }
          })
      },
      media: {
        findMany: ({ where }: { where: { id?: unknown } }) => {
          if (where.id !== undefined) {
            return Promise.resolve(
              options.rowWritten === true
                ? copies.map(key => ({ id: /[0-9a-f-]{36}/.exec(key)?.[0] ?? '' }))
                : []
            )
          }
          return Promise.resolve([
            {
              fiscalEvidenceKind: FiscalEvidenceKind.REPRESENTATION,
              key: 'k-pdf',
              filename: 'dte.pdf',
              contentType: 'application/pdf',
              fileSize: sizes[0],
              status: options.mediaStatus ?? MediaStatus.CLEAN
            },
            {
              fiscalEvidenceKind: FiscalEvidenceKind.DTE_FILE,
              key: 'k-json',
              filename: 'dte.json',
              contentType: 'application/json',
              fileSize: sizes[1],
              status: options.mediaStatus ?? MediaStatus.CLEAN
            }
          ])
        }
      }
    },
    transaction: <T>(work: (tx: unknown) => Promise<T>) =>
      options.txFails === true && messages.length === 0 && created.length === 0
        ? Promise.reject(new Error('connection reset'))
        : work(tx),
    afterCommit: (_tx: unknown, run: () => void) => run()
  }
  const channel = options.channel
  const service = new FiscalDeliveryService(
    prisma as never,
    { inOrganization: (_id: string, work: () => Promise<unknown>) => work() } as never,
    { log: (entry: Record<string, unknown>) => audit.push(entry) } as never,
    {
      publish: (_tx: unknown, event: string, payload: unknown) => published.push({ event, payload })
    } as never,
    {
      keep: (_org: string, _doc: string, kind: FiscalEvidenceKind) => {
        const index = [FiscalEvidenceKind.REPRESENTATION, FiscalEvidenceKind.DTE_FILE].indexOf(kind)
        const made = options.made ?? [
          FiscalEvidenceKind.REPRESENTATION,
          FiscalEvidenceKind.DTE_FILE
        ]
        return Promise.resolve(made[index] === null ? null : { mediaId: `media-${index}` })
      }
    } as never,
    { find: () => (options.noRepresent === true ? {} : { represent: () => null }) } as never,
    {
      channelFor: () =>
        Promise.resolve(
          channel === undefined
            ? null
            : {
                conversationId: 'conversation-1',
                pluginId: 'plugin-x',
                channel: { hasWindow: true, windowOpen: channel.windowOpen, takesTemplates: false },
                textMaxLength: null
              }
        )
    } as never,
    { recordMessageAt: () => Promise.resolve() } as never,
    {
      hasCapability: () => channel?.documents === true,
      mediaOf: () =>
        channel === undefined
          ? null
          : {
              maxFilesPerMessage: 1,
              kinds: {
                document: {
                  types: channel.types === undefined ? null : channel.types,
                  maxBytes: channel.maxBytes ?? 10_000_000
                }
              }
            },
      capabilitiesOf: () => [],
      limitsOf: () => null
    } as never,
    { enqueue: () => Promise.resolve() } as never,
    {
      copy: (_from: string, to: string) => {
        copies.push(to)
        if (options.failSecondCopy === true && copies.length === 2) {
          return Promise.reject(new Error('bucket down'))
        }
        objects.add(to)
        return Promise.resolve(options.bucketHas !== false)
      },
      read: () => Promise.resolve(options.bucketHas === false ? null : Buffer.from('bytes')),
      delete: (key: string) => {
        deleted.push(key)
        objects.delete(key)
        return Promise.resolve()
      }
    } as never,
    {
      add: (_name: string, data: Record<string, unknown>, jobOptions: Record<string, unknown>) => {
        emails.push({ data, options: jobOptions })
        return Promise.resolve({})
      }
    } as never,
    {
      setContext: () => undefined,
      error: () => undefined,
      warn: () => undefined
    } as unknown as PinoLogger
  )
  return {
    service,
    created,
    messages,
    published,
    emails,
    audit,
    copies,
    deleted,
    objects,
    mediaKeys
  }
}

describe('FiscalDeliveryService', () => {
  describe('when nothing is owed', () => {
    it('skips a document that is not accepted any more', async () => {
      const { service, created } = build({ status: FiscalDocumentStatus.VOIDED })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SKIPPED)
      expect(created).toEqual([])
    })

    it('skips a document that belongs to another store than the event names', async () => {
      const { service, created, emails } = build()
      expect(await service.deliver({ ...INPUT, storeId: 'store-2' })).toBe(
        FiscalDeliveryOutcome.SKIPPED
      )
      expect(created).toEqual([])
      expect(emails).toEqual([])
    })

    it('answers duplicate for a document that was delivered already', async () => {
      const { service, created, emails } = build({ delivered: true })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.DUPLICATE)
      expect(created).toEqual([])
      expect(emails).toEqual([])
    })

    it('records a provider that draws files and made none, so a person is told', async () => {
      const { service, created, published } = build({ made: [null, null] })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.NOT_SENT)
      expect(created).toMatchObject([{ reason: FiscalDeliveryReason.FILES_UNAVAILABLE }])
      expect(published).toHaveLength(1)
    })

    it('skips a provider that draws no files', async () => {
      const { service, created } = build({ made: [null, null], noRepresent: true })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SKIPPED)
      expect(created).toEqual([])
    })

    it('records a customer who was erased without alerting anyone', async () => {
      const { service, created, published } = build({ erasedAt: new Date() })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.NOT_SENT)
      expect(created).toMatchObject([
        { status: FiscalDeliveryStatus.NOT_SENT, reason: FiscalDeliveryReason.CUSTOMER_ERASED }
      ])
      expect(published).toEqual([])
    })
  })

  describe('through the channel of the customer', () => {
    const open = { windowOpen: true, documents: true }

    it('sends the two files as two documents of the conversation and writes one row', async () => {
      const { service, created, messages, emails, copies } = build({ channel: open })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SENT)
      expect(messages).toHaveLength(2)
      expect(messages.every(message => message['type'] === MessageType.DOCUMENT)).toBe(true)
      expect(copies).toHaveLength(2)
      expect(emails).toEqual([])
      expect(created).toMatchObject([
        { status: FiscalDeliveryStatus.SENT, route: FiscalDeliveryRoute.CHANNEL, reason: null }
      ])
    })

    it('goes by email when the channel does not take documents', async () => {
      const { service, messages, emails, created } = build({
        channel: { windowOpen: true, documents: false }
      })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SENT)
      expect(messages).toEqual([])
      expect(emails).toHaveLength(1)
      expect(created).toMatchObject([{ route: FiscalDeliveryRoute.EMAIL }])
    })

    it('goes by email when the channel does not take the type of one of the files', async () => {
      const { service, messages, emails } = build({
        channel: { ...open, types: ['application/pdf'] }
      })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SENT)
      expect(messages).toEqual([])
      expect(emails).toHaveLength(1)
    })

    it('goes by email when a file is larger than the channel takes', async () => {
      const { service, messages, emails } = build({ channel: { ...open, maxBytes: 1500 } })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SENT)
      expect(messages).toEqual([])
      expect(emails).toHaveLength(1)
    })

    it('goes by email when the window of the channel is closed', async () => {
      const { service, messages, emails } = build({ channel: { ...open, windowOpen: false } })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SENT)
      expect(messages).toEqual([])
      expect(emails).toHaveLength(1)
    })

    it('keeps the objects of the try that won when two tries of one document run at once', async () => {
      const { service, objects, mediaKeys, messages, created } = build({ channel: open })
      const outcomes = await Promise.all([service.deliver(INPUT), service.deliver(INPUT)])
      expect([...outcomes].sort()).toEqual(
        [FiscalDeliveryOutcome.DUPLICATE, FiscalDeliveryOutcome.SENT].sort()
      )
      expect(created).toHaveLength(1)
      expect(messages).toHaveLength(2)
      expect(mediaKeys).toHaveLength(2)
      // Every file a queued message reads is still in the bucket
      for (const key of mediaKeys) expect(objects.has(key)).toBe(true)
    })

    it('removes the first copy when the bucket fails on the second, before the listener asks again', async () => {
      const { service, objects, copies } = build({ channel: open, failSecondCopy: true })
      await expect(service.deliver(INPUT)).rejects.toThrow('bucket down')
      expect(copies).toHaveLength(2)
      expect(objects.size).toBe(0)
    })

    it('removes the copies when the transaction fails and no row of a file exists', async () => {
      const { service, objects, copies } = build({ channel: open, txFails: true })
      await expect(service.deliver(INPUT)).rejects.toThrow('connection reset')
      expect(copies).toHaveLength(2)
      expect(objects.size).toBe(0)
    })

    it('keeps the copies when the transaction fails but its rows exist (the commit was uncertain)', async () => {
      const { service, objects, copies } = build({
        channel: open,
        txFails: true,
        rowWritten: true
      })
      await expect(service.deliver(INPUT)).rejects.toThrow('connection reset')
      expect(copies).toHaveLength(2)
      expect(objects.size).toBe(2)
    })

    it('removes its own copies, and writes nothing, when the conversation was hidden meanwhile', async () => {
      mockConversationStatus = ConversationStatus.SPAM
      try {
        const { service, objects, copies, deleted, created, messages } = build({
          channel: open,
          email: null
        })
        expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.NOT_SENT)
        expect(messages).toEqual([])
        expect(copies).toHaveLength(2)
        expect(deleted.sort()).toEqual([...copies].sort())
        expect(objects.size).toBe(0)
        expect(created).toMatchObject([{ reason: FiscalDeliveryReason.NO_CHANNEL }])
      } finally {
        mockConversationStatus = 'open'
      }
    })

    it('answers duplicate and writes no message when the document was delivered already', async () => {
      const { service, messages, deleted } = build({ channel: open, delivered: true })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.DUPLICATE)
      expect(messages).toEqual([])
      expect(deleted).toEqual([])
    })
  })

  describe('by email', () => {
    it('attaches both files with the fixed text, no template of the store and no advertising', async () => {
      const { service, emails, created, audit } = build()
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.SENT)
      expect(emails).toHaveLength(1)
      const [{ data, options }] = emails as [
        { data: Record<string, unknown>; options: Record<string, unknown> }
      ]
      expect(data['to']).toBe('client@example.invalid')
      expect(data['template']).toBe('order-message')
      expect((data['attachments'] as { filename: string }[]).map(a => a.filename)).toEqual([
        'dte.pdf',
        'dte.json'
      ])
      expect((data['data'] as { text: string }).text).toContain('1001')
      expect(options['jobId']).toBe(`fiscal-delivery-${DOCUMENT}`)
      expect(created).toMatchObject([{ route: FiscalDeliveryRoute.EMAIL, status: 'sent' }])
      expect(audit).toMatchObject([
        { action: 'fiscal.delivery_sent', metadata: { route: 'email' } }
      ])
    })

    it('is not sent when the files are larger than an email carries', async () => {
      const { service, emails, created, published } = build({ sizes: [6_000_000, 6_000_000] })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.NOT_SENT)
      expect(emails).toEqual([])
      expect(created).toMatchObject([{ reason: FiscalDeliveryReason.TOO_LARGE, route: 'none' }])
      expect(published).toHaveLength(1)
    })
  })

  describe('when nothing can carry the files', () => {
    it('records why and tells the people who manage the fiscal documents, once', async () => {
      const { service, created, published, audit } = build({ email: null })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.NOT_SENT)
      expect(created).toMatchObject([
        { status: 'not_sent', route: 'none', reason: FiscalDeliveryReason.NO_CHANNEL }
      ])
      expect(published).toEqual([
        {
          event: Events.FISCAL_DELIVERY_NOT_SENT,
          payload: {
            organizationId: ORG,
            storeId: STORE,
            documentId: DOCUMENT,
            orderId: 'order-1',
            reason: FiscalDeliveryReason.NO_CHANNEL
          }
        }
      ])
      expect(audit).toMatchObject([{ action: 'fiscal.delivery_not_sent' }])
    })

    it('never gives an infected or unscannable file', async () => {
      for (const mediaStatus of [MediaStatus.INFECTED, MediaStatus.UNSCANNABLE]) {
        const { service, emails, created } = build({ mediaStatus })
        expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.NOT_SENT)
        expect(emails).toEqual([])
        expect(created).toMatchObject([{ reason: FiscalDeliveryReason.FILES_UNAVAILABLE }])
      }
    })

    it('records a file that is not in the bucket instead of losing the delivery', async () => {
      const { service, created } = build({ bucketHas: false })
      expect(await service.deliver(INPUT)).toBe(FiscalDeliveryOutcome.NOT_SENT)
      expect(created).toMatchObject([{ reason: FiscalDeliveryReason.FILES_UNAVAILABLE }])
    })
  })

  describe('recordFailure', () => {
    it('records a delivery that could not be tried, so the person is told', async () => {
      const { service, created, published } = build()
      await service.recordFailure(INPUT)
      expect(created).toMatchObject([{ reason: FiscalDeliveryReason.FILES_UNAVAILABLE }])
      expect(published).toHaveLength(1)
    })

    it('does nothing for a document that was delivered', async () => {
      const { service, created } = build({ delivered: true })
      await service.recordFailure(INPUT)
      expect(created).toEqual([])
    })
  })
})
