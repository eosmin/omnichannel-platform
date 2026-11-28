import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { SealedTargetIds } from '@platform/core/domain'

// The closed list of the sealed columns (Step 7.3-S11c). A new column of bytes in the schema is, until somebody says what it is, a value that
// a rotation of CREDENTIALS_ENCRYPTION_KEY would leave unreadable: this spec fails until the column is on the re-seal of the fiscal area
// (FiscalResealService), on the list of CredentialsResealService, or here with the reason it needs neither.
const SEALED_BY_THIS_RESEAL: Record<string, string> = {
  'ChannelConnection.credentials': SealedTargetIds.CONNECTION_CREDENTIALS,
  'CarrierConnection.credentials': SealedTargetIds.CARRIER_CREDENTIALS,
  'CarrierConnection.webhookSecret': SealedTargetIds.CARRIER_WEBHOOK_SECRET,
  'Webhook.secret': SealedTargetIds.WEBHOOK_SECRET,
  'PluginInstallation.webhookSecret': SealedTargetIds.PLUGIN_WEBHOOK_SECRET,
  'PluginInstallation.commandSecret': SealedTargetIds.PLUGIN_COMMAND_SECRET,
  'PluginInstallation.commandSecretPrevious': SealedTargetIds.PLUGIN_COMMAND_SECRET_PREVIOUS,
  'Invitation.emailOutbox': SealedTargetIds.INVITATION_OUTBOX,
  'DataSubjectRequest.notifyToEncrypted': SealedTargetIds.DSR_NOTIFY_ADDRESS,
  'DataSubjectRequest.resultPasswordSealed': SealedTargetIds.DSR_EXPORT_PASSWORD
}
const SEALED_BY_THE_FISCAL_RESEAL = [
  'CustomerFiscalData.dataEncrypted',
  'FiscalIssuer.credentialsEncrypted',
  'FiscalDocument.receiverEncrypted',
  'FiscalDocument.builtPayloadEncrypted',
  'FiscalDocument.voidEventEncrypted',
  'ExcludedSubjectPurchase.sellerEncrypted',
  'FiscalContingency.responsibleEncrypted'
]
// Bytes columns that hold no value sealed with the platform key (none today)
const NOT_SEALED: string[] = []

function bytesColumns(): string[] {
  const schema = readFileSync(
    join(__dirname, '../../../../libs/core/database/prisma/schema.prisma'),
    'utf8'
  )
  const found: string[] = []
  let model: string | null = null
  for (const line of schema.split('\n')) {
    const open = /^model (\w+) \{/.exec(line)
    if (open !== null) model = open[1] ?? null
    else if (line.startsWith('}')) model = null
    else if (model !== null) {
      const field = /^\s+(\w+)\s+Bytes(\?|\[\])?(\s|$)/.exec(line)
      if (field !== null) found.push(`${model}.${field[1]}`)
    }
  }
  // A scanner that found no model at all would pass on any schema
  if (!schema.includes('model ChannelConnection {')) throw new Error('the schema was not read')
  return found.sort()
}

describe('the sealed columns of the schema', () => {
  it('are all on a re-seal of a rotation of the key, or declared as holding nothing sealed', () => {
    const declared = [
      ...Object.keys(SEALED_BY_THIS_RESEAL),
      ...SEALED_BY_THE_FISCAL_RESEAL,
      ...NOT_SEALED
    ].sort()
    expect(bytesColumns()).toEqual(declared)
  })

  it('has one target for each column this re-seal declares', () => {
    expect(Object.values(SEALED_BY_THIS_RESEAL).sort()).toEqual(
      Object.values(SealedTargetIds).sort()
    )
  })
})
