import { isDeepStrictEqual } from 'node:util'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher, DecryptionError, failureOf, SealedWith } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  FISCAL_RESEAL_MISMATCH,
  FISCAL_RESEAL_WRITE_FAILED,
  FiscalReseal,
  FiscalResealOutcome,
  FiscalResourceTypes,
  SealedValueKind
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'

import { maskColumnsOf, receiverOf } from './fiscal-rules'

// The value sealed again did not open to the same content (never carries the content)
class ResealMismatchError extends Error {
  constructor() {
    super('the value sealed again does not open to the same content')
    this.name = 'ResealMismatchError'
  }
}

// What one run of one organization did, by the kind of value. Counts only: never a value, never a fragment of one.
export interface FiscalResealReport {
  // False when no previous key is held: there is nothing to re-seal and nothing is read
  enabled: boolean
  // Values read, values that already opened with the current key, values sealed again, values a concurrent change left alone
  scanned: number
  current: number
  resealed: number
  // Documents whose masked receiver was calculated by this run (Step 7.3-S11b-2)
  masked: number
  // Receivers that opened with no key for the mask (a damaged row, a retired key), by code. Apart from `failed` on purpose: a row that can
  // never get a mask is tried again every night, and must not fail the job of the books for ever (the screens open such a row as before)
  maskFailed: Record<string, number>
  conflicts: number
  // Values that opened with neither key (or could not be sealed again): left exactly as they were, by the code of the failure
  failed: Record<string, number>
  // A kind that hit the cap of one run (the next run goes on from the start: what is done is skipped quickly)
  truncated: boolean
}

// The unit of work the caller opens: one short transaction in the context of the organization. A value that fails aborts only its own.
export type FiscalResealUnit = <T>(work: () => Promise<T>) => Promise<T>

interface SealedRow {
  id: string
  // The bytes of the value (and the second one of a document), as read
  sealed: Uint8Array
  payload?: Uint8Array | null
}

const emptyReport = (enabled: boolean): FiscalResealReport => ({
  enabled,
  scanned: 0,
  current: 0,
  resealed: 0,
  masked: 0,
  maskFailed: {},
  conflicts: 0,
  failed: {},
  truncated: false
})

// The re-seal of a rotation of CREDENTIALS_ENCRYPTION_KEY (Step 7.3-S11b): every sealed value of the fiscal area that opens only with the
// previous key is sealed again with the current one. It never removes or rewrites a value that it cannot open (the failure is counted and
// the row stays as it is: a value is never lost), it checks in the same transaction that the new value opens to exactly the same content
// before writing it, it writes by compare-and-swap (the old bytes are in the WHERE), and it is idempotent: a value that already opens with
// the current key is skipped, so a run that stopped half way, or runs twice, ends in the same state. It runs only while a previous key is held.
//
// Covered: the receiver and the built payload of the fiscal documents (a decided document goes through the function of the migration that the
// guard recognises; nothing else can change it), the fiscal data of the customers, the credentials of the issuer and the responsible of a
// contingency. NOT covered (Step 7.3-S11c): the sealed values outside the fiscal area; the previous key does not serve them.
@Injectable()
export class FiscalResealService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalResealService.name)
  }

  async run(organizationId: string, unit: FiscalResealUnit): Promise<FiscalResealReport> {
    // Without a previous key there is nothing to seal again; the masks of the receivers are still calculated
    const report = emptyReport(this.cipher.hasPreviousKey)
    if (!this.cipher.hasPreviousKey) {
      await this.maskMissing(organizationId, unit, report)
      return report
    }
    const kinds = [
      SealedValueKind.ISSUER_CREDENTIALS,
      SealedValueKind.CUSTOMER_DATA,
      SealedValueKind.RESPONSIBLE,
      SealedValueKind.RECEIVER
    ] as const
    for (const kind of kinds) {
      let after: string | undefined
      // Values of this kind sealed again or failed in this run (the ones already current are skipped and do not count against the cap)
      let worked = 0
      for (;;) {
        const rows = await unit(() => this.read(kind, organizationId, after))
        for (const row of rows) {
          if (worked >= FiscalReseal.MAX_VALUES_PER_KIND) {
            report.truncated = true
            break
          }
          report.scanned += 1
          try {
            const outcome = await unit(() => this.reseal(kind, organizationId, row))
            if (outcome === FiscalResealOutcome.CURRENT) {
              report.current += 1
              continue
            }
            worked += 1
            if (outcome === FiscalResealOutcome.CONFLICT) {
              report.conflicts += 1
              continue
            }
            report.resealed += 1
            // After the unit resolved: an entry for a swap that was rolled back would be false evidence
            this.audit.log({
              action: AuditAction.FISCAL_VALUE_RESEALED,
              actor: { system: true },
              organizationId,
              resourceType: resourceTypeOf(kind),
              resourceId: row.id,
              // The kind and how many values of the row were sealed again: never a value
              metadata: { kind, values: row.payload == null ? 1 : 2 }
            })
          } catch (error) {
            worked += 1
            // One value that cannot be handled must not stop the others: it is counted by the code of the failure and left as it was. A
            // cipher failure has its own code; anything else (a write the database refused) is `write_failed`, not a damaged row
            const code =
              error instanceof DecryptionError
                ? failureOf(error)
                : error instanceof ResealMismatchError
                  ? FISCAL_RESEAL_MISMATCH
                  : FISCAL_RESEAL_WRITE_FAILED
            report.failed[code] = (report.failed[code] ?? 0) + 1
            this.logger.error(
              {
                errorName: errorName(error),
                failure: code,
                what: kind,
                organizationId,
                rowId: row.id
              },
              'a sealed fiscal value was not sealed again'
            )
          }
        }
        const last = rows.at(-1)
        if (report.truncated || rows.length < FiscalReseal.PAGE_SIZE || last === undefined) break
        after = last.id
      }
    }
    await this.maskMissing(organizationId, unit, report)
    return report
  }

  // The masked receiver of the documents that have none yet (Step 7.3-S11b-2). It runs AFTER the re-seal, opens with the CURRENT key alone (what
  // the previous key opens was just sealed again; a value no key opens is left with no mask and counted by its code, never guessed), and
  // writes through the function of the migration (the door of the guard) by compare-and-swap. The filter on the missing mask is the cursor:
  // a run that stopped goes on from where it was, and a second run finds nothing.
  private async maskMissing(
    organizationId: string,
    unit: FiscalResealUnit,
    report: FiscalResealReport
  ): Promise<void> {
    // The cap counts the masks written (or lost to a conflict); a row nobody opens only costs a read, so a thousand of them at the front never
    // starve the healthy ones behind. The reads have their own, larger cap.
    let worked = 0
    let read = 0
    let after: string | undefined
    for (;;) {
      const rows = await unit(() =>
        this.prisma.client.fiscalDocument.findMany({
          where: {
            organizationId,
            receiverMaskedAt: null,
            ...(after === undefined ? {} : { id: { gt: after } })
          },
          select: { id: true, receiverEncrypted: true },
          orderBy: { id: 'asc' },
          take: FiscalReseal.PAGE_SIZE
        })
      )
      for (const row of rows) {
        if (worked >= FiscalReseal.MAX_VALUES_PER_KIND || read >= FiscalReseal.MAX_MASK_ROWS_READ) {
          report.truncated = true
          return
        }
        read += 1
        try {
          const done = await unit(async () => {
            const columns = maskColumnsOf(receiverOf(this.cipher.open(row.receiverEncrypted)))
            const answer = await this.prisma.client.$queryRaw<{ changed: boolean }[]>`
              SELECT fiscal_mask_document(
                ${organizationId}, ${row.id}, ${row.receiverEncrypted}::bytea, ${columns.receiverNameMasked}, ${columns.receiverTaxIdMasked}
              ) AS changed`
            return answer[0]?.changed === true
          })
          worked += 1
          if (done) report.masked += 1
          else report.conflicts += 1
        } catch (error) {
          const code =
            error instanceof DecryptionError ? failureOf(error) : FISCAL_RESEAL_WRITE_FAILED
          const seen = Object.values(report.maskFailed).reduce((sum, n) => sum + n, 0)
          report.maskFailed[code] = (report.maskFailed[code] ?? 0) + 1
          // The first few of a run name their row; a night full of them is one line per row for nothing
          if (seen < FiscalReseal.MAX_MASK_FAILURES_LOGGED) {
            this.logger.warn(
              {
                errorName: errorName(error),
                failure: code,
                what: SealedValueKind.RECEIVER,
                organizationId,
                rowId: row.id
              },
              'the masked receiver of a document was not calculated'
            )
          }
        }
      }
      const last = rows.at(-1)
      if (rows.length < FiscalReseal.PAGE_SIZE || last === undefined) return
      after = last.id
    }
  }

  // One page of one kind of value of the organization, by id
  private async read(
    kind: SealedValueKind,
    organizationId: string,
    after: string | undefined
  ): Promise<SealedRow[]> {
    const cursor = after === undefined ? {} : { id: { gt: after } }
    const take = FiscalReseal.PAGE_SIZE
    const client = this.prisma.client
    switch (kind) {
      case SealedValueKind.RECEIVER: {
        const rows = await client.fiscalDocument.findMany({
          where: { organizationId, ...cursor },
          select: { id: true, receiverEncrypted: true, builtPayloadEncrypted: true },
          orderBy: { id: 'asc' },
          take
        })
        return rows.map(r => ({
          id: r.id,
          sealed: r.receiverEncrypted,
          payload: r.builtPayloadEncrypted
        }))
      }
      case SealedValueKind.CUSTOMER_DATA: {
        const rows = await client.customerFiscalData.findMany({
          where: { store: { organizationId }, ...cursor },
          select: { id: true, dataEncrypted: true },
          orderBy: { id: 'asc' },
          take
        })
        return rows.map(r => ({ id: r.id, sealed: r.dataEncrypted }))
      }
      case SealedValueKind.ISSUER_CREDENTIALS: {
        const rows = await client.fiscalIssuer.findMany({
          where: { organizationId, credentialsEncrypted: { not: null } },
          select: { organizationId: true, credentialsEncrypted: true },
          take: 1
        })
        // One issuer per organization: its key is the organization, so the row id of the report is that
        return rows.flatMap(r =>
          r.credentialsEncrypted === null
            ? []
            : [{ id: r.organizationId, sealed: r.credentialsEncrypted }]
        )
      }
      case SealedValueKind.RESPONSIBLE: {
        const rows = await client.fiscalContingency.findMany({
          where: { organizationId, responsibleEncrypted: { not: null }, ...cursor },
          select: { id: true, responsibleEncrypted: true },
          orderBy: { id: 'asc' },
          take
        })
        return rows.flatMap(r =>
          r.responsibleEncrypted === null ? [] : [{ id: r.id, sealed: r.responsibleEncrypted }]
        )
      }
      default:
        return []
    }
  }

  // One value (and, for a document, its payload), inside the unit of the caller: open, seal again, check, swap, audit
  private async reseal(
    kind: SealedValueKind,
    organizationId: string,
    row: SealedRow
  ): Promise<FiscalResealOutcome> {
    const first = this.cipher.openRotating(row.sealed)
    const second =
      kind === SealedValueKind.RECEIVER && row.payload != null
        ? this.cipher.openRotating(row.payload)
        : null
    // Both values of a document must be read before anything is written: a document with one value that opens with neither key is left whole
    if (
      first.sealedWith === SealedWith.CURRENT &&
      (second?.sealedWith ?? SealedWith.CURRENT) === SealedWith.CURRENT
    ) {
      return FiscalResealOutcome.CURRENT
    }
    const next = new Uint8Array(this.cipher.seal(first.credentials))
    const nextPayload =
      second === null ? null : new Uint8Array(this.cipher.seal(second.credentials))
    // What was sealed again must open, with the current key alone, to the very same content (the same transaction, before the write)
    if (!isDeepStrictEqual(this.cipher.open(next), first.credentials)) {
      throw new ResealMismatchError()
    }
    if (
      second !== null &&
      nextPayload !== null &&
      !isDeepStrictEqual(this.cipher.open(nextPayload), second.credentials)
    ) {
      throw new ResealMismatchError()
    }
    const swapped = await this.swap(kind, organizationId, row, next, nextPayload)
    return swapped ? FiscalResealOutcome.RESEALED : FiscalResealOutcome.CONFLICT
  }

  private async swap(
    kind: SealedValueKind,
    organizationId: string,
    row: SealedRow,
    next: Uint8Array,
    nextPayload: Uint8Array | null
  ): Promise<boolean> {
    const client = this.prisma.client
    switch (kind) {
      case SealedValueKind.RECEIVER: {
        // A decided document cannot be updated by a table write: the function of the migration swaps the two columns and nothing else
        const answer = await client.$queryRaw<{ changed: boolean }[]>`
          SELECT fiscal_reseal_document(
            ${organizationId}, ${row.id}, ${row.sealed}::bytea, ${next}::bytea, ${row.payload ?? null}::bytea, ${nextPayload}::bytea
          ) AS changed`
        return answer[0]?.changed === true
      }
      case SealedValueKind.CUSTOMER_DATA:
        return (
          (
            await client.customerFiscalData.updateMany({
              where: {
                id: row.id,
                store: { organizationId },
                dataEncrypted: row.sealed as Uint8Array<ArrayBuffer>
              },
              data: { dataEncrypted: next as Uint8Array<ArrayBuffer> }
            })
          ).count === 1
        )
      case SealedValueKind.ISSUER_CREDENTIALS:
        return (
          (
            await client.fiscalIssuer.updateMany({
              where: {
                organizationId,
                credentialsEncrypted: row.sealed as Uint8Array<ArrayBuffer>
              },
              data: { credentialsEncrypted: next as Uint8Array<ArrayBuffer> }
            })
          ).count === 1
        )
      case SealedValueKind.RESPONSIBLE: {
        // A reported contingency never changes through a table write: the function of the migration swaps this one column
        const answer = await client.$queryRaw<{ changed: boolean }[]>`
          SELECT fiscal_reseal_contingency(${organizationId}, ${row.id}, ${row.sealed}::bytea, ${next}::bytea) AS changed`
        return answer[0]?.changed === true
      }
      default:
        return false
    }
  }
}

function resourceTypeOf(kind: SealedValueKind): string {
  switch (kind) {
    case SealedValueKind.RECEIVER:
    case SealedValueKind.BUILT_PAYLOAD:
      return FiscalResourceTypes.DOCUMENT
    case SealedValueKind.CUSTOMER_DATA:
      return FiscalResourceTypes.CUSTOMER_DATA
    case SealedValueKind.ISSUER_CREDENTIALS:
      return FiscalResourceTypes.ISSUER
    default:
      return FiscalResourceTypes.CONTINGENCY
  }
}
