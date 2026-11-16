import { createHash, randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  type BankRowError,
  BankStatementFiles,
  BankStatementLimits,
  type BankStatementProfileShape,
  BankStatementTransaction,
  FinanceConflicts,
  FinanceResourceTypes,
  MediaStatus,
  type ParsedBankLine,
  parseBankStatement,
  RemittanceDelimiters
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'
import { dateToDay, dayToDate } from '@platform/core/finance'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { MediaPurpose, sanitizeFilename, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import type { ImportBody } from '../remittances/remittance-import-body'
import type { Actor } from '../tenancy'

import { type BankProfileView, bankShapeOf } from './finance-bank-profiles.service'
import type { BankImportQuery, BankPreviewBody } from './finance-bank.schemas'
import { lockScope } from './finance.support'

export interface BankPreviewView {
  headers: string[]
  rowCount: number
  lines: ParsedBankLine[]
  errors: BankRowError[]
  errorCount: number
  dateFormatUndecided: boolean
}

export interface BankImportView {
  id: string
  accountId: string
  profileId: string | null
  mediaId: string
  lineCount: number
  newLineCount: number
  firstDay: string
  lastDay: string
  closingBalanceCents: number | null
  closingOn: string | null
  createdAt: string
}

const SELECT = {
  id: true,
  accountId: true,
  profileId: true,
  mediaId: true,
  lineCount: true,
  newLineCount: true,
  firstDay: true,
  lastDay: true,
  closingBalanceCents: true,
  closingOn: true,
  createdAt: true
} as const

const isoDay = dateToDay

export function bankImportView(row: {
  id: string
  accountId: string
  profileId: string | null
  mediaId: string
  lineCount: number
  newLineCount: number
  firstDay: Date
  lastDay: Date
  closingBalanceCents: number | null
  closingOn: Date | null
  createdAt: Date
}): BankImportView {
  return {
    id: row.id,
    accountId: row.accountId,
    profileId: row.profileId,
    mediaId: row.mediaId,
    lineCount: row.lineCount,
    newLineCount: row.newLineCount,
    firstDay: isoDay(row.firstDay),
    lastDay: isoDay(row.lastDay),
    closingBalanceCents: row.closingBalanceCents,
    closingOn: row.closingOn === null ? null : isoDay(row.closingOn),
    createdAt: row.createdAt.toISOString()
  }
}

// What makes a line of a statement the same line when it comes again: the account, the day, the amount, the reference and the
// description, and which of the equal ones it is in its file (two identical lines of a statement are two movements). A statement that
// overlaps the last one therefore never doubles what it repeats.
export function bankLineHash(accountId: string, line: ParsedBankLine): string {
  return createHash('sha256')
    .update(
      [
        accountId,
        line.postedOn,
        String(line.amountCents),
        line.reference ?? '',
        line.description ?? '',
        String(line.occurrence)
      ].join('\u0000')
    )
    .digest('hex')
}

// The import of the CSV a bank gives (TDD_18 §4.4): read with the saved profile of the account, strictly (one bad row refuses the whole
// file and says which), kept as the evidence (a `Media` of purpose FINANCE_DOCUMENT with no parent, scanned like any file from outside)
// and turned into statement lines. Nothing is matched, posted or reconciled by it: the matching is suggested on reading and a person
// decides.
@Injectable()
export class FinanceBankImportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>
  ) {}

  // The mapper: a sample read with the mapping being tried; no file, no import and no profile is written
  preview(body: BankPreviewBody): BankPreviewView {
    const parsed = parseBankStatement(
      body.text,
      {
        delimiter: body.profile.delimiter,
        hasHeader: body.profile.hasHeader,
        decimalSeparator: body.profile.decimalSeparator,
        thousandsSeparator: body.profile.thousandsSeparator,
        dateFormat: body.profile.dateFormat,
        columns: body.profile.columns
      },
      { maxRows: BankStatementLimits.PREVIEW_ROWS, partial: true }
    )
    return {
      headers: parsed.headers,
      rowCount: parsed.rowCount,
      lines: parsed.lines,
      errors: parsed.errors,
      errorCount: parsed.errorCount,
      dateFormatUndecided: parsed.dateFormatUndecided
    }
  }

  async list(
    organizationId: string,
    accountId: string | undefined,
    limit: number
  ): Promise<BankImportView[]> {
    const rows = await this.prisma.client.bankStatementImport.findMany({
      where: { organizationId, ...(accountId === undefined ? {} : { accountId }) },
      select: SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit
    })
    return rows.map(bankImportView)
  }

  async get(organizationId: string, importId: string): Promise<BankImportView> {
    const row = await this.prisma.client.bankStatementImport.findFirst({
      where: { id: importId, organizationId },
      select: SELECT
    })
    if (row === null) throw resourceNotFound('bank statement import')
    return bankImportView(row)
  }

  async importFile(
    organizationId: string,
    storeId: string,
    query: BankImportQuery,
    profile: BankProfileView,
    file: ImportBody,
    actor: Actor
  ): Promise<BankImportView> {
    const shape: BankStatementProfileShape = bankShapeOf(profile)
    const parsed = parseBankStatement(file.text, shape)
    if (parsed.errorCount > 0) {
      throw new PlatformException(
        ErrorCodes.BANK_STATEMENT_INVALID,
        'the file has rows that cannot be read',
        HttpStatusCodes.BAD_REQUEST,
        { errorCount: parsed.errorCount, errors: parsed.errors }
      )
    }
    const days = parsed.lines.map(line => line.postedOn).sort()
    const firstDay = days[0]
    const lastDay = days[days.length - 1]
    if (firstDay === undefined || lastDay === undefined) {
      throw new PlatformException(
        ErrorCodes.BANK_STATEMENT_INVALID,
        'the file has no lines',
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const hashed = parsed.lines.map(line => ({ line, hash: bankLineHash(profile.accountId, line) }))

    // A file whose lines are all known is refused before anything is uploaded (the check inside the transaction stays: it is the one
    // that holds when two files arrive at the same moment)
    const known = await this.prisma.client.bankStatementLine.count({
      where: {
        organizationId,
        accountId: profile.accountId,
        lineHash: { in: hashed.map(entry => entry.hash) }
      }
    })
    if (known === hashed.length) {
      throw resourceConflict('every line of the file was imported before', {
        conflict: FinanceConflicts.BANK_IMPORT_NOTHING_NEW
      })
    }

    // A statement is never changed once it is kept, and a day written 03/11/2026 reads as 3 November or 11 March: when no date of the file
    // can say which, the person says it (the screen shows the days that were read) instead of the profile being trusted in silence
    if (parsed.dateFormatUndecided && query.dateFormatConfirmed !== true) {
      throw resourceConflict('the order of the day and the month of the file is not confirmed', {
        conflict: FinanceConflicts.BANK_DATE_FORMAT_UNCONFIRMED,
        dateFormat: profile.dateFormat,
        firstDay,
        lastDay
      })
    }

    const bytes = file.bytes
    const mediaId = randomUUID()
    const kind =
      profile.delimiter === String(RemittanceDelimiters.TAB)
        ? BankStatementFiles.TSV
        : BankStatementFiles.CSV
    const filename = sanitizeFilename(
      `${BankStatementFiles.FILENAME_PREFIX}-${new Date().toISOString().slice(0, 10)}.${kind.extension}`
    )
    const key = StorageKeys.bankStatementFile(storeId, mediaId, filename)
    await this.storage.put(key, bytes, kind.contentType)
    // Once the import exists the file is its evidence and is never removed, whatever fails after
    let imported = false
    try {
      await this.prisma.client.media.create({
        data: {
          id: mediaId,
          storeId,
          purpose: MediaPurpose.FINANCE_DOCUMENT,
          uploadedBy: actor.userId,
          key,
          filename,
          contentType: kind.contentType,
          fileSize: bytes.length,
          status: MediaStatus.PENDING
        }
      })
      const created = await this.prisma.transaction(async tx => {
        // Imports into one account take turns, so two files that repeat the same lines cannot both bring them
        await lockScope(tx, `${organizationId}:bank_import:${profile.accountId}`)
        const knownHashes = new Set(
          (
            await tx.bankStatementLine.findMany({
              where: {
                organizationId,
                accountId: profile.accountId,
                lineHash: { in: hashed.map(entry => entry.hash) }
              },
              select: { lineHash: true }
            })
          ).map(row => row.lineHash)
        )
        const fresh = hashed.filter(entry => !knownHashes.has(entry.hash))
        if (fresh.length === 0) {
          throw resourceConflict('every line of the file was imported before', {
            conflict: FinanceConflicts.BANK_IMPORT_NOTHING_NEW
          })
        }
        const row = await tx.bankStatementImport.create({
          data: {
            organizationId,
            accountId: profile.accountId,
            profileId: profile.id,
            mediaId,
            lineCount: hashed.length,
            newLineCount: fresh.length,
            firstDay: dayToDate(firstDay),
            lastDay: dayToDate(lastDay),
            ...(query.closingBalanceCents === undefined || query.closingOn === undefined
              ? {}
              : {
                  closingBalanceCents: query.closingBalanceCents,
                  closingOn: dayToDate(query.closingOn)
                }),
            createdBy: actor.userId
          },
          select: SELECT
        })
        await tx.bankStatementLine.createMany({
          data: fresh.map(entry => ({
            organizationId,
            importId: row.id,
            accountId: profile.accountId,
            lineNo: entry.line.row,
            postedOn: dayToDate(entry.line.postedOn),
            amountCents: entry.line.amountCents,
            description: entry.line.description,
            reference: entry.line.reference,
            lineHash: entry.hash
          }))
        })
        return row
      }, BankStatementTransaction)
      imported = true
      // A scan that was not queued waits for the hourly cleanup of pending files: it must not fail an import that was made
      await this.heavyQueue
        .add(JobNames.SCAN_FILE, { mediaId }, { jobId: `${JobNames.SCAN_FILE}-${mediaId}` })
        .catch(() => undefined)
      this.audit.log({
        action: AuditAction.FINANCE_BANK_STATEMENT_IMPORTED,
        actor: { userId: actor.userId },
        organizationId,
        storeId,
        resourceType: FinanceResourceTypes.BANK_IMPORT,
        resourceId: created.id,
        metadata: {
          accountId: profile.accountId,
          profileId: profile.id,
          lines: hashed.length,
          newLines: created.newLineCount,
          // The person said the order of the day and the month, when every date of the file read in both
          dateFormatConfirmed: parsed.dateFormatUndecided,
          mediaId
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
      return bankImportView(created)
    } catch (error) {
      if (imported) throw error
      // An error that came after the commit (a dropped connection on the way back) is not "nothing was made": the import exists, and
      // its file is its evidence
      const exists = await this.prisma.client.bankStatementImport
        .findFirst({ where: { mediaId, organizationId }, select: { id: true } })
        .catch(() => ({ id: 'unknown' }))
      if (exists !== null) throw error
      // Nothing was made of the file: it is removed, never left behind
      await this.prisma.client.media
        .deleteMany({ where: { id: mediaId, storeId } })
        .catch(() => undefined)
      await this.storage.delete(key).catch(() => undefined)
      // The unique index of the hash is what holds when another request brought the same line at the same moment
      if (isUniqueViolation(error)) {
        throw resourceConflict('the lines of the file were imported at the same moment', {
          conflict: FinanceConflicts.BANK_IMPORT_NOTHING_NEW
        })
      }
      throw error
    }
  }
}
