import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { Readable } from 'node:stream'

import { AbortMultipartUploadCommand, type S3Client } from '@aws-sdk/client-s3'

import { createS3Client } from './storage.module'
import { StorageService } from './storage.service'

const failure = (status: number) =>
  Object.assign(new Error('s3'), { $metadata: { httpStatusCode: status } })

function serviceWith(send: jest.Mock): StorageService {
  return new StorageService({ send, destroy: jest.fn() } as unknown as S3Client, 'bucket')
}

describe('StorageService', () => {
  describe('inspectProtection', () => {
    // Answers each command by its class, as the store would
    const answering =
      (answers: { encryption: () => unknown; versioning: () => unknown }) =>
      (command: { constructor: { name: string } }) => {
        const answer =
          command.constructor.name === 'GetBucketEncryptionCommand'
            ? answers.encryption
            : answers.versioning
        return Promise.resolve().then(answer)
      }
    const encrypted = () => ({
      ServerSideEncryptionConfiguration: {
        Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }]
      }
    })
    const named = (name: string) => () => {
      throw Object.assign(new Error(name), { name })
    }

    it('is on for both when the bucket is encrypted and versioned', async () => {
      const send = jest
        .fn()
        .mockImplementation(
          answering({ encryption: encrypted, versioning: () => ({ Status: 'Enabled' }) })
        )
      expect(await serviceWith(send).inspectProtection(1000)).toEqual({
        encryption: 'on',
        versioning: 'on'
      })
    })

    it('is off for a bucket with no default encryption and with versioning never set or suspended', async () => {
      const send = jest.fn().mockImplementation(
        answering({
          encryption: named('ServerSideEncryptionConfigurationNotFoundError'),
          versioning: () => ({})
        })
      )
      expect(await serviceWith(send).inspectProtection(1000)).toEqual({
        encryption: 'off',
        versioning: 'off'
      })
      const suspended = jest
        .fn()
        .mockImplementation(
          answering({ encryption: encrypted, versioning: () => ({ Status: 'Suspended' }) })
        )
      expect((await serviceWith(suspended).inspectProtection(1000)).versioning).toBe('off')
    })

    it('is off for a rule that names no algorithm', async () => {
      const send = jest.fn().mockImplementation(
        answering({
          encryption: () => ({
            ServerSideEncryptionConfiguration: { Rules: [{ BucketKeyEnabled: true }] }
          }),
          versioning: () => ({ Status: 'Enabled' })
        })
      )
      expect((await serviceWith(send).inspectProtection(1000)).encryption).toBe('off')
    })

    it('is unknown, never on, when the store does not answer the question', async () => {
      const send = jest
        .fn()
        .mockImplementation(
          answering({ encryption: named('AccessDenied'), versioning: named('NotImplemented') })
        )
      expect(await serviceWith(send).inspectProtection(1000)).toEqual({
        encryption: 'unknown',
        versioning: 'unknown'
      })
    })
  })

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

// `uploadUrl` and `downloadUrl` are declared LOCAL in scripts/external-io-providers.ts: a route that only signs does not hold the 15 s transaction
// of a request on the network. This is the property, not a pin by name: the REAL client of the module (createS3Client, static credentials)
// signs while every way out of the process throws, so a signature that needs the network (a provider chain, a lookup of the region) fails here.
describe('StorageService signing is local', () => {
  const offline = (): never => {
    throw new Error('the signature went to the network')
  }
  const spies: jest.SpyInstance[] = []
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore()
  })

  function signingService(): StorageService {
    const s3 = createS3Client({
      bucket: 'bucket',
      region: 'us-east-1',
      accessKeyId: 'AKIAEXAMPLE',
      secretAccessKey: 'secret-example',
      endpoint: 'https://s3.invalid',
      forcePathStyle: true
    })
    spies.push(
      jest.spyOn(http, 'request').mockImplementation(offline),
      jest.spyOn(https, 'request').mockImplementation(offline),
      jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(offline),
      jest.spyOn(globalThis, 'fetch').mockImplementation(offline)
    )
    return new StorageService(s3, 'bucket')
  }

  it('signs an upload URL with no call to the network', async () => {
    const url = await signingService().uploadUrl({
      key: 'stores/s/messages/a/photo.png',
      contentType: 'image/png',
      contentLength: 1024
    })
    expect(url).toContain('https://s3.invalid/bucket/stores/s/messages/a/photo.png')
    expect(url).toContain('X-Amz-Signature=')
  })

  it('signs a download URL with no call to the network', async () => {
    const url = await signingService().downloadUrl({
      key: 'stores/s/messages/a/photo.png',
      contentType: 'image/png',
      filename: 'photo.png'
    })
    expect(url).toContain('https://s3.invalid/bucket/stores/s/messages/a/photo.png')
    expect(url).toContain('X-Amz-Signature=')
  })
  describe('putStream', () => {
    class Marker extends Error {}

    // Small (one part) and large (multipart): the error of the body must reach the caller as it is,
    // because the callers tell a failure that retries from one that does not by its class
    it.each([
      ['a body that fails at once', 10],
      ['a body that fails after several parts', 12 * 1024 * 1024]
    ])('throws the very error of %s and aborts the upload', async (_name, before) => {
      const send = jest.fn().mockResolvedValue({ UploadId: 'u', ETag: '"e"' })
      const marker = new Marker('too large')
      let sent = 0
      const body = new Readable({
        read() {
          if (sent >= before) {
            this.destroy(marker)
            return
          }
          const size = Math.min(1024 * 1024, before - sent)
          sent += size
          this.push(Buffer.alloc(size, 1))
        }
      })
      const caught = await serviceWith(send)
        .putStream('k', body, 'application/zip')
        .catch((error: unknown) => error)
      expect(caught).toBe(marker)
    })

    // The fake client of the cases above has no `config`, which the uploader reads before it begins a multipart upload, so none of them
    // ever begins one; this client has it, so the upload is begun and the parts leave before the body fails, and an abort that is never
    // sent would leave the parts in the bucket
    it('sends the abort of a multipart upload that was begun, with its id, when the body fails later', async () => {
      const send = jest.fn().mockResolvedValue({ UploadId: 'u', ETag: '"e"' })
      const marker = new Marker('too large')
      const body = Readable.from(
        (async function* () {
          for (let part = 0; part < 3; part += 1) {
            yield Buffer.alloc(6 * 1024 * 1024, 1)
            await new Promise(resolve => setTimeout(resolve, 20))
          }
          throw marker
        })()
      )

      const client = {
        send,
        destroy: jest.fn(),
        config: {
          requestChecksumCalculation: () => Promise.resolve('WHEN_REQUIRED'),
          requestHandler: {}
        }
      }

      const caught = await new StorageService(client as unknown as S3Client, 'bucket')
        .putStream('k', body, 'application/zip')
        .catch((error: unknown) => error)

      expect(caught).toBe(marker)
      const aborts = send.mock.calls
        .map(([command]) => command as unknown)
        .filter(command => command instanceof AbortMultipartUploadCommand)
      expect(aborts).toHaveLength(1)
      expect((aborts[0] as AbortMultipartUploadCommand).input).toMatchObject({
        Bucket: 'bucket',
        Key: 'k',
        UploadId: 'u'
      })
    })
  })
})
