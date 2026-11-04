import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { CredentialCipher } from '@platform/core/crypto'
import { ErrorCodes } from '@platform/core/errors'
import { type ChannelContext, PluginError } from '@platform/plugins/sdk'

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

// The credentials of a connection cannot be opened: sealed with another key, or damaged. Ours to fix,
// not the provider's. It is retryable on purpose, because the cause may be a worker that runs with
// another key for a while (a rolling deploy): the senders try again as often as they do for any
// failure, and the last attempt gives it up as CHANNEL_CREDENTIALS_INVALID, so nothing loops. It
// carries nothing of the cipher.
export class CredentialsUnreadableError extends PluginError {
  constructor() {
    super(ErrorCodes.CHANNEL_CREDENTIALS_INVALID, { retryable: true })
    this.name = 'CredentialsUnreadableError'
  }
}

// What a plugin is given to talk to the provider: the credentials, decrypted for this call only. The
// store is the one of the row, never one a caller names.
@Injectable()
export class ChannelContextFactory {
  constructor(private readonly cipher: CredentialCipher) {}

  contextFor(row: ConnectionRow): ChannelContext {
    let credentials
    try {
      credentials = this.cipher.open(row.credentials)
    } catch {
      // Nothing of the original error travels on: its text names the cipher
      throw new CredentialsUnreadableError()
    }
    return {
      storeId: row.storeId,
      connectionId: row.connectionId,
      credentials,
      metadata: metadataSchema.catch({}).parse(row.metadata)
    }
  }
}
