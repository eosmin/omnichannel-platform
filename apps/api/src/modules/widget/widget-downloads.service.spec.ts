import type { PrismaService } from '@platform/core/database'
import { ErrorCodes } from '@platform/core/errors'

import type { MediaService } from '../media/media.service'

import { WidgetDownloads } from './widget-downloads.service'
import type { WidgetSite } from './widget-sites.service'
import type { WidgetTenant } from './widget-tenant'

const site = {
  siteKey: 'pk_widget_AAAAAAAAAAAAAAAAAAAAAAAA',
  storeId: 'store-1',
  connectionId: 'conn-1'
} as WidgetSite
const visitor = '3f2c1a9e-4b7d-4c1e-9a55-0d1e2f3a4b5c'

function build(
  row: { id: string; contentType: string; scanResult: unknown; authorType?: string } | null
) {
  const findFirst = jest
    .fn()
    .mockResolvedValue(row && { ...row, message: { authorType: row.authorType ?? 'agent' } })
  const urlsFor = jest.fn().mockResolvedValue({
    url: 'https://bucket.test/get',
    filename: 'a.bin',
    contentType: row?.contentType ?? '',
    variants: { medium: null }
  })
  const downloads = new WidgetDownloads(
    { client: { media: { findFirst } } } as unknown as PrismaService,
    { urlsFor } as unknown as MediaService,
    { run: (_site: unknown, work: () => Promise<unknown>) => work() } as unknown as WidgetTenant
  )
  return { downloads, urlsFor }
}

describe('WidgetDownloads', () => {
  it('signs a picture that is clean', async () => {
    const { downloads, urlsFor } = build({ id: 'm1', contentType: 'image/png', scanResult: null })

    await expect(downloads.linkFor(site, visitor, 'm1')).resolves.toMatchObject({
      url: 'https://bucket.test/get'
    })
    expect(urlsFor).toHaveBeenCalledTimes(1)
  })

  it('signs a video that carries the mark of the cleaning', async () => {
    const { downloads } = build({
      id: 'm1',
      contentType: 'video/mp4',
      scanResult: { sanitized: true }
    })

    await expect(downloads.linkFor(site, visitor, 'm1')).resolves.toBeDefined()
  })

  it.each([
    ['kept with its metadata', { avCleaning: 'untouched' }],
    ['not reached by the cleaning', null],
    ['marked by the scan only', { viruses: [] }]
  ])('answers not found, and signs nothing, for a video %s', async (_name, scanResult) => {
    const { downloads, urlsFor } = build({ id: 'm1', contentType: 'video/mp4', scanResult })

    await expect(downloads.linkFor(site, visitor, 'm1')).rejects.toMatchObject({
      code: ErrorCodes.RESOURCE_NOT_FOUND
    })
    expect(urlsFor).not.toHaveBeenCalled()
  })

  it('gives back to the visitor a video they sent themselves, whatever its mark', async () => {
    const { downloads } = build({
      id: 'm1',
      contentType: 'video/mp4',
      scanResult: { avCleaning: 'untouched' },
      authorType: 'customer'
    })

    await expect(downloads.linkFor(site, visitor, 'm1')).resolves.toBeDefined()
  })

  it('answers not found for a file the query did not find', async () => {
    const { downloads, urlsFor } = build(null)

    await expect(downloads.linkFor(site, visitor, 'm1')).rejects.toMatchObject({
      code: ErrorCodes.RESOURCE_NOT_FOUND
    })
    expect(urlsFor).not.toHaveBeenCalled()
  })
})
