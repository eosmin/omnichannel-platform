import { createApiClient } from '@platform/api-client'
import { TenantHeaders } from '@platform/core/auth'

import { confirmAvatarUpload, requestAvatarUploadUrl } from './avatar-requests'

function setup(body: unknown, status = 200) {
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() =>
    Promise.resolve(
      status === 204
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' }
          })
    )
  )
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

describe('the picture of the person', () => {
  const file = { filename: 'me.png', contentType: 'image/png', fileSizeBytes: 10 }

  it('asks for the url and confirms on routes with no store and no purpose in the body', async () => {
    const { client, fetchImpl } = setup({
      uploadUrl: 'https://bucket.example.com/x',
      key: 'users/u/avatar-uploads/m/me.png',
      mediaId: 'm'
    })
    await requestAvatarUploadUrl(client, file)
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/account/avatar/upload-url')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(init?.body as string)).toEqual(file)
    expect((init?.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBeUndefined()
  })

  it('confirms the file it uploaded', async () => {
    const { client, fetchImpl } = setup({ mediaId: 'm', status: 'pending' })
    await expect(confirmAvatarUpload(client, { ...file, mediaId: 'm', key: 'k' })).resolves.toEqual(
      { mediaId: 'm', status: 'pending' }
    )
    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/account/avatar/confirm')
    expect((init?.headers as Record<string, string>)[TenantHeaders.STORE_ID]).toBeUndefined()
  })
})
