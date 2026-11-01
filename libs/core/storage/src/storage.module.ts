import { S3Client } from '@aws-sdk/client-s3'
import { type DynamicModule, Module } from '@nestjs/common'

import { S3_CLIENT, STORAGE_BUCKET } from './storage.constants'
import { StorageService } from './storage.service'

export interface StorageModuleOptions {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  endpoint?: string | undefined
  forcePathStyle: boolean
}

export function createS3Client(options: StorageModuleOptions): S3Client {
  return new S3Client({
    region: options.region,
    credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
    ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
    forcePathStyle: options.forcePathStyle,
    // The SDK adds a CRC32 checksum to every request by default; S3-compatible stores (SeaweedFS)
    // and a browser PUT to a signed URL do not send one
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED'
  })
}

@Module({})
export class StorageModule {
  static forRoot(options: StorageModuleOptions): DynamicModule {
    return {
      module: StorageModule,
      providers: [
        { provide: S3_CLIENT, useFactory: () => createS3Client(options) },
        { provide: STORAGE_BUCKET, useValue: options.bucket },
        StorageService
      ],
      exports: [StorageService]
    }
  }
}
