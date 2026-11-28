import { randomUUID } from 'node:crypto'

import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  type CreateExcludedSubjectPurchaseBody,
  excludedSubjectAmountOf,
  ExcludedSubjectConflicts,
  ExcludedSubjectProblems,
  ExcludedSubjectResourceTypes,
  maskReceiverName,
  maskReceiverTaxId,
  withheldIncomeTaxOf
} from '@platform/core/domain'
import { errorName, resourceConflict, resourceNotFound } from '@platform/core/errors'
import { dateToDay, dayToDate } from '@platform/core/finance'
import { FiscalPurchaseDocumentService } from '@platform/fiscal/runtime'

import { encodeCursor } from '../customers/list-cursor'
import { lockScope } from '../finance/finance.support'
import type { Actor } from '../tenancy'

import type { ListExcludedSubjectPurchasesQuery } from './purchases.schemas'
import { invalidPurchase, latestDay } from './purchases.support'

const SELECT = {
  id: true,
  purchasedOn: true,
  sellerDocumentType: true,
  sellerEncrypted: true,
  documentSeries: true,
  generationCode: true,
  amountCents: true,
  vatWithheldCents: true,
  incomeTaxWithheldCents: true,
  operationType: true,
  expenseClass: true,
  sector: true,
  costType: true,
  createdAt: true,
  lines: {
    orderBy: { lineNo: 'asc' },
    select: { lineNo: true, description: true, kind: true, amountCents: true }
  }
} as const

const readOne = (prisma: PrismaService, organizationId: string, id: string) =>
  prisma.client.excludedSubjectPurchase.findFirst({
    where: { id, organizationId },
    select: SELECT
  })
type Row = Awaited<ReturnType<typeof readOne>>

// What a person is shown: the seller as a MASK (a natural person's name and identity document are read whole only by the annex of the return,
// never by a list), the concepts and the figures the buyer declared
export interface ExcludedSubjectPurchaseView {
  id: string
  purchasedOn: string
  seller: { documentType: string; nameMasked: string | null; documentMasked: string | null }
  documentSeries: string | null
  generationCode: string | null
  amountCents: number
  vatWithheldCents: number
  incomeTaxWithheldCents: number
  operationType: string
  expenseClass: string
  sector: string
  costType: string
  createdAt: string
  lines: { lineNo: number; description: string; kind: string; amountCents: number }[]
}
export interface ExcludedSubjectPurchasePage {
  data: ExcludedSubjectPurchaseView[]
  nextCursor: string | null
  hasMore: boolean
}

// The seller as it was written: the number of the identity document and the name
interface Seller {
  documentNumber: string
  name: string
}

function view(row: NonNullable<Row>, seller: Seller | null): ExcludedSubjectPurchaseView {
  return {
    id: row.id,
    purchasedOn: dateToDay(row.purchasedOn),
    seller: {
      documentType: row.sellerDocumentType,
      nameMasked: maskReceiverName(seller?.name),
      documentMasked: maskReceiverTaxId(seller?.documentNumber)
    },
    documentSeries: row.documentSeries,
    generationCode: row.generationCode,
    amountCents: row.amountCents,
    vatWithheldCents: row.vatWithheldCents,
    incomeTaxWithheldCents: row.incomeTaxWithheldCents,
    operationType: row.operationType,
    expenseClass: row.expenseClass,
    sector: row.sector,
    costType: row.costType,
    createdAt: row.createdAt.toISOString(),
    lines: row.lines.map(line => ({ ...line }))
  }
}

// The code of generation is stored in capitals, the way the authority writes it
const normalizedCode = (code: string | undefined): string | null =>
  code === undefined ? null : code.toUpperCase()

// Purchases from an excluded subject (D20b): the record of what the buyer paid to a seller who is not a taxpayer of the VAT, against the invoice
// of an excluded subject the buyer issues (article 119 of the Tax Code). Organization-scoped: the organization is the guard's, never the body's.
// The income tax the buyer withheld is computed here from the concepts (articles 154 and 156), never taken from the request. A record is never
// edited or deleted (the database refuses): a mistake is a new record, and the annex of the return reads what was written.
@Injectable()
export class ExcludedSubjectPurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly documents: FiscalPurchaseDocumentService,
    private readonly cipher: CredentialCipher,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ExcludedSubjectPurchasesService.name)
  }

  // The seller of a row, opened for a mask or for a comparison. A value that no key opens is logged by the name of the error and the id of the
  // row, never by what it says, and shows no mask: the list goes on.
  private sellerOf(row: { id: string; sellerEncrypted: Uint8Array }): Seller | null {
    try {
      const opened = this.cipher.openRotating(row.sellerEncrypted).credentials
      const { documentNumber, name } = opened
      return typeof documentNumber === 'string' && typeof name === 'string'
        ? { documentNumber, name }
        : null
    } catch (error) {
      this.logger.error(
        { errorName: errorName(error), rowId: row.id },
        'the sealed seller of a purchase from an excluded subject cannot be opened'
      )
      return null
    }
  }

  async create(
    organizationId: string,
    body: CreateExcludedSubjectPurchaseBody,
    actor: Actor
  ): Promise<ExcludedSubjectPurchaseView> {
    const amountCents = excludedSubjectAmountOf(body.lines)
    const incomeTaxWithheldCents = withheldIncomeTaxOf(body.lines)
    // A purchase is never dated after today (with the day of slack of the clock of a person)
    if (body.purchasedOn > latestDay()) {
      throw invalidPurchase([ExcludedSubjectProblems.PURCHASED_IN_THE_FUTURE])
    }
    const made = await this.prisma.transaction(async tx => {
      // Two requests with one key at once do not both pass: the second waits here until the first has committed, then finds it
      await lockScope(tx, `${organizationId}:excluded_subject:${body.idempotencyKey}`)
      const earlier = await tx.excludedSubjectPurchase.findUnique({
        where: {
          organizationId_clientKey: { organizationId, clientKey: body.idempotencyKey }
        },
        select: SELECT
      })
      if (earlier !== null) {
        if (
          !sameRequest(earlier, this.sellerOf(earlier), body, amountCents, incomeTaxWithheldCents)
        ) {
          throw resourceConflict('the key of the request belongs to another purchase', {
            conflict: ExcludedSubjectConflicts.KEY_REUSED
          })
        }
        return { row: earlier, replayed: true }
      }
      const problems = await this.documents.excludedSubjectProblems(tx, organizationId, {
        purchasedOn: body.purchasedOn,
        sellerDocumentType: body.seller.documentType,
        sellerDocumentNumber: body.seller.documentNumber,
        documentSeries: body.documentSeries ?? null,
        generationCode: body.generationCode ?? null,
        amountCents,
        vatWithheldCents: body.vatWithheldCents,
        operationType: body.operationType,
        expenseClass: body.expenseClass,
        sector: body.sector,
        costType: body.costType
      })
      if (problems.length > 0) throw invalidPurchase(problems)
      const code = normalizedCode(body.generationCode)
      if (code !== null) {
        // Two requests with one invoice do not both pass: it would be declared twice
        await lockScope(tx, `${organizationId}:excluded_subject_code:${code}`)
        const other = await tx.excludedSubjectPurchase.findFirst({
          where: { organizationId, generationCode: code },
          select: { id: true }
        })
        if (other !== null) {
          throw resourceConflict('the invoice is already on another purchase', {
            conflict: ExcludedSubjectConflicts.GENERATION_CODE_IN_USE
          })
        }
      }
      const id = randomUUID()
      await tx.excludedSubjectPurchase.create({
        data: {
          id,
          organizationId,
          clientKey: body.idempotencyKey,
          purchasedOn: dayToDate(body.purchasedOn),
          sellerDocumentType: body.seller.documentType,
          sellerEncrypted: new Uint8Array(
            this.cipher.seal({ documentNumber: body.seller.documentNumber, name: body.seller.name })
          ),
          documentSeries: body.documentSeries ?? null,
          generationCode: code,
          amountCents,
          vatWithheldCents: body.vatWithheldCents,
          incomeTaxWithheldCents,
          operationType: body.operationType,
          expenseClass: body.expenseClass,
          sector: body.sector,
          costType: body.costType,
          createdBy: actor.userId
        },
        select: { id: true }
      })
      await tx.excludedSubjectPurchaseLine.createMany({
        data: body.lines.map((line, index) => ({
          organizationId,
          purchaseId: id,
          lineNo: index + 1,
          description: line.description,
          kind: line.kind,
          amountCents: line.amountCents
        }))
      })
      const row = await tx.excludedSubjectPurchase.findFirstOrThrow({
        where: { id, organizationId },
        select: SELECT
      })
      return { row, replayed: false }
    })
    if (!made.replayed) {
      // The figures and the codes, never the name or the document of the seller (a person's data stays out of the trail)
      this.audit.log({
        action: AuditAction.EXCLUDED_SUBJECT_PURCHASE_RECORDED,
        actor: { userId: actor.userId },
        organizationId,
        storeId: actor.storeId,
        resourceType: ExcludedSubjectResourceTypes.EXCLUDED_SUBJECT_PURCHASE,
        resourceId: made.row.id,
        metadata: {
          purchasedOn: body.purchasedOn,
          amountCents,
          vatWithheldCents: body.vatWithheldCents,
          incomeTaxWithheldCents,
          lines: body.lines.length,
          electronic: made.row.generationCode !== null
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return view(made.row, this.sellerOf(made.row))
  }

  async get(organizationId: string, id: string): Promise<ExcludedSubjectPurchaseView> {
    const row = await readOne(this.prisma, organizationId, id)
    if (row === null) throw resourceNotFound('excluded subject purchase')
    return view(row, this.sellerOf(row))
  }

  async list(
    organizationId: string,
    query: ListExcludedSubjectPurchasesQuery
  ): Promise<ExcludedSubjectPurchasePage> {
    const { cursor } = query
    const rows = await this.prisma.client.excludedSubjectPurchase.findMany({
      where: {
        organizationId,
        ...(cursor === undefined
          ? {}
          : {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } }
              ]
            })
      },
      select: SELECT,
      take: query.limit + 1,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
    })
    const hasMore = rows.length > query.limit
    const page = hasMore ? rows.slice(0, query.limit) : rows
    const last = page.at(-1)
    return {
      data: page.map(row => view(row, this.sellerOf(row))),
      nextCursor: hasMore && last !== undefined ? encodeCursor(last) : null,
      hasMore
    }
  }
}

// The same key with the same content is the same request; with another content it is a mistake of the client
function sameRequest(
  row: NonNullable<Row>,
  seller: Seller | null,
  body: CreateExcludedSubjectPurchaseBody,
  amountCents: number,
  incomeTaxWithheldCents: number
): boolean {
  return (
    dateToDay(row.purchasedOn) === body.purchasedOn &&
    row.sellerDocumentType === body.seller.documentType &&
    // A seller that no key opens cannot be compared: the rest of the request decides, so a retry of a lost answer is still the same request
    (seller === null ||
      (seller.documentNumber === body.seller.documentNumber && seller.name === body.seller.name)) &&
    row.documentSeries === (body.documentSeries ?? null) &&
    row.generationCode === normalizedCode(body.generationCode) &&
    row.amountCents === amountCents &&
    row.vatWithheldCents === body.vatWithheldCents &&
    row.incomeTaxWithheldCents === incomeTaxWithheldCents &&
    row.operationType === body.operationType &&
    row.expenseClass === body.expenseClass &&
    row.sector === body.sector &&
    row.costType === body.costType &&
    row.lines.length === body.lines.length &&
    row.lines.every((line, index) => {
      const sent = body.lines[index]
      return (
        sent !== undefined &&
        line.description === sent.description &&
        line.kind === sent.kind &&
        line.amountCents === sent.amountCents
      )
    })
  )
}
