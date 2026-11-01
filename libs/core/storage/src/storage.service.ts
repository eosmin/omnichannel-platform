import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  type S3Client
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common'

import { HttpStatusCodes } from '@platform/core/errors'
import { UploadLimits } from '@platform/core/storage'

import { S3_CLIENT, STORAGE_BUCKET } from './storage.constants'

export interface UploadUrlParams {
  key: string
  contentType: string
  contentLength: number
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
