import { Injectable } from '@nestjs/common'

import { isUniqueViolation, lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  type CreateRemittanceImportProfileBody,
  type RemittanceColumnRef,
  type RemittanceDateFormat,
  type RemittanceDecimalSeparator,
  type RemittanceDelimiter,
  type RemittanceImportMapping,
  type UpdateRemittanceImportProfileBody
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

export interface RemittanceImportProfileView {
  id: string
  connectionId: string
  name: string
  delimiter: RemittanceDelimiter
  hasHeader: boolean
  decimalSeparator: RemittanceDecimalSeparator
  dateFormat: RemittanceDateFormat
  columns: RemittanceImportMapping
  createdAt: string
  updatedAt: string
}

const SELECT = {
  id: true,
  connectionId: true,
  name: true,
  delimiter: true,
  hasHeader: true,
  decimalSeparator: true,
  dateFormat: true,
  columns: true,
  createdAt: true,
  updatedAt: true
} as const

interface Row {
  id: string
  connectionId: string
  name: string
  delimiter: string
  hasHeader: boolean
  decimalSeparator: string
  dateFormat: string
  columns: unknown
  createdAt: Date
  updatedAt: Date
}

export function profileViewOf(row: Row): RemittanceImportProfileView {
  return {
    id: row.id,
    connectionId: row.connectionId,
    name: row.name,
    delimiter: row.delimiter as RemittanceDelimiter,
    hasHeader: row.hasHeader,
    decimalSeparator: row.decimalSeparator as RemittanceDecimalSeparator,
    dateFormat: row.dateFormat as RemittanceDateFormat,
    columns: row.columns as RemittanceImportMapping,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

function hasNamedColumn(columns: Record<string, RemittanceColumnRef | undefined>): boolean {
  return Object.values(columns).some(ref => typeof ref === 'string')
}

// The saved mappings of a carrier's settlement file, one set per connection (TDD_17 §4.15). They are only how a file is read: no
// money moves through them, so the routes ask for remittances:manage and nothing is audited.
@Injectable()
export class RemittanceProfilesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(storeId: string, connectionId?: string): Promise<RemittanceImportProfileView[]> {
    const rows = await this.prisma.client.remittanceImportProfile.findMany({
      where: { storeId, ...(connectionId === undefined ? {} : { connectionId }) },
      select: SELECT,
      orderBy: [{ name: 'asc' }, { id: 'asc' }]
    })
    return rows.map(profileViewOf)
  }

  async create(
    storeId: string,
    body: CreateRemittanceImportProfileBody
  ): Promise<RemittanceImportProfileView> {
    try {
      const row = await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        const connection = await tx.carrierConnection.findFirst({
          where: { id: body.connectionId, storeId },
          select: { id: true }
        })
        if (connection === null) throw resourceNotFound('carrier connection')
        return tx.remittanceImportProfile.create({
          data: {
            storeId,
            connectionId: connection.id,
            name: body.name,
            delimiter: body.delimiter,
            hasHeader: body.hasHeader,
            decimalSeparator: body.decimalSeparator,
            dateFormat: body.dateFormat,
            columns: body.columns
          },
          select: SELECT
        })
      })
      return profileViewOf(row)
    } catch (error) {
      if (isUniqueViolation(error))
        throw resourceConflict('this carrier already has a profile with that name')
      throw error
    }
  }

  async update(
    storeId: string,
    profileId: string,
    body: UpdateRemittanceImportProfileBody
  ): Promise<RemittanceImportProfileView> {
    try {
      const row = await this.prisma.transaction(async tx => {
        await lockStoreForWrite(tx, storeId)
        const current = await tx.remittanceImportProfile.findFirst({
          where: { id: profileId, storeId },
          select: SELECT
        })
        if (current === null) throw resourceNotFound('import profile')
        const hasHeader = body.hasHeader ?? current.hasHeader
        const columns = body.columns ?? (current.columns as unknown as RemittanceImportMapping)
        // A file with no header can only be read by the position of its columns: the merged profile is checked, not the change
        if (!hasHeader && hasNamedColumn({ ...columns })) {
          throw new PlatformException(
            ErrorCodes.VALIDATION_FAILED,
            'a file with no header is mapped by column position',
            HttpStatusCodes.BAD_REQUEST
          )
        }
        const delimiter = body.delimiter ?? current.delimiter
        const decimalSeparator = body.decimalSeparator ?? current.decimalSeparator
        if (delimiter === decimalSeparator) {
          throw new PlatformException(
            ErrorCodes.VALIDATION_FAILED,
            'the delimiter and the decimal separator must differ',
            HttpStatusCodes.BAD_REQUEST
          )
        }
        return tx.remittanceImportProfile.update({
          where: { id: profileId },
          data: {
            ...(body.name === undefined ? {} : { name: body.name }),
            ...(body.delimiter === undefined ? {} : { delimiter: body.delimiter }),
            ...(body.hasHeader === undefined ? {} : { hasHeader: body.hasHeader }),
            ...(body.decimalSeparator === undefined
              ? {}
              : { decimalSeparator: body.decimalSeparator }),
            ...(body.dateFormat === undefined ? {} : { dateFormat: body.dateFormat }),
            ...(body.columns === undefined ? {} : { columns: body.columns })
          },
          select: SELECT
        })
      })
      return profileViewOf(row)
    } catch (error) {
      if (isUniqueViolation(error))
        throw resourceConflict('this carrier already has a profile with that name')
      throw error
    }
  }

  // The remittances that were read with it keep their lines and forget the profile (the database does it, in that column only)
  async remove(storeId: string, profileId: string): Promise<void> {
    await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const found = await tx.remittanceImportProfile.findFirst({
        where: { id: profileId, storeId },
        select: { id: true }
      })
      if (found === null) throw resourceNotFound('import profile')
      await tx.remittanceImportProfile.delete({ where: { id: profileId } })
    })
  }
}
