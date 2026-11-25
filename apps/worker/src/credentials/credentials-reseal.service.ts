// rls-context: every database access of this service happens inside `unit` (JobContext.inOrganization, opened by CredentialsResealer), one short unit per page and per value
import { isDeepStrictEqual } from 'node:util'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { dsrExportPasswordAad } from '@platform/core/compliance'
import { CredentialCipher, DecryptionError, failureOf, SealedWith } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  CREDENTIALS_RESEAL_MISMATCH,
  CREDENTIALS_RESEAL_WRITE_FAILED,
  CredentialsReseal,
  CredentialsResealOutcome,
  SealedResourceTypes,
  SealedFormats,
  type SealedFormat,
  type SealedTargetId,
  SealedTargetIds
} from '@platform/core/domain'
import { invitationOutboxAad } from '@platform/core/email'
import { errorName } from '@platform/core/errors'

// The value sealed again did not open to the same content (never carries the content)
class ResealMismatchError extends Error {
  constructor() {
    super('the value sealed again does not open to the same content')
    this.name = 'ResealMismatchError'
  }
}

// What one run of one organization did. Counts only: never a value, never a fragment of one.
export interface CredentialsResealReport {
  // False when no previous key is held: there is nothing to re-seal and nothing is read
  enabled: boolean
  scanned: number
  current: number
  resealed: number
  conflicts: number
  // Values that opened with neither key (or could not be sealed again): left exactly as they were, by the code of the failure
  failed: Record<string, number>
  // A target that hit the cap of one run (the next run goes on from the start: what is done is skipped quickly)
  truncated: boolean
}

// The unit of work the caller opens: one short transaction in the context of the organization. A value that fails aborts only its own.
export type CredentialsResealUnit = <T>(work: () => Promise<T>) => Promise<T>

interface SealedRow {
  id: string
  sealed: Uint8Array
  // What binds the value to its row, when the value was sealed with it
  aad?: string
}

// One sealed COLUMN of one table, by declaration: how to read a page of the organization, how to swap one value. The re-seal below knows
// no table and no kind of credential; it only reads, opens, seals again, checks and swaps what a target hands it.
interface Target {
  id: SealedTargetId
  resourceType: string
  // A set of credentials (JSON object) or a plain text
  format: SealedFormat
  read(organizationId: string, after: string | undefined, take: number): Promise<SealedRow[]>
  // Compare-and-swap: true only when the row still held the old bytes (they are in the WHERE) and the organization is the row's
  swap(organizationId: string, row: SealedRow, next: Uint8Array<ArrayBuffer>): Promise<boolean>
}

const emptyReport = (enabled: boolean): CredentialsResealReport => ({
  enabled,
  scanned: 0,
  current: 0,
  resealed: 0,
  conflicts: 0,
  failed: {},
  truncated: false
})

const asBytes = (value: Uint8Array): Uint8Array<ArrayBuffer> => value as Uint8Array<ArrayBuffer>
const after = (cursor: string | undefined): { id?: { gt: string } } =>
  cursor === undefined ? {} : { id: { gt: cursor } }

// The re-seal of a rotation of CREDENTIALS_ENCRYPTION_KEY for every sealed value outside the fiscal area (Step 7.3-S11c; the fiscal values
// are FiscalResealService's, Step 7.3-S11b): the credentials of the connections of the channels and of the carriers, the secrets of the
// webhooks and of the plugins, the outbox of the invitations and the address a closing mail goes to. Same guarantees as the fiscal one:
// a value that opens with neither key is counted and LEFT AS IT WAS (nothing is lost); the new value must open, with the current key alone,
// to exactly the same content before anything is written (same transaction); the write is a compare-and-swap with the old bytes in the
// WHERE; it is idempotent and resumable (a value already current is skipped); it runs only while a previous key is held and fails closed
// without it. The audit entry and the logs carry the target and the row, never a value.
@Injectable()
export class CredentialsResealService {
  private readonly targets: readonly Target[]

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(CredentialsResealService.name)
    this.targets = this.declareTargets()
  }

  // Whether a previous key is held: without one nothing is read and nothing is queued
  get enabled(): boolean {
    return this.cipher.hasPreviousKey
  }

  // The closed list of the sealed columns, for the spec that compares it with the schema
  get targetIds(): readonly SealedTargetId[] {
    return this.targets.map(target => target.id)
  }

  async run(organizationId: string, unit: CredentialsResealUnit): Promise<CredentialsResealReport> {
    if (!this.cipher.hasPreviousKey) return emptyReport(false)
    const report = emptyReport(true)
    // Failures written to the log in this run, all targets: the rest are only counted
    let logged = 0
    for (const target of this.targets) {
      let cursor: string | undefined
      // Values of this target sealed again, or lost to a conflict, in this run: the only ones that count against the cap of writes (the ones
      // already current and the ones that never open are skipped, so they cannot starve the rows behind them)
      let worked = 0
      // Values of this target read in this run, whatever happened to them: the cap of reads
      let read = 0
      // The cap of THIS target: a target that hit it does not stop the ones after it
      let capped = false
      for (;;) {
        const rows = await unit(() =>
          target.read(organizationId, cursor, CredentialsReseal.PAGE_SIZE)
        )
        for (const row of rows) {
          if (
            worked >= CredentialsReseal.MAX_VALUES_PER_TARGET ||
            read >= CredentialsReseal.MAX_SCANNED_PER_TARGET
          ) {
            report.truncated = true
            capped = true
            break
          }
          report.scanned += 1
          read += 1
          try {
            const outcome = await unit(() => this.reseal(target, organizationId, row))
            if (outcome === CredentialsResealOutcome.CURRENT) {
              report.current += 1
              continue
            }
            worked += 1
            if (outcome === CredentialsResealOutcome.CONFLICT) {
              report.conflicts += 1
              continue
            }
            report.resealed += 1
            // After the unit resolved: an entry for a swap that was rolled back would be false evidence
            this.audit.log({
              action: AuditAction.CREDENTIALS_VALUE_RESEALED,
              actor: { system: true },
              organizationId,
              resourceType: target.resourceType,
              resourceId: row.id,
              metadata: { target: target.id }
            })
          } catch (error) {
            // One value that cannot be handled must not stop the others: it is counted by the code of the failure and left as it was
            const code =
              error instanceof DecryptionError
                ? failureOf(error)
                : error instanceof ResealMismatchError
                  ? CREDENTIALS_RESEAL_MISMATCH
                  : CREDENTIALS_RESEAL_WRITE_FAILED
            report.failed[code] = (report.failed[code] ?? 0) + 1
            logged += 1
            if (logged <= CredentialsReseal.MAX_LOGGED_FAILURES) {
              this.logger.error(
                {
                  errorName: errorName(error),
                  failure: code,
                  what: target.id,
                  organizationId,
                  rowId: row.id
                },
                'a sealed value was not sealed again'
              )
            }
          }
        }
        const last = rows.at(-1)
        if (capped || rows.length < CredentialsReseal.PAGE_SIZE || last === undefined) {
          break
        }
        cursor = last.id
      }
    }
    if (logged > CredentialsReseal.MAX_LOGGED_FAILURES) {
      this.logger.error(
        { organizationId, notLogged: logged - CredentialsReseal.MAX_LOGGED_FAILURES },
        'more sealed values were not sealed again than the log names (the report counts them by code)'
      )
    }
    return report
  }

  // One value, inside the unit of the caller: open, seal again, check, swap
  private async reseal(
    target: Target,
    organizationId: string,
    row: SealedRow
  ): Promise<CredentialsResealOutcome> {
    const aad = row.aad
    let next: Uint8Array<ArrayBuffer>
    if (target.format === SealedFormats.TEXT) {
      const opened = this.cipher.openTextRotating(row.sealed, aad)
      if (opened.sealedWith === SealedWith.CURRENT) return CredentialsResealOutcome.CURRENT
      next = this.cipher.sealText(opened.text, aad)
      // What was sealed again must open, with the current key alone, to the very same text (before the write)
      if (this.cipher.openText(next, aad) !== opened.text) throw new ResealMismatchError()
    } else {
      const opened = this.cipher.openRotating(row.sealed, aad)
      if (opened.sealedWith === SealedWith.CURRENT) return CredentialsResealOutcome.CURRENT
      next = this.cipher.seal(opened.credentials, aad)
      if (!isDeepStrictEqual(this.cipher.open(next, aad), opened.credentials)) {
        throw new ResealMismatchError()
      }
    }
    return (await target.swap(organizationId, row, next))
      ? CredentialsResealOutcome.RESEALED
      : CredentialsResealOutcome.CONFLICT
  }

  private declareTargets(): readonly Target[] {
    const client = (): PrismaService['client'] => this.prisma.client
    return [
      {
        id: SealedTargetIds.CONNECTION_CREDENTIALS,
        resourceType: SealedResourceTypes.CHANNEL_CONNECTION,
        format: SealedFormats.JSON,
        read: async (organizationId, cursor, take) =>
          (
            await client().channelConnection.findMany({
              where: { store: { organizationId }, ...after(cursor) },
              select: { id: true, credentials: true },
              orderBy: { id: 'asc' },
              take
            })
          ).map(r => ({ id: r.id, sealed: r.credentials })),
        swap: async (organizationId, row, next) =>
          (
            await client().channelConnection.updateMany({
              where: { id: row.id, store: { organizationId }, credentials: asBytes(row.sealed) },
              data: { credentials: next }
            })
          ).count === 1
      },
      {
        id: SealedTargetIds.CARRIER_CREDENTIALS,
        resourceType: SealedResourceTypes.CARRIER_CONNECTION,
        format: SealedFormats.JSON,
        read: async (organizationId, cursor, take) =>
          (
            await client().carrierConnection.findMany({
              where: { store: { organizationId }, credentials: { not: null }, ...after(cursor) },
              select: { id: true, credentials: true },
              orderBy: { id: 'asc' },
              take
            })
          ).flatMap(r => (r.credentials === null ? [] : [{ id: r.id, sealed: r.credentials }])),
        swap: async (organizationId, row, next) =>
          (
            await client().carrierConnection.updateMany({
              where: { id: row.id, store: { organizationId }, credentials: asBytes(row.sealed) },
              data: { credentials: next }
            })
          ).count === 1
      },
      {
        id: SealedTargetIds.CARRIER_WEBHOOK_SECRET,
        resourceType: SealedResourceTypes.CARRIER_CONNECTION,
        format: SealedFormats.JSON,
        read: async (organizationId, cursor, take) =>
          (
            await client().carrierConnection.findMany({
              where: { store: { organizationId }, webhookSecret: { not: null }, ...after(cursor) },
              select: { id: true, webhookSecret: true },
              orderBy: { id: 'asc' },
              take
            })
          ).flatMap(r => (r.webhookSecret === null ? [] : [{ id: r.id, sealed: r.webhookSecret }])),
        swap: async (organizationId, row, next) =>
          (
            await client().carrierConnection.updateMany({
              where: { id: row.id, store: { organizationId }, webhookSecret: asBytes(row.sealed) },
              data: { webhookSecret: next }
            })
          ).count === 1
      },
      {
        id: SealedTargetIds.WEBHOOK_SECRET,
        resourceType: SealedResourceTypes.WEBHOOK,
        format: SealedFormats.JSON,
        read: async (organizationId, cursor, take) =>
          (
            await client().webhook.findMany({
              where: { store: { organizationId }, ...after(cursor) },
              select: { id: true, secret: true },
              orderBy: { id: 'asc' },
              take
            })
          ).map(r => ({ id: r.id, sealed: r.secret })),
        swap: async (organizationId, row, next) =>
          (
            await client().webhook.updateMany({
              where: { id: row.id, store: { organizationId }, secret: asBytes(row.sealed) },
              data: { secret: next }
            })
          ).count === 1
      },
      this.pluginColumn(SealedTargetIds.PLUGIN_WEBHOOK_SECRET, 'webhookSecret', client),
      this.pluginColumn(SealedTargetIds.PLUGIN_COMMAND_SECRET, 'commandSecret', client),
      this.pluginColumn(
        SealedTargetIds.PLUGIN_COMMAND_SECRET_PREVIOUS,
        'commandSecretPrevious',
        client
      ),
      {
        id: SealedTargetIds.INVITATION_OUTBOX,
        resourceType: SealedResourceTypes.INVITATION,
        format: SealedFormats.JSON,
        read: async (organizationId, cursor, take) =>
          (
            await client().invitation.findMany({
              where: { organizationId, emailOutbox: { not: null }, ...after(cursor) },
              select: { id: true, storeId: true, emailOutbox: true },
              orderBy: { id: 'asc' },
              take
            })
          ).flatMap(r =>
            r.emailOutbox === null
              ? []
              : [
                  {
                    id: r.id,
                    sealed: r.emailOutbox,
                    // The outbox is bound to its invitation and its store. A value sealed before the binding (format 1) has no data to check and
                    // opens even when the data is given (tests/api/credentials-reseal.spec.ts measures it); it is sealed again bound
                    aad: invitationOutboxAad(r.storeId, r.id)
                  }
                ]
          ),
        swap: async (organizationId, row, next) =>
          (
            await client().invitation.updateMany({
              where: { id: row.id, organizationId, emailOutbox: asBytes(row.sealed) },
              data: { emailOutbox: next }
            })
          ).count === 1
      },
      {
        id: SealedTargetIds.DSR_NOTIFY_ADDRESS,
        resourceType: SealedResourceTypes.DATA_SUBJECT_REQUEST,
        format: SealedFormats.TEXT,
        read: async (organizationId, cursor, take) =>
          (
            await client().dataSubjectRequest.findMany({
              where: { organizationId, notifyToEncrypted: { not: null }, ...after(cursor) },
              select: { id: true, notifyToEncrypted: true },
              orderBy: { id: 'asc' },
              take
            })
          ).flatMap(r =>
            r.notifyToEncrypted === null ? [] : [{ id: r.id, sealed: r.notifyToEncrypted }]
          ),
        swap: async (organizationId, row, next) =>
          (
            await client().dataSubjectRequest.updateMany({
              where: { id: row.id, organizationId, notifyToEncrypted: asBytes(row.sealed) },
              data: { notifyToEncrypted: next }
            })
          ).count === 1
      },
      {
        // The password of the encrypted ZIP of a data export (text, bound to its request); it lives as long as the file (a few days)
        id: SealedTargetIds.DSR_EXPORT_PASSWORD,
        resourceType: SealedResourceTypes.DATA_SUBJECT_REQUEST,
        format: SealedFormats.TEXT,
        read: async (organizationId, cursor, take) =>
          (
            await client().dataSubjectRequest.findMany({
              where: { organizationId, resultPasswordSealed: { not: null }, ...after(cursor) },
              select: { id: true, resultPasswordSealed: true },
              orderBy: { id: 'asc' },
              take
            })
          ).flatMap(r =>
            r.resultPasswordSealed === null
              ? []
              : [{ id: r.id, sealed: r.resultPasswordSealed, aad: dsrExportPasswordAad(r.id) }]
          ),
        swap: async (organizationId, row, next) =>
          (
            await client().dataSubjectRequest.updateMany({
              where: { id: row.id, organizationId, resultPasswordSealed: asBytes(row.sealed) },
              data: { resultPasswordSealed: next }
            })
          ).count === 1
      }
    ]
  }

  // The three sealed columns of an installation of a plugin differ only in the column
  private pluginColumn(
    id: SealedTargetId,
    column: 'webhookSecret' | 'commandSecret' | 'commandSecretPrevious',
    client: () => PrismaService['client']
  ): Target {
    return {
      id,
      resourceType: SealedResourceTypes.PLUGIN_INSTALLATION,
      format: SealedFormats.JSON,
      read: async (organizationId, cursor, take) => {
        const rows = await client().pluginInstallation.findMany({
          where: {
            store: { organizationId },
            ...(column === 'webhookSecret' ? { webhookSecret: { not: null } } : {}),
            ...(column === 'commandSecret' ? { commandSecret: { not: null } } : {}),
            ...(column === 'commandSecretPrevious' ? { commandSecretPrevious: { not: null } } : {}),
            ...after(cursor)
          },
          select: {
            id: true,
            webhookSecret: true,
            commandSecret: true,
            commandSecretPrevious: true
          },
          orderBy: { id: 'asc' },
          take
        })
        return rows.flatMap(r => {
          const sealed = r[column]
          return sealed === null ? [] : [{ id: r.id, sealed }]
        })
      },
      swap: async (organizationId, row, next) =>
        (
          await client().pluginInstallation.updateMany({
            where: { id: row.id, store: { organizationId }, [column]: asBytes(row.sealed) },
            data: { [column]: next }
          })
        ).count === 1
    }
  }
}
