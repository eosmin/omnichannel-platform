import { ComplianceConfig } from '@platform/core/compliance'
import type { PrismaTransaction } from '@platform/core/database'

import { collectDsrExport, DsrExportTooLargeError } from './dsr-export-data'

const STORE = 'store-1'
const SEALED = new Uint8Array([1, 2, 3])
type Args = { where: Record<string, unknown> }

// A transaction that answers each table from a list and remembers the filter it was asked with
function fakeTx(tables: Record<string, unknown[]>): {
  tx: PrismaTransaction
  asked: Record<string, Args>
} {
  const asked: Record<string, Args> = {}
  const tx = new Proxy(
    {},
    {
      get: (_target, table: string) => ({
        findMany: (args: Args) => {
          asked[table] = args
          return Promise.resolve(tables[table] ?? [])
        }
      })
    }
  ) as unknown as PrismaTransaction
  return { tx, asked }
}
const media = (over: Record<string, unknown>) => ({
  customerId: 'c1',
  filename: 'receipt.png',
  contentType: 'image/png',
  fileSize: 10,
  status: 'clean',
  key: `stores/${STORE}/messages/m1/receipt.png`,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  ...over
})
const deps = (present: Record<string, number>, opened: Record<string, unknown> | Error) => ({
  head: (key: string) =>
    Promise.resolve(present[key] === undefined ? null : { contentLength: present[key] }),
  open: () => {
    if (opened instanceof Error) throw opened
    return opened
  }
})

describe('the data of a data export: files and fiscal data', () => {
  it('asks for the files and the fiscal data by store AND by the customers of the request, nothing else', async () => {
    const { tx, asked } = fakeTx({})

    await collectDsrExport(tx, STORE, ['c1', 'c2'], deps({}, {}))

    expect(asked['media']?.where).toMatchObject({
      storeId: STORE,
      customerId: { in: ['c1', 'c2'] },
      purpose: 'message'
    })
    // The files of a note of the team, a system line, or a deleted or discarded message are not the person's data
    expect(JSON.stringify(asked['media']?.where)).toMatch(
      /"messageId":null.*"notIn":\["INTERNAL_NOTE","SYSTEM","ORDER_SUMMARY"\].*"deletedAt":null,"discardedAt":null/
    )
    expect(asked['customerFiscalData']?.where).toEqual({
      storeId: STORE,
      customerId: { in: ['c1', 'c2'] }
    })
    expect(asked['fiscalDocument']?.where).toEqual({
      storeId: STORE,
      order: { storeId: STORE, customerId: { in: ['c1', 'c2'] } }
    })
  })

  it('packs only the files that were scanned clean, from the folder of this store, that the bucket still has', async () => {
    const own = media({})
    const infected = media({
      filename: 'bad.exe',
      status: 'infected',
      key: `stores/${STORE}/messages/m2/bad.exe`
    })
    const pending = media({
      filename: 'new.png',
      status: 'pending',
      key: `stores/${STORE}/messages/m3/new.png`
    })
    const foreign = media({ filename: 'x.png', key: 'stores/other-store/messages/m4/x.png' })
    const gone = media({ filename: 'gone.png', key: `stores/${STORE}/messages/m5/gone.png` })
    const { tx } = fakeTx({ media: [own, infected, pending, foreign, gone] })

    const content = await collectDsrExport(
      tx,
      STORE,
      ['c1'],
      deps({ [own.key]: 2048, [infected.key]: 1, [pending.key]: 1, [foreign.key]: 1 }, {})
    )

    expect(content.attachments).toEqual([
      { entry: 'files/0000-receipt.png', key: own.key, size: 2048 }
    ])
    const listed = content.files.find(file => file.name === 'files.json')?.json as {
      filename: string
      included: boolean
      reason?: string
    }[]
    expect(listed.map(row => [row.filename, row.included, row.reason])).toEqual([
      ['receipt.png', true, undefined],
      ['bad.exe', false, 'not_scanned_clean'],
      ['new.png', false, 'not_scanned_clean'],
      ['x.png', false, 'outside_store'],
      ['gone.png', false, 'not_available']
    ])
    // The key of the bucket is never written into the export
    expect(JSON.stringify(content.files)).not.toContain('stores/')
    expect(content.counts).toMatchObject({ files: 5, filesIncluded: 1 })
  })

  it('refuses, and does not cut, an export with more files or more bytes than one export may hold', async () => {
    const one = media({})
    const { tx } = fakeTx({ media: [one] })
    const count = jest.replaceProperty(ComplianceConfig, 'DSR_EXPORT_MAX_FILES', 0 as never)
    await expect(
      collectDsrExport(tx, STORE, ['c1'], deps({ [one.key]: 1 }, {}))
    ).rejects.toBeInstanceOf(DsrExportTooLargeError)
    count.restore()

    const bytes = jest.replaceProperty(ComplianceConfig, 'DSR_EXPORT_MAX_ZIP_BYTES', 10)
    await expect(
      collectDsrExport(tx, STORE, ['c1'], deps({ [one.key]: 11 }, {}))
    ).rejects.toBeInstanceOf(DsrExportTooLargeError)
    bytes.restore()
  })

  it('gives the person their fiscal record opened, field by field, and nothing the provider or the authority holds', async () => {
    const { tx } = fakeTx({
      customerFiscalData: [{ customerId: 'c1', dataEncrypted: SEALED, updatedAt: new Date(0) }],
      fiscalDocument: [
        {
          kind: 'sale',
          documentType: 'invoice',
          status: 'accepted',
          externalNumber: 'N-1',
          sequenceNumber: 7,
          correlative: 7,
          currency: 'USD',
          totalCents: 1130,
          taxCents: 130,
          issuedAt: new Date(0),
          voidedAt: null,
          createdAt: new Date(0),
          linesSnapshot: {
            lines: [
              {
                description: 'Shirt',
                quantity: 1,
                unitPriceCents: 1000,
                taxCents: 130,
                totalCents: 1130,
                costCents: 400,
                internal: 'SECRET'
              }
            ]
          },
          receiverEncrypted: SEALED,
          order: { customerId: 'c1', orderNumber: 'ORD-1' }
        }
      ]
    })

    const content = await collectDsrExport(
      tx,
      STORE,
      ['c1'],
      deps(
        {},
        {
          name: 'Ana Perez',
          taxId: '0614-000000-000-0',
          address: { city: 'San Salvador', note: 42 },
          email: 'x@example.com',
          apiKey: 'SECRET-KEY',
          unknownFutureField: 'SECRET'
        }
      )
    )

    const text = JSON.stringify(content.files)
    expect(text).toContain('Ana Perez')
    expect(text).toContain('0614-000000-000-0')
    expect(text).toContain('San Salvador')
    expect(text).toContain('Shirt')
    expect(text).not.toContain('SECRET')
    expect(text).toContain('x@example.com')
    expect(text).toContain('shippingCents')
    expect(text).not.toContain('costCents')
    expect(content.counts).toMatchObject({ fiscalData: 1, fiscalDocuments: 1, fiscalUnreadable: 0 })
  })

  it('says that a sealed value could not be opened instead of leaving it out or failing the export', async () => {
    const { tx } = fakeTx({
      customerFiscalData: [{ customerId: 'c1', dataEncrypted: SEALED, updatedAt: new Date(0) }]
    })

    const content = await collectDsrExport(
      tx,
      STORE,
      ['c1'],
      deps({}, new Error('key_mismatch SECRET'))
    )

    const rows = content.files.find(file => file.name === 'fiscal-data.json')?.json as {
      readable: boolean
    }[]
    expect(rows).toHaveLength(1)
    expect(rows[0]?.readable).toBe(false)
    expect(JSON.stringify(content.files)).not.toContain('SECRET')
    expect(content.counts['fiscalUnreadable']).toBe(1)
  })
})
