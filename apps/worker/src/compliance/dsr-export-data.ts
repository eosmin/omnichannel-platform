import { ComplianceConfig, DsrFailureCodes } from '@platform/core/compliance'
import type { PrismaTransaction } from '@platform/core/database'
import { AuthorType, MediaStatus, MessageType } from '@platform/core/domain'
import { STORES_ROOT } from '@platform/core/storage'

// What the export of an access or portability request holds (TDD_05 §10.1, Step 7.2-H2b-2): the data of the customers the request names, and
// nothing of anybody else. Every read is filtered by the store AND by the ids of the customers; the fields are named one by one (a `select`,
// never the whole row), so a column added to a table tomorrow is not exported by default. Left out on purpose, and said in the manifest: the
// notes and the caution mark of the team (an opinion of the store about a person, not data the person gave), the cost and the approvals of an
// order and the identity of the agent who wrote a reply. The files the person sent (their bytes, streamed into the ZIP) and the fiscal data
// the store keeps about them (their tax record and the documents issued to them, opened for the person: it is theirs) are in the export; what
// of them is NOT is said in the manifest, never silently.

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
// A file of the person that goes into the ZIP as bytes: the name inside the ZIP, the key in the bucket (never written to the export) and the
// size the bucket reported for it
export interface DsrExportAttachment {
  entry: string
  key: string
  size: number
}
export interface DsrExportContent {
  files: DsrExportFile[]
  attachments: DsrExportAttachment[]
  // How many records of each kind: the numbers the summary of the request keeps
  counts: Record<string, number>
}

// Fields that are not exported, in the words of the manifest (the person reads this)
export const DSR_EXPORT_EXCLUDED = [
  'internal notes and caution marks written by the team',
  'cost, approvals and internal notes of orders',
  'the identity of the team member who wrote a reply',
  'files that were not scanned clean, or that the store no longer has (they are listed, with the reason)',
  'what the tax authority and the invoicing provider answered, the keys and the internal reasons of a fiscal document'
] as const

// The fields of the tax record of a customer and of the receiver of a fiscal document that go to the person, named one by one (a field the
// receiver gets tomorrow is not exported by default)
const FISCAL_TEXT_FIELDS = [
  'name',
  'taxId',
  'registrationId',
  'taxpayerType',
  'economicActivity',
  'documentType'
] as const

export interface DsrExportDeps {
  // The size of an object of the bucket, or null when it is not there
  head(key: string): Promise<{ contentLength: number } | null>
  // Opens a sealed value of the fiscal area (throws when it cannot be opened)
  open(sealed: Uint8Array): Record<string, unknown>
}

// The name of a file inside the ZIP: its number and its name cut down to letters, digits, dot, dash and underscore, so no path, no separator and
// no control character of a filename that came from outside reaches the archive
export function dsrFileEntryName(index: number, filename: string): string {
  const safe = filename.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80)
  return `files/${String(index).padStart(4, '0')}-${safe === '' ? 'file' : safe}`
}

function fiscalRecordOf(opened: Record<string, unknown>): Record<string, unknown> {
  const record: Record<string, unknown> = {}
  for (const field of FISCAL_TEXT_FIELDS) {
    const value = opened[field]
    if (typeof value === 'string' && value !== '') record[field] = value
  }
  const address = opened['address']
  if (typeof address === 'object' && address !== null && !Array.isArray(address)) {
    const parts: Record<string, string> = {}
    for (const [key, value] of Object.entries(address)) {
      if (typeof value === 'string' && value !== '') parts[key] = value
    }
    if (Object.keys(parts).length > 0) record['address'] = parts
  }
  return record
}

// The lines of a document as the person was invoiced them: the fields named one by one from the snapshot (it is JSON that came back as unknown)
function linesOf(snapshot: unknown): unknown[] {
  const lines = (snapshot as { lines?: unknown } | null)?.lines
  if (!Array.isArray(lines)) return []
  return lines.map(raw => {
    const line = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
    const pick = (key: string): string | number | null => {
      const value = line[key]
      return typeof value === 'string' || typeof value === 'number' ? value : null
    }
    return {
      description: pick('description'),
      quantity: pick('quantity'),
      unitPriceCents: pick('unitPriceCents'),
      taxRateBps: pick('taxRateBps'),
      taxCents: pick('taxCents'),
      totalCents: pick('totalCents')
    }
  })
}

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
  customerIds: readonly string[],
  deps: DsrExportDeps
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
              // Not the person's data: what the team wrote to itself, and the system lines (they can name a team member, like the export of
              // conversations leaves them out) and the order summaries
              type: {
                notIn: [MessageType.INTERNAL_NOTE, MessageType.SYSTEM, MessageType.ORDER_SUMMARY]
              },
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
        status: true,
        key: true,
        createdAt: true
      }
    })
  )
  const fiscalData = within(
    await tx.customerFiscalData.findMany({
      where: { storeId, customerId: { in: ids } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: { customerId: true, dataEncrypted: true, updatedAt: true }
    })
  )
  // The documents issued for the orders of these customers, of this store: the receiver is the person's own data (opened for them), what the
  // provider and the authority answered, the sealed payload and the internal reasons are not
  const fiscalDocuments = within(
    await tx.fiscalDocument.findMany({
      where: { storeId, order: { storeId, customerId: { in: ids } } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit() + 1,
      select: {
        kind: true,
        documentType: true,
        status: true,
        externalNumber: true,
        sequenceNumber: true,
        correlative: true,
        currency: true,
        totalCents: true,
        taxCents: true,
        issuedAt: true,
        voidedAt: true,
        createdAt: true,
        linesSnapshot: true,
        receiverEncrypted: true,
        order: { select: { customerId: true, orderNumber: true } }
      }
    })
  )

  // The files: only what the scan called clean, only from the folder of this store, and only while the bucket still has it. The rest is listed
  // with the reason, so the person sees that something exists and is not given what is unsafe or gone
  const folder = `${STORES_ROOT}${storeId}/`
  const attachments: DsrExportAttachment[] = []
  const fileRows: unknown[] = []
  for (const [index, file] of files.entries()) {
    const base = {
      customerId: file.customerId,
      filename: file.filename,
      contentType: file.contentType,
      fileSize: file.fileSize,
      createdAt: file.createdAt
    }
    if (file.status !== String(MediaStatus.CLEAN) || !file.key.startsWith(folder)) {
      fileRows.push({ ...base, included: false, reason: 'not_scanned_clean' })
      continue
    }
    if (attachments.length >= ComplianceConfig.DSR_EXPORT_MAX_FILES) {
      throw new DsrExportTooLargeError()
    }
    const head = await deps.head(file.key)
    if (head === null) {
      fileRows.push({ ...base, included: false, reason: 'not_available' })
      continue
    }
    const entry = dsrFileEntryName(index, file.filename)
    attachments.push({ entry, key: file.key, size: head.contentLength })
    fileRows.push({ ...base, included: true, entry })
  }
  if (
    attachments.reduce((sum, attachment) => sum + attachment.size, 0) >
    ComplianceConfig.DSR_EXPORT_MAX_ZIP_BYTES
  ) {
    throw new DsrExportTooLargeError()
  }

  // A sealed value that cannot be opened (a rotated key, a damaged row) is said, never skipped: the person is told that data exists
  let unreadable = 0
  const openRecord = (sealed: Uint8Array): Record<string, unknown> | null => {
    try {
      return fiscalRecordOf(deps.open(sealed))
    } catch {
      unreadable += 1
      return null
    }
  }
  const fiscalDataRows = fiscalData.map(row => {
    const record = openRecord(row.dataEncrypted)
    return {
      customerId: row.customerId,
      updatedAt: row.updatedAt,
      readable: record !== null,
      ...(record ?? {})
    }
  })
  const fiscalDocumentRows = fiscalDocuments.map(doc => {
    const receiver = openRecord(doc.receiverEncrypted)
    return {
      customerId: doc.order.customerId,
      orderNumber: doc.order.orderNumber,
      kind: doc.kind,
      documentType: doc.documentType,
      status: doc.status,
      number: doc.externalNumber,
      sequenceNumber: doc.sequenceNumber,
      correlative: doc.correlative,
      currency: doc.currency,
      totalCents: doc.totalCents,
      taxCents: doc.taxCents,
      issuedAt: doc.issuedAt,
      voidedAt: doc.voidedAt,
      createdAt: doc.createdAt,
      lines: linesOf(doc.linesSnapshot),
      receiverReadable: receiver !== null,
      receiver
    }
  })

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
      { name: 'files.json', json: fileRows },
      { name: 'fiscal-data.json', json: fiscalDataRows },
      { name: 'fiscal-documents.json', json: fiscalDocumentRows }
    ],
    attachments,
    counts: {
      customers: customers.length,
      conversations: conversations.length,
      messages: messages.length,
      orders: orders.length,
      addresses: addresses.length,
      consents: consents.length,
      files: files.length,
      filesIncluded: attachments.length,
      fiscalData: fiscalDataRows.length,
      fiscalDocuments: fiscalDocumentRows.length,
      fiscalUnreadable: unreadable
    }
  }
}
