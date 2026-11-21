import { Injectable } from '@nestjs/common'

import { isUniqueViolation, JobContext, PrismaService } from '@platform/core/database'
import {
  type BankStatementEncoding,
  type BankStatementMapping,
  type BankStatementProfileShape,
  type BankThousandsSeparator,
  bankProfileProblem,
  BankStatementLimits,
  FinanceConflicts,
  type RemittanceDateFormat,
  type RemittanceDecimalSeparator,
  type RemittanceDelimiter
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { CreateBankProfileBody, UpdateBankProfileBody } from './finance-bank.schemas'
import { lockScope } from './finance.support'

export interface BankProfileView {
  id: string
  accountId: string
  name: string
  delimiter: RemittanceDelimiter
  hasHeader: boolean
  skipRows: number
  decimalSeparator: RemittanceDecimalSeparator
  thousandsSeparator: BankThousandsSeparator
  dateFormat: RemittanceDateFormat
  encoding: BankStatementEncoding
  dateWindowDays: number
  columns: BankStatementMapping
  createdAt: string
  updatedAt: string
}

const SELECT = {
  id: true,
  accountId: true,
  name: true,
  delimiter: true,
  hasHeader: true,
  skipRows: true,
  decimalSeparator: true,
  thousandsSeparator: true,
  dateFormat: true,
  encoding: true,
  dateWindowDays: true,
  columns: true,
  createdAt: true,
  updatedAt: true
} as const

interface Row {
  id: string
  accountId: string
  name: string
  delimiter: string
  hasHeader: boolean
  skipRows: number
  decimalSeparator: string
  thousandsSeparator: string
  dateFormat: string
  encoding: string
  dateWindowDays: number
  columns: unknown
  createdAt: Date
  updatedAt: Date
}

export function bankProfileView(row: Row): BankProfileView {
  return {
    id: row.id,
    accountId: row.accountId,
    name: row.name,
    delimiter: row.delimiter as RemittanceDelimiter,
    hasHeader: row.hasHeader,
    skipRows: row.skipRows,
    decimalSeparator: row.decimalSeparator as RemittanceDecimalSeparator,
    thousandsSeparator: row.thousandsSeparator as BankThousandsSeparator,
    dateFormat: row.dateFormat as RemittanceDateFormat,
    encoding: row.encoding as BankStatementEncoding,
    dateWindowDays: row.dateWindowDays,
    columns: row.columns as BankStatementMapping,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

// A saved profile is read again with the rules it was made with: one edited by hand, or saved before a rule changed, is refused with a
// clean answer and never read with a mapping that is not one
export function bankShapeOf(row: BankProfileView): BankStatementProfileShape {
  const columns = row.columns
  const problem = bankProfileProblem({
    hasHeader: row.hasHeader,
    delimiter: row.delimiter,
    decimalSeparator: row.decimalSeparator,
    thousandsSeparator: row.thousandsSeparator,
    columns: { ...columns }
  })
  if (problem !== null || typeof columns !== 'object' || columns === null) {
    throw new PlatformException(
      ErrorCodes.VALIDATION_FAILED,
      'the bank profile is not valid: edit it before importing',
      HttpStatusCodes.CONFLICT,
      { conflict: FinanceConflicts.BANK_PROFILE_INVALID }
    )
  }
  return {
    delimiter: row.delimiter,
    hasHeader: row.hasHeader,
    skipRows: row.skipRows,
    decimalSeparator: row.decimalSeparator,
    thousandsSeparator: row.thousandsSeparator,
    dateFormat: row.dateFormat,
    columns
  }
}

const nameInUse = () =>
  resourceConflict('the account already has a profile with that name', {
    conflict: FinanceConflicts.BANK_PROFILE_NAME_IN_USE
  })

// The saved mappings of the CSV of a bank, one set per cash, bank or wallet account (TDD_18 §4.4): how a file is read, nothing more. No
// money moves through them, so the routes ask for finance:reconcile and nothing is audited (like the profiles of a remittance file).
@Injectable()
export class FinanceBankProfilesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobContext
  ) {}

  async list(organizationId: string, accountId?: string): Promise<BankProfileView[]> {
    const rows = await this.prisma.client.bankImportProfile.findMany({
      where: { organizationId, ...(accountId === undefined ? {} : { accountId }) },
      select: SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }]
    })
    return rows.map(bankProfileView)
  }

  async create(
    organizationId: string,
    body: CreateBankProfileBody,
    actor: Actor
  ): Promise<BankProfileView> {
    try {
      const row = await this.prisma.transaction(async tx => {
        await lockScope(tx, `${organizationId}:bank_profiles:${body.accountId}`)
        const account = await tx.ledgerAccount.findFirst({
          where: { id: body.accountId, organizationId },
          select: { id: true, cashKind: true }
        })
        if (account === null) throw resourceNotFound('ledger account')
        if (account.cashKind === null) {
          throw resourceConflict(
            'a bank profile reads the file of a cash, bank or wallet account',
            {
              conflict: FinanceConflicts.BANK_ACCOUNT_NOT_CASH
            }
          )
        }
        const count = await tx.bankImportProfile.count({
          where: { organizationId, accountId: account.id }
        })
        if (count >= BankStatementLimits.MAX_PROFILES_PER_ACCOUNT) {
          throw resourceConflict('the account has as many profiles as it may', {
            conflict: FinanceConflicts.BANK_PROFILE_LIMIT
          })
        }
        return tx.bankImportProfile.create({
          data: {
            organizationId,
            accountId: account.id,
            name: body.name,
            delimiter: body.delimiter,
            hasHeader: body.hasHeader,
            skipRows: body.skipRows,
            decimalSeparator: body.decimalSeparator,
            thousandsSeparator: body.thousandsSeparator,
            dateFormat: body.dateFormat,
            encoding: body.encoding,
            dateWindowDays: body.dateWindowDays,
            columns: body.columns,
            createdBy: actor.userId
          },
          select: SELECT
        })
      })
      return bankProfileView(row)
    } catch (error) {
      if (isUniqueViolation(error)) throw nameInUse()
      throw error
    }
  }

  async update(
    organizationId: string,
    profileId: string,
    body: UpdateBankProfileBody
  ): Promise<BankProfileView> {
    try {
      const row = await this.prisma.transaction(async tx => {
        const current = await tx.bankImportProfile.findFirst({
          where: { id: profileId, organizationId },
          select: SELECT
        })
        if (current === null) throw resourceNotFound('bank import profile')
        // The profile the change would leave is held to the same rules as one that is created
        const problem = bankProfileProblem({
          hasHeader: body.hasHeader ?? current.hasHeader,
          delimiter: body.delimiter ?? current.delimiter,
          decimalSeparator: body.decimalSeparator ?? current.decimalSeparator,
          thousandsSeparator: body.thousandsSeparator ?? current.thousandsSeparator,
          columns: { ...(body.columns ?? (current.columns as unknown as BankStatementMapping)) }
        })
        if (problem !== null) {
          throw new PlatformException(
            ErrorCodes.VALIDATION_FAILED,
            problem,
            HttpStatusCodes.BAD_REQUEST
          )
        }
        return tx.bankImportProfile.update({
          where: { organizationId_id: { organizationId, id: profileId } },
          data: {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.delimiter === undefined ? {} : { delimiter: body.delimiter }),
            ...(body.hasHeader === undefined ? {} : { hasHeader: body.hasHeader }),
            ...(body.skipRows === undefined ? {} : { skipRows: body.skipRows }),
            ...(body.decimalSeparator === undefined
              ? {}
              : { decimalSeparator: body.decimalSeparator }),
            ...(body.thousandsSeparator === undefined
              ? {}
              : { thousandsSeparator: body.thousandsSeparator }),
            ...(body.dateFormat === undefined ? {} : { dateFormat: body.dateFormat }),
            ...(body.encoding === undefined ? {} : { encoding: body.encoding }),
            ...(body.dateWindowDays === undefined ? {} : { dateWindowDays: body.dateWindowDays }),
            ...(body.columns === undefined ? {} : { columns: body.columns })
          },
          select: SELECT
        })
      })
      return bankProfileView(row)
    } catch (error) {
      if (isUniqueViolation(error)) throw nameInUse()
      throw error
    }
  }

  // The imports that were read with it keep their lines and the id of the profile (a plain column: the evidence of how the file was
  // read, which outlives the profile)
  async remove(organizationId: string, profileId: string): Promise<void> {
    const removed = await this.prisma.client.bankImportProfile.deleteMany({
      where: { id: profileId, organizationId }
    })
    if (removed.count === 0) throw resourceNotFound('bank import profile')
  }

  // The profile an import is read with: of the organization or nothing
  async forImport(
    organizationId: string,
    storeId: string,
    profileId: string
  ): Promise<BankProfileView> {
    // Its own short unit: the route of the import is @NoTenantTransaction, so that no connection is held while the file arrives
    const row = await this.jobs.forStoreOrJoin(storeId, () =>
      this.prisma.client.bankImportProfile.findFirst({
        where: { id: profileId, organizationId },
        select: SELECT
      })
    )
    if (row === null) throw resourceNotFound('bank import profile')
    return bankProfileView(row)
  }
}
