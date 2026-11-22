import { createHash } from 'node:crypto'

import { ZipFile } from 'yazl'

import { ComplianceConfig, DsrFailureCodes } from '@platform/core/compliance'
import type { PrismaTransaction } from '@platform/core/database'
import { AuthorType, MessageType } from '@platform/core/domain'

// What the export of an access or portability request holds (TDD_05 §10.1, Step 7.2-H2b-2): the data of the customers the request names, and
// nothing of anybody else. Every read is filtered by the store AND by the ids of the customers; the fields are named one by one (a `select`,
// never the whole row), so a column added to a table tomorrow is not exported by default. Left out on purpose, and said in the manifest: the
// notes and the caution mark of the team (an opinion of the store about a person, not data the person gave), the cost and the approvals of an
// order, the identity of the agent who wrote a reply, and the bytes of the files (listed by name).

export class DsrExportTooLargeError extends Error {
  readonly code = DsrFailureCodes.EXPORT_TOO_LARGE
  constructor() {
    super('the export is larger than one export may be')
  }
}

export interface DsrExportFile {
  name: string
  json: unknown
}
export interface DsrExportContent {
  files: DsrExportFile[]
  // How many records of each kind: the numbers the summary of the request keeps
  counts: Record<string, number>
}

// Fields that are not exported, in the words of the manifest (the person reads this)
export const DSR_EXPORT_EXCLUDED = [
  'internal notes and caution marks written by the team',
  'cost, approvals and internal notes of orders',
  'the identity of the team member who wrote a reply',
  'the files themselves (they are listed; ask the store for a copy)',
  'fiscal data kept under a legal obligation'
] as const

// A kind that has more rows than one export may hold is refused, not cut: a short export would pass for the whole of the data of the person
function within<T>(rows: T[]): T[] {
  if (rows.length > limit()) throw new DsrExportTooLargeError()
  return rows
}
// Read where it is used: the limit is a constant of the platform, and a spec that lowers it must reach this file too
const limit = (): number => ComplianceConfig.DSR_EXPORT_MAX_ROWS_PER_KIND

export async function collectDsrExport(
  tx: PrismaTransaction,
  storeId: string,
  customerIds: readonly string[]
): Promise<DsrExportContent> {
  const ids = [...customerIds]
  const customers = within(
    await tx.customer.findMany({
      where: { storeId, id: { in: ids } },
      orderBy: { id: 'asc' },
      take: limit() + 1,
      select: {
        id: true,
        name: true,
        email: true,
        phone: true,
        locale: true,
        createdAt: true,
        updatedAt: true
      }
    })
  )
  const identities = within(
    await tx.customerIdentity.findMany({
      where: { storeId, customerId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: {
        customerId: true,
        channelType: true,
        channelIdentity: true,
        displayName: true,
        username: true,
        createdAt: true
      }
    })
  )
  const addresses = within(
    await tx.address.findMany({
      where: { customerId: { in: ids }, customer: { storeId } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: {
        customerId: true,
        label: true,
        line1: true,
        line2: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        isDefault: true,
        createdAt: true
      }
    })
  )
  const consents = within(
    await tx.consentRecord.findMany({
      where: { storeId, customerId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: {
        customerId: true,
        purpose: true,
        legalBasis: true,
        granted: true,
        grantedAt: true,
        revokedAt: true,
        source: true,
        createdAt: true
      }
    })
  )
  const conversations = within(
    await tx.conversation.findMany({
      where: { storeId, customerId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: { id: true, customerId: true, channelType: true, status: true, createdAt: true }
    })
  )
  const messages =
    conversations.length === 0
      ? []
      : within(
          await tx.message.findMany({
            where: {
              storeId,
              conversationId: { in: conversations.map(conversation => conversation.id) },
              // What the store wrote to itself, and what was deleted or thrown away, is not the person's data
              type: { not: MessageType.INTERNAL_NOTE },
              deletedAt: null,
              discardedAt: null
            },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: limit() + 1,
            select: {
              conversationId: true,
              type: true,
              content: true,
              authorType: true,
              createdAt: true,
              editedAt: true
            }
          })
        )
  const orders = within(
    await tx.order.findMany({
      where: { storeId, customerId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: {
        customerId: true,
        orderNumber: true,
        status: true,
        subtotalCents: true,
        shippingCents: true,
        discountCents: true,
        totalCents: true,
        currency: true,
        paymentMethod: true,
        paymentStatus: true,
        shippingAddress: true,
        customerNotes: true,
        recipientPhones: true,
        trackingNumber: true,
        createdAt: true,
        items: {
          select: {
            productName: true,
            variantName: true,
            quantity: true,
            unitPriceCents: true
          }
        }
      }
    })
  )
  const files = within(
    await tx.media.findMany({
      where: { storeId, customerId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: {
        customerId: true,
        filename: true,
        contentType: true,
        fileSize: true,
        createdAt: true
      }
    })
  )

  const messagesOf = new Map<string, unknown[]>()
  for (const message of messages) {
    const list = messagesOf.get(message.conversationId) ?? []
    list.push({
      type: message.type,
      content: message.content,
      // Who wrote it, as the person sees it: themselves, or the store. Never which member of the team
      from: message.authorType === String(AuthorType.CUSTOMER) ? 'customer' : 'store',
      sentAt: message.createdAt,
      editedAt: message.editedAt
    })
    messagesOf.set(message.conversationId, list)
  }

  return {
    files: [
      { name: 'customers.json', json: customers },
      { name: 'channel-identities.json', json: identities },
      { name: 'addresses.json', json: addresses },
      { name: 'consents.json', json: consents },
      {
        name: 'conversations.json',
        json: conversations.map(({ id, ...rest }) => ({
          ...rest,
          messages: messagesOf.get(id) ?? []
        }))
      },
      { name: 'orders.json', json: orders },
      { name: 'files.json', json: files }
    ],
    counts: {
      customers: customers.length,
      conversations: conversations.length,
      messages: messages.length,
      orders: orders.length,
      addresses: addresses.length,
      consents: consents.length,
      files: files.length
    }
  }
}

// The files of the export as one ZIP, with a manifest that carries the SHA-256 of each (so a copy that was altered can be told). Built in memory
// and stopped at the byte limit: the rows are bounded above, and a ZIP that passes the limit is refused, never cut.
export async function zipDsrExport(
  content: DsrExportContent,
  meta: { type: string; generatedAt: Date }
): Promise<Buffer> {
  const entries = content.files.map(file => {
    const body = Buffer.from(`${JSON.stringify(file.json, null, 2)}\n`, 'utf8')
    return { name: file.name, body, sha256: createHash('sha256').update(body).digest('hex') }
  })
  // The text is bounded before it is compressed: a ZIP of a few small-looking files can inflate to more than the memory of the worker
  const total = entries.reduce((sum, entry) => sum + entry.body.length, 0)
  if (total > ComplianceConfig.DSR_EXPORT_MAX_BYTES) throw new DsrExportTooLargeError()
  const manifest = Buffer.from(
    `${JSON.stringify(
      {
        type: meta.type,
        generatedAt: meta.generatedAt.toISOString(),
        counts: content.counts,
        files: entries.map(entry => ({ name: entry.name, sha256: entry.sha256 })),
        notIncluded: DSR_EXPORT_EXCLUDED
      },
      null,
      2
    )}\n`,
    'utf8'
  )
  const zip = new ZipFile()
  const chunks: Buffer[] = []
  let size = 0
  const done = new Promise<Buffer>((resolve, reject) => {
    const output = zip.outputStream
    output.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > ComplianceConfig.DSR_EXPORT_MAX_BYTES) {
        reject(new DsrExportTooLargeError())
        output.removeAllListeners('data')
        return
      }
      chunks.push(chunk)
    })
    output.on('end', () => resolve(Buffer.concat(chunks)))
    output.on('error', reject)
  })
  for (const entry of entries) zip.addBuffer(entry.body, entry.name)
  zip.addBuffer(manifest, 'manifest.json')
  zip.end()
  return done
}
