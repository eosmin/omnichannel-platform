import { PDFDocument } from 'pdf-lib'

import { BulkLabelLeftOutReasons, MediaStatus, ShipmentStatus } from '@platform/core/domain'

import { MergedLabels } from './merged-labels.service'

async function pdfOf(height: number): Promise<Buffer> {
  const doc = await PDFDocument.create()
  doc.addPage([288, height])
  return Buffer.from(await doc.save())
}

interface Shipment {
  id: string
  status: string
  labelMediaId: string | null
}
interface Media {
  id: string
  key: string
  status: string
}

// The database and the bucket as lists: what is asked of them is what is tested, not how they answer
function build(shipments: Shipment[], media: Media[], files: Map<string, Buffer | Error>) {
  const created: Record<string, unknown>[] = []
  const stored = new Map<string, Buffer>()
  const prisma = {
    client: {
      shipment: {
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(shipments.filter(row => where.id.in.includes(row.id)))
        )
      },
      media: {
        findMany: jest.fn(({ where }: { where: { id: { in: string[] } } }) =>
          Promise.resolve(media.filter(row => where.id.in.includes(row.id)))
        ),
        create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
          created.push(data)
          return Promise.resolve(data)
        }),
        findFirst: jest.fn(() =>
          Promise.resolve({ key: 'k', filename: 'f.pdf', contentType: 'application/pdf' })
        )
      }
    }
  }
  const storage = {
    read: jest.fn((key: string) => {
      const file = files.get(key)
      if (file instanceof Error) return Promise.reject(file)
      return Promise.resolve(file ?? null)
    }),
    put: jest.fn((key: string, body: Buffer) => {
      stored.set(key, body)
      return Promise.resolve()
    }),
    delete: jest.fn(() => Promise.resolve()),
    downloadUrl: jest.fn(() => Promise.resolve('https://files.example/labels.pdf'))
  }
  const logger = { setContext: jest.fn(), warn: jest.fn() }
  const service = new MergedLabels(prisma as never, storage as never, logger as never)
  return { service, prisma, storage, created, stored, logger }
}

const OPTIONS = { requestedBy: 'user-1', waitForScan: false }

describe('MergedLabels.build', () => {
  it('merges the clean labels in the order asked and stores one file for the store', async () => {
    const files = new Map<string, Buffer | Error>([
      ['k1', await pdfOf(410)],
      ['k2', await pdfOf(420)]
    ])
    const { service, created, stored } = build(
      [
        { id: 's1', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm1' },
        { id: 's2', status: ShipmentStatus.DELIVERED, labelMediaId: 'm2' }
      ],
      [
        { id: 'm1', key: 'k1', status: MediaStatus.CLEAN },
        { id: 'm2', key: 'k2', status: MediaStatus.CLEAN }
      ],
      files
    )

    const outcome = await service.build('store-1', ['s2', 's1'], OPTIONS)

    expect(outcome.leftOut).toEqual([])
    expect(outcome.file?.merged).toEqual(['s2', 's1'])
    expect(outcome.file?.pageCount).toBe(2)
    expect(outcome.file?.mixedSizes).toBe(true)
    expect(created).toHaveLength(1)
    expect(created[0]).toMatchObject({
      storeId: 'store-1',
      purpose: 'bulk_labels',
      uploadedBy: 'user-1',
      status: MediaStatus.CLEAN,
      contentType: 'application/pdf'
    })
    const [key] = [...stored.keys()]
    expect(key).toMatch(/^stores\/store-1\/bulk-labels\/.+\/labels-\d{4}-\d{2}-\d{2}\.pdf$/)
    const pages = (await PDFDocument.load(stored.get(key ?? '') ?? new Uint8Array())).getPages()
    expect(pages.map(page => Math.round(page.getHeight()))).toEqual([420, 410])
  })

  it('names each label it leaves out with its reason, and stores nothing when none is left', async () => {
    const { service, created, stored } = build(
      [
        { id: 'voided', status: ShipmentStatus.CANCELLED, labelMediaId: 'm1' },
        { id: 'unsure', status: ShipmentStatus.REQUIRES_REVIEW, labelMediaId: 'm1' },
        { id: 'bare', status: ShipmentStatus.LABEL_CREATED, labelMediaId: null },
        { id: 'scanning', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm2' },
        { id: 'gone', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm3' },
        { id: 'broken', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm4' }
      ],
      [
        { id: 'm1', key: 'k1', status: MediaStatus.CLEAN },
        { id: 'm2', key: 'k2', status: MediaStatus.PENDING },
        { id: 'm3', key: 'k3', status: MediaStatus.CLEAN },
        { id: 'm4', key: 'k4', status: MediaStatus.CLEAN }
      ],
      new Map<string, Buffer | Error>([['k4', Buffer.from('%PDF-1.4 not a document')]])
    )

    const outcome = await service.build(
      'store-1',
      ['voided', 'unsure', 'bare', 'scanning', 'gone', 'broken', 'stranger'],
      OPTIONS
    )

    expect(outcome.file).toBeNull()
    expect(outcome.leftOut).toEqual(
      expect.arrayContaining([
        { shipmentId: 'voided', reason: BulkLabelLeftOutReasons.NOT_PRINTABLE },
        { shipmentId: 'unsure', reason: BulkLabelLeftOutReasons.NOT_PRINTABLE },
        { shipmentId: 'bare', reason: BulkLabelLeftOutReasons.NO_LABEL },
        { shipmentId: 'scanning', reason: BulkLabelLeftOutReasons.NOT_READY },
        { shipmentId: 'gone', reason: BulkLabelLeftOutReasons.NOT_READY },
        { shipmentId: 'broken', reason: BulkLabelLeftOutReasons.UNREADABLE },
        { shipmentId: 'stranger', reason: BulkLabelLeftOutReasons.NOT_FOUND }
      ])
    )
    expect(outcome.leftOut).toHaveLength(7)
    expect(created).toHaveLength(0)
    expect(stored.size).toBe(0)
  })

  it('treats a file the bucket cannot read as not ready, and says so in the log', async () => {
    const { service, logger } = build(
      [{ id: 's1', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm1' }],
      [{ id: 'm1', key: 'k1', status: MediaStatus.CLEAN }],
      new Map<string, Buffer | Error>([['k1', new Error('the bucket is down')]])
    )

    const outcome = await service.build('store-1', ['s1'], OPTIONS)

    expect(outcome.leftOut).toEqual([
      { shipmentId: 's1', reason: BulkLabelLeftOutReasons.NOT_READY }
    ])
    expect(logger.warn).toHaveBeenCalled()
  })

  it('waits for the scan of a label when asked, and merges it once it is clean', async () => {
    const files = new Map<string, Buffer | Error>([['k1', await pdfOf(410)]])
    const media: Media[] = [{ id: 'm1', key: 'k1', status: MediaStatus.PENDING }]
    const { service, prisma } = build(
      [{ id: 's1', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm1' }],
      media,
      files
    )
    // The scan finishes between the second and the third look
    let looks = 0
    prisma.client.media.findMany.mockImplementation(() => {
      looks += 1
      if (looks >= 2 && media[0] !== undefined) media[0].status = MediaStatus.CLEAN
      return Promise.resolve(media)
    })

    const outcome = await service.build('store-1', ['s1'], {
      requestedBy: null,
      waitForScan: true,
      scanWaitMs: 2000,
      scanPollMs: 5
    })

    expect(outcome.file?.merged).toEqual(['s1'])
    expect(looks).toBe(2)
  })

  it('gives up waiting for a scan at the limit and reports the label as not ready', async () => {
    const { service } = build(
      [{ id: 's1', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm1' }],
      [{ id: 'm1', key: 'k1', status: MediaStatus.PENDING }],
      new Map()
    )

    const outcome = await service.build('store-1', ['s1'], {
      requestedBy: null,
      waitForScan: true,
      scanWaitMs: 30,
      scanPollMs: 10
    })

    expect(outcome.leftOut).toEqual([
      { shipmentId: 's1', reason: BulkLabelLeftOutReasons.NOT_READY }
    ])
  })

  it('removes the object again when its row cannot be written', async () => {
    const files = new Map<string, Buffer | Error>([['k1', await pdfOf(410)]])
    const { service, prisma, storage } = build(
      [{ id: 's1', status: ShipmentStatus.LABEL_CREATED, labelMediaId: 'm1' }],
      [{ id: 'm1', key: 'k1', status: MediaStatus.CLEAN }],
      files
    )
    prisma.client.media.create.mockRejectedValueOnce(new Error('the database is down'))

    await expect(service.build('store-1', ['s1'], OPTIONS)).rejects.toThrow('the database is down')

    expect(storage.delete).toHaveBeenCalledTimes(1)
  })
})

describe('MergedLabels.download', () => {
  it('gives a short link to a clean merged file of the store, and nothing when there is none', async () => {
    const { service, prisma } = build([], [], new Map())

    await expect(service.download('store-1', 'm1')).resolves.toEqual({
      url: 'https://files.example/labels.pdf',
      filename: 'f.pdf'
    })
    const asked = prisma.client.media.findFirst.mock.calls[0] as unknown as [
      { where: Record<string, unknown> }
    ]
    expect(asked[0].where).toMatchObject({ id: 'm1', storeId: 'store-1', purpose: 'bulk_labels' })

    prisma.client.media.findFirst.mockResolvedValueOnce(null as never)
    await expect(service.download('store-1', 'm2')).resolves.toBeNull()
  })
})
