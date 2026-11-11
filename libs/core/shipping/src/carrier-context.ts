import type { CredentialCipher } from '@platform/core/crypto'
import type { CarrierContext } from '@platform/plugins/sdk'

// The stored credentials of a connection do not open: the key was rotated, or the row is damaged. It names nothing of what
// was inside.
export class CarrierCredentialsUnreadableError extends Error {
  constructor(cause?: unknown) {
    super('the credentials of the connection cannot be read', { cause })
    this.name = 'CarrierCredentialsUnreadableError'
  }
}

// What a connection row holds that a call to its plugin needs: the sealed credentials and the settings of the account
export interface ConnectionContextRow {
  id: string
  storeId: string
  credentials: Uint8Array | null
  // Not secret: what the plugin gave back at connect (a `local` courier's phone and notes, a carrier's account settings)
  contact: unknown
}

// The context of one call to a carrier plugin (TDD_17 §4.1): the credentials are opened here, for this call only, and
// are never kept. A row with no credentials (the `local` courier) gives an empty set. What the database holds is
// checked to be an object again, as it is for a channel.
export function buildCarrierContext(
  row: ConnectionContextRow,
  cipher: CredentialCipher
): CarrierContext {
  const contact = row.contact
  let credentials: Record<string, unknown> = {}
  if (row.credentials !== null) {
    try {
      credentials = cipher.open(row.credentials)
    } catch (error) {
      throw new CarrierCredentialsUnreadableError(error)
    }
  }
  return {
    storeId: row.storeId,
    connectionId: row.id,
    credentials,
    metadata:
      typeof contact === 'object' && contact !== null && !Array.isArray(contact)
        ? Object.fromEntries(Object.entries(contact))
        : {}
  }
}
