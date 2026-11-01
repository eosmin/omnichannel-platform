import type { Readable } from 'node:stream'

import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'

import { HttpStatusCodes } from '@platform/core/errors'
import { attachmentDisposition, UploadLimits } from '@platform/core/storage'

import { S3_CLIENT, STORAGE_BUCKET } from './storage.constants'

export interface UploadUrlParams {
  key: string
  contentType: string
  contentLength: number
}

export interface DownloadUrlParams {
  key: string
  // What the browser is told the bytes are. It comes from the Media row, never from the extension of
  // the name: `x.html` declared `image/png` is served as an image or not at all, never as a page.
  contentType: string
  filename: string
  // Only for the re-encoded variants. Anything the uploader sent is always an attachment.
  inline?: boolean
}

export interface StoredObject {
  contentLength: number
  contentType: string | undefined
  // Identifies the exact bytes: what was checked can be pinned (copy) or compared later
  etag: string | undefined
}

// What S3 answers for an object that is not there: 404. A 403 is NOT "missing": it is a credential or
// policy failure, which must surface as a server error and not look like a bad upload. (Without
// s3:ListBucket, S3 answers 403 for a missing key too: the role of the api must hold it, Step 7.3.)
function statusOf(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode
}

// The bucket, and nothing else: it knows no store, no purpose and no permission. The callers build
// the key with StorageKeys (the one place keys are built) and decide who may ask for it; this class
// only talks to S3. File bytes never go through the api: a client PUTs to a signed URL.
@Injectable()
export class StorageService implements OnApplicationShutdown {
  constructor(
    @Inject(S3_CLIENT) private readonly s3: S3Client,
    @Inject(STORAGE_BUCKET) private readonly bucket: string
  ) {}

  // The type and the length are part of the signature: S3 refuses a PUT whose headers differ from
  // the signed ones, so the size limit holds at the edge and not only in a later check.
  uploadUrl(params: UploadUrlParams): Promise<string> {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ContentType: params.contentType,
      ContentLength: params.contentLength
    })
    return getSignedUrl(this.s3, command, {
      expiresIn: UploadLimits.PRESIGNED_URL_TTL_SECONDS,
      signableHeaders: new Set(['content-type', 'content-length'])
    })
  }

  // A short-lived URL on the bucket host. The headers of the answer are fixed by the signature, so a
  // client cannot ask for another type or for the file to be shown inline.
  downloadUrl(params: DownloadUrlParams): Promise<string> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: params.key,
      ResponseContentType: params.contentType,
      ResponseContentDisposition:
        params.inline === true ? 'inline' : attachmentDisposition(params.filename)
    })
    return getSignedUrl(this.s3, command, { expiresIn: UploadLimits.DOWNLOAD_URL_TTL_SECONDS })
  }

  // The object as a stream, for what is too big to hold (a virus scan). null when it is not there.
  async stream(key: string): Promise<Readable | null> {
    try {
      const object = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
      return (object.Body as Readable | undefined) ?? null
    } catch (error) {
      if (statusOf(error) === HttpStatusCodes.NOT_FOUND) return null
      throw error
    }
  }

  // The whole object, refused above `maxBytes` before any of it is read. null when it is not there.
  async read(key: string, maxBytes: number): Promise<Buffer | null> {
    const head = await this.head(key)
    if (head === null) return null
    if (head.contentLength > maxBytes) throw new Error('the object is bigger than the limit')
    const body = await this.stream(key)
    if (body === null) return null
    const chunks: Buffer[] = []
    let total = 0
    for await (const chunk of body) {
      const part = chunk as Buffer
      total += part.length
      // The size of the head can be stale by the time the body is read
      if (total > maxBytes) {
        body.destroy()
        throw new Error('the object is bigger than the limit')
      }
      chunks.push(part)
    }
    return Buffer.concat(chunks)
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.s3.send(
      new PutObjectCommand({ Bucket: this.bucket, Key: key, Body: body, ContentType: contentType })
    )
  }

  // null when there is no such object; any other failure (network, a broken request) is thrown
  async head(key: string): Promise<StoredObject | null> {
    try {
      const head = await this.s3.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }))
      return {
        contentLength: head.ContentLength ?? 0,
        contentType: head.ContentType,
        etag: head.ETag
      }
    } catch (error) {
      if (statusOf(error) === HttpStatusCodes.NOT_FOUND) return null
      throw error
    }
  }

  // Server side: the bytes do not pass through the api. The type travels with the object. With
  // `ifMatch` the copy happens only if the source is still the object whose ETag was checked, so a
  // file replaced in between is refused (false) instead of promoted.
  async copy(fromKey: string, toKey: string, ifMatch?: string): Promise<boolean> {
    try {
      await this.s3.send(
        new CopyObjectCommand({
          Bucket: this.bucket,
          Key: toKey,
          CopySource: `${this.bucket}/${fromKey.split('/').map(encodeURIComponent).join('/')}`,
          MetadataDirective: 'COPY',
          ...(ifMatch === undefined ? {} : { CopySourceIfMatch: ifMatch })
        })
      )
      return true
    } catch (error) {
      if (statusOf(error) === HttpStatusCodes.PRECONDITION_FAILED) return false
      throw error
    }
  }

  // Deleting a key that is not there is not an error (S3 answers 204)
  async delete(key: string): Promise<void> {
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }

  // Readiness: the bucket exists and the credentials can reach it. The request is cut when the time
  // is up, retries included: a probe that hangs must not leave sockets and retries behind.
  async checkBucket(timeoutMs: number): Promise<void> {
    await this.s3.send(new HeadBucketCommand({ Bucket: this.bucket }), {
      abortSignal: AbortSignal.timeout(timeoutMs)
    })
  }

  onApplicationShutdown(): void {
    this.s3.destroy()
  }
}
