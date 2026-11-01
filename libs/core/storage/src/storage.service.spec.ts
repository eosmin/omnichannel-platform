import { Readable } from 'node:stream'

import type { S3Client } from '@aws-sdk/client-s3'

import { createS3Client } from './storage.module'
import { StorageService } from './storage.service'

const failure = (status: number) =>
  Object.assign(new Error('s3'), { $metadata: { httpStatusCode: status } })

function serviceWith(send: jest.Mock): StorageService {
  return new StorageService({ send, destroy: jest.fn() } as unknown as S3Client, 'bucket')
}

describe('StorageService', () => {
  describe('head', () => {
    it('describes the object, with the ETag that identifies its bytes', async () => {
      const send = jest
        .fn()
        .mockResolvedValue({ ContentLength: 7, ContentType: 'image/png', ETag: '"abc"' })
      expect(await serviceWith(send).head('k')).toEqual({
        contentLength: 7,
        contentType: 'image/png',
        etag: '"abc"'
      })
    })

    it('answers null for a missing object only', async () => {
      expect(await serviceWith(jest.fn().mockRejectedValue(failure(404))).head('k')).toBeNull()
    })

    it.each([403, 500])('throws a %i: it is not a missing object', async status => {
      await expect(
        serviceWith(jest.fn().mockRejectedValue(failure(status))).head('k')
      ).rejects.toThrow()
    })
  })

  describe('copy', () => {
    it('copies pinned to the ETag it was given, with the key encoded', async () => {
      const send = jest.fn().mockResolvedValue({})
      expect(
        await serviceWith(send).copy(
          'stores/s/uploads/m/a b.png',
          'stores/s/messages/m/a b.png',
          '"abc"'
        )
      ).toBe(true)
      const input = (send.mock.calls[0] as [{ input: Record<string, string> }])[0].input
      expect(input['CopySource']).toBe('bucket/stores/s/uploads/m/a%20b.png')
      expect(input['CopySourceIfMatch']).toBe('"abc"')
      expect(input['Key']).toBe('stores/s/messages/m/a b.png')
    })

    it('answers false when the source is no longer the object that was checked (412)', async () => {
      expect(
        await serviceWith(jest.fn().mockRejectedValue(failure(412))).copy('a', 'b', '"x"')
      ).toBe(false)
    })

    it('throws any other failure', async () => {
      await expect(
        serviceWith(jest.fn().mockRejectedValue(failure(500))).copy('a', 'b')
      ).rejects.toThrow()
    })
  })

  it('copies without a precondition when no ETag is given', async () => {
    const send = jest.fn().mockResolvedValue({})
    await serviceWith(send).copy('a', 'b')
    const input = (send.mock.calls[0] as [{ input: Record<string, unknown> }])[0].input
    expect(input).not.toHaveProperty('CopySourceIfMatch')
  })

  it('deletes the key it is given', async () => {
    const send = jest.fn().mockResolvedValue({})
    await serviceWith(send).delete('stores/s/uploads/m/a.png')
    const input = (send.mock.calls[0] as [{ input: Record<string, unknown> }])[0].input
    expect(input).toEqual({ Bucket: 'bucket', Key: 'stores/s/uploads/m/a.png' })
  })

  it('asks the bucket with a request that is cut when the time is up', async () => {
    const send = jest.fn().mockResolvedValue({})
    await serviceWith(send).checkBucket(1500)
    const [command, options] = send.mock.calls[0] as [
      { input: Record<string, unknown> },
      { abortSignal: AbortSignal }
    ]
    expect(command.input).toEqual({ Bucket: 'bucket' })
    expect(options.abortSignal).toBeInstanceOf(AbortSignal)
  })

  it('destroys the client when the app shuts down', () => {
    const destroy = jest.fn()
    new StorageService(
      { send: jest.fn(), destroy } as unknown as S3Client,
      'bucket'
    ).onApplicationShutdown()
    expect(destroy).toHaveBeenCalledTimes(1)
  })

  describe('uploadUrl', () => {
    const storage = new StorageService(
      createS3Client({
        bucket: 'bucket',
        region: 'us-east-1',
        accessKeyId: 'id',
        secretAccessKey: 'secret',
        endpoint: 'http://localhost:8333',
        forcePathStyle: true
      }),
      'bucket'
    )

    it('signs the key, five minutes, and the type and length of the file', async () => {
      const url = new URL(
        await storage.uploadUrl({
          key: 'stores/s/uploads/m/a.png',
          contentType: 'image/png',
          contentLength: 68
        })
      )
      expect(url.pathname).toBe('/bucket/stores/s/uploads/m/a.png')
      expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
      const signed = url.searchParams.get('X-Amz-SignedHeaders') ?? ''
      expect(signed).toContain('content-type')
      expect(signed).toContain('content-length')
    })
  })
  describe('downloadUrl', () => {
    const real = new StorageService(
      createS3Client({
        bucket: 'bucket',
        region: 'us-east-1',
        accessKeyId: 'k',
        secretAccessKey: 's',
        endpoint: 'http://localhost:8333',
        forcePathStyle: true
      }),
      'bucket'
    )

    it('fixes the type and forces a download of what an uploader sent', async () => {
      const url = new URL(
        await real.downloadUrl({
          key: 'stores/s/messages/m/x.html',
          contentType: 'image/png',
          filename: 'x.html'
        })
      )
      expect(url.searchParams.get('response-content-type')).toBe('image/png')
      expect(url.searchParams.get('response-content-disposition')).toMatch(
        /^attachment; filename="x\.html"/
      )
      expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    })

    it('shows a re-encoded variant inline', async () => {
      const url = new URL(
        await real.downloadUrl({
          key: 'stores/s/messages/m/variants/thumb.webp',
          contentType: 'image/webp',
          filename: 'x.png',
          inline: true
        })
      )
      expect(url.searchParams.get('response-content-disposition')).toBe('inline')
    })
  })

  describe('read', () => {
    const body = (...chunks: string[]) => Readable.from(chunks.map(chunk => Buffer.from(chunk)))

    it('answers the bytes of an object inside the limit', async () => {
      const send = jest
        .fn()
        .mockResolvedValueOnce({ ContentLength: 6 })
        .mockResolvedValueOnce({ Body: body('abc', 'def') })
      expect((await serviceWith(send).read('k', 10))?.toString()).toBe('abcdef')
    })

    it('refuses an object that its head says is too big, without reading it', async () => {
      const send = jest.fn().mockResolvedValueOnce({ ContentLength: 11 })
      await expect(serviceWith(send).read('k', 10)).rejects.toThrow('bigger than the limit')
      expect(send).toHaveBeenCalledTimes(1)
    })

    it('stops reading when the body is bigger than the head said', async () => {
      const send = jest
        .fn()
        .mockResolvedValueOnce({ ContentLength: 3 })
        .mockResolvedValueOnce({ Body: body('abcdef', 'ghijkl') })
      await expect(serviceWith(send).read('k', 8)).rejects.toThrow('bigger than the limit')
    })

    it('answers null for an object that is not there', async () => {
      expect(await serviceWith(jest.fn().mockRejectedValue(failure(404))).read('k', 10)).toBeNull()
    })
  })
})
