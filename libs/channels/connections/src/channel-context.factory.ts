import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { CredentialCipher } from '@platform/core/crypto'
import type { ChannelContext } from '@platform/plugins/sdk'

export interface ConnectionRow {
  id: string
  storeId: string
  pluginId: string
  connectionId: string
  status: string
  credentials: Uint8Array
  metadata: unknown
}

export const CONNECTION_ROW_SELECT = {
  id: true,
  storeId: true,
  pluginId: true,
  connectionId: true,
  status: true,
  credentials: true,
  metadata: true
} as const

const metadataSchema = z.record(z.string(), z.unknown())

// What a plugin is given to talk to the provider: the credentials, decrypted for this call only. The
// store is the one of the row, never one a caller names.
@Injectable()
export class ChannelContextFactory {
  constructor(private readonly cipher: CredentialCipher) {}

  contextFor(row: ConnectionRow): ChannelContext {
    return {
      storeId: row.storeId,
      connectionId: row.connectionId,
      credentials: this.cipher.open(row.credentials),
      metadata: metadataSchema.catch({}).parse(row.metadata)
    }
  }
}
