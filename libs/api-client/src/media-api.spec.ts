import { TenantHeaders } from '@platform/core/auth'

import { createApiClient } from './api-client'
import { confirmUpload, fetchMediaUrls, requestUploadUrl } from './media-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(response: Response) {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(response.clone()))
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const file = { filename: 'a.png', contentType: 'image/png', fileSizeBytes: 12 }

describe('requestUploadUrl', () => {
  it('asks for a message upload in the store of the request', async () => {
    const { client, fetchImpl } = setup(
      json(200, { uploadUrl: 'https://files.example.com/x?sig=1', key: 'k', mediaId: 'm1' })
    )
    const result = await requestUploadUrl(client, 's1', file)
    expect(result.mediaId).toBe('m1')
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://api.example.com/api/v1/media/upload-url')
    expect(JSON.parse(init.body as string)).toEqual({ purpose: 'message', ...file })
    const headers = init.headers as Record<string, string>
    expect(headers[TenantHeaders.STORE_ID]).toBe('s1')
  })
})

describe('confirmUpload', () => {
  it('sends the key and the media id it was given', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        id: 'm1',
        filename: 'a.png',
        contentType: 'image/png',
        fileSize: 12,
        status: 'pending'
      })
    )
    const media = await confirmUpload(client, 's1', { ...file, mediaId: 'm1', key: 'k' })
    expect(media.status).toBe('pending')
    expect(
      JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string)
    ).toEqual({
      purpose: 'message',
      ...file,
      mediaId: 'm1',
      key: 'k'
    })
  })
})

describe('fetchMediaUrls', () => {
  it('reads the links of a file and keeps a missing variant as null', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        url: 'https://files.example.com/o',
        filename: 'a.pdf',
        contentType: 'application/pdf',
        variants: { full: null, medium: null, thumb: null }
      })
    )
    const urls = await fetchMediaUrls(client, 's1', 'm1')
    expect(urls.variants.thumb).toBeNull()
    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://api.example.com/api/v1/media/m1'
    )
  })
})
