import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import { FiscalResourceTypes, SealedValueKind } from '@platform/core/domain'
import {
  errorName,
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'
import type { FiscalReceiver, FiscalReceiverProblem } from '@platform/fiscal/sdk'

import type { FiscalActor } from './fiscal-issuer.service'
import { FiscalProviderRegistry } from './fiscal-provider.registry'
import {
  type MaskedCustomerFiscalData,
  maskedCustomerFiscalData,
  receiverOf,
  receiverRecord
} from './fiscal-rules'
import { openSealed, type SealedRef } from './sealed-open'

// The record as text with its keys in order (the address too), so the same data sent in another order is the same data
const canonical = (record: Record<string, unknown>): string =>
  JSON.stringify(record, (_key, value: unknown) =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value
  )

// What a person may send: a field left out stays, a field sent as null is removed (the same rule as the receiver of a document)
export type CustomerFiscalDataPatch = Partial<
  Record<
    'name' | 'taxId' | 'registrationId' | 'taxpayerType' | 'economicActivity' | 'documentType',
    string | null
  >
> & { address?: Record<string, string> | null }

// The fiscal data of a customer (TDD_18 §8, Step 4B.7b-3): who the store invoices, held apart from the customer's contact data. It is
// personal and tax data: sealed in its row, masked in every answer, never logged (the audit names the fields), and what a value must look
// like is the rule of the provider of the organization's issuer, so no format of a country is written in core.
@Injectable()
export class FiscalCustomerDataService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: CredentialCipher,
    private readonly providers: FiscalProviderRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalCustomerDataService.name)
  }

  // The data of a customer of the store, masked. `null` when the customer has none.
  async get(storeId: string, customerId: string): Promise<MaskedCustomerFiscalData | null> {
    await this.assertCustomer(this.prisma.client, storeId, customerId, true)
    const row = await this.prisma.client.customerFiscalData.findFirst({
      where: { storeId, customerId },
      select: { dataEncrypted: true }
    })
    if (row === null) return null
    return maskedCustomerFiscalData(this.open(row.dataEncrypted, { customerId }))
  }

  async put(
    organizationId: string,
    storeId: string,
    customerId: string,
    patch: CustomerFiscalDataPatch,
    actor: FiscalActor
  ): Promise<{ kept: boolean }> {
    const outcome = await this.prisma.transaction(async tx => {
      // The lock first, and the customer is judged under it: a merge or an erasure that commits meanwhile is seen, never written over
      const locked = await tx.$queryRaw<
        { merged_into_id: string | null; erased_at: Date | null }[]
      >`SELECT merged_into_id, erased_at FROM customers WHERE id = ${customerId} AND store_id = ${storeId} FOR UPDATE`
      const customer = locked[0]
      if (
        customer === undefined ||
        customer.merged_into_id !== null ||
        customer.erased_at !== null
      ) {
        throw resourceNotFound('customer')
      }
      const row = await tx.customerFiscalData.findFirst({
        where: { storeId, customerId },
        select: { dataEncrypted: true }
      })
      // A row that cannot be opened is never merged into silently (the fields the patch does not name would be lost): the person clears it
      // first (DELETE does not open it) and writes the data again
      const current = row === null ? receiverOf({}) : this.open(row.dataEncrypted, { customerId })
      const next: FiscalReceiver = {
        name: 'name' in patch ? (patch.name ?? null) : current.name,
        taxId: 'taxId' in patch ? (patch.taxId ?? null) : current.taxId,
        registrationId:
          'registrationId' in patch ? (patch.registrationId ?? null) : current.registrationId,
        address: 'address' in patch ? (patch.address ?? null) : current.address,
        email: null,
        phone: null,
        taxpayerType:
          'taxpayerType' in patch ? (patch.taxpayerType ?? null) : (current.taxpayerType ?? null),
        economicActivity:
          'economicActivity' in patch
            ? (patch.economicActivity ?? null)
            : (current.economicActivity ?? null),
        documentType:
          'documentType' in patch ? (patch.documentType ?? null) : (current.documentType ?? null)
      }
      const stored = receiverRecord(next)
      const before = receiverRecord(current)
      // The same data again changes nothing and leaves no entry
      if (row !== null && canonical(stored) === canonical(before)) {
        return { kind: 'unchanged' as const, kept: true }
      }
      // Nothing left to keep is no row: clearing every field is clearing the data
      if (Object.keys(stored).length === 0) {
        await tx.customerFiscalData.deleteMany({ where: { storeId, customerId } })
        return { kind: row === null ? ('unchanged' as const) : ('cleared' as const), kept: false }
      }
      await this.check(tx, organizationId, receiverOf(stored), current)
      const sealed = new Uint8Array(this.cipher.seal(stored))
      if (row === null) {
        await tx.customerFiscalData.create({
          data: { storeId, customerId, dataEncrypted: sealed, updatedBy: actor.userId }
        })
      } else {
        // Filtered by the store like every query of a tenant-scoped table
        await tx.customerFiscalData.updateMany({
          where: { storeId, customerId },
          data: { dataEncrypted: sealed, updatedBy: actor.userId }
        })
      }
      return { kind: 'changed' as const, kept: true }
    })
    if (outcome.kind !== 'unchanged') {
      this.audit.log({
        action:
          outcome.kind === 'cleared'
            ? AuditAction.FISCAL_CUSTOMER_DATA_CLEARED
            : AuditAction.FISCAL_CUSTOMER_DATA_CHANGED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: FiscalResourceTypes.CUSTOMER_DATA,
        resourceId: customerId,
        // The names of the fields, never their values
        metadata: { fields: Object.keys(patch) },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    // Whether data is kept, nothing of it: whoever may write is not for that reason allowed to read
    return { kept: outcome.kept }
  }

  // Removes all of it. A fiscal document already made keeps its own copy: it is the legal evidence and this data does not reach it.
  async clear(storeId: string, customerId: string, actor: FiscalActor): Promise<void> {
    const removed = await this.prisma.transaction(async tx => {
      // Any customer of the store, even one that was erased or merged: the data of such a customer must still be removable
      await this.assertCustomer(tx, storeId, customerId, false)
      const { count } = await tx.customerFiscalData.deleteMany({ where: { storeId, customerId } })
      return count
    })
    if (removed === 0) return
    this.audit.log({
      action: AuditAction.FISCAL_CUSTOMER_DATA_CLEARED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: FiscalResourceTypes.CUSTOMER_DATA,
      resourceId: customerId,
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }

  // The provider of the organization's issuer says what is wrong with the data. With no issuer yet (or a provider this deployment does
  // not have) nobody has said what a valid value looks like: the data is kept as it is, within core's limits, and checked by the provider
  // when a document is built (`missingReceiverFields`).
  private async check(
    tx: Pick<PrismaService['client'], 'fiscalIssuer'>,
    organizationId: string,
    receiver: FiscalReceiver,
    current: FiscalReceiver
  ): Promise<void> {
    const issuer = await tx.fiscalIssuer.findUnique({
      where: { organizationId },
      select: { providerId: true }
    })
    if (issuer === null) return
    const provider = this.providers.find(issuer.providerId)
    if (provider?.validateReceiver === undefined) return
    let problems: readonly FiscalReceiverProblem[]
    try {
      problems = provider.validateReceiver(receiver)
    } catch (error) {
      // What a provider throws may carry the value: only the name of the error is logged, never its message
      this.logger.error(
        { err: errorName(error), providerId: issuer.providerId },
        'a provider could not check the fiscal data of a customer'
      )
      // The fact is kept
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the provider could not check the fiscal data of the customer',
        HttpStatusCodes.CONFLICT
      )
    }
    // A tax id the person did not change is not judged again: a rule added to a provider later (the check digit of a national id) must not
    // refuse the edit of an address on data that was saved before it
    const idKept =
      receiver.taxId === current.taxId &&
      (receiver.documentType ?? null) === (current.documentType ?? null)
    problems = idKept ? problems.filter(problem => problem.field !== 'taxId') : problems
    if (problems.length === 0) return
    throw new PlatformException(
      ErrorCodes.FISCAL_CUSTOMER_DATA_INVALID,
      'the fiscal data of the customer does not pass the checks of the provider',
      HttpStatusCodes.BAD_REQUEST,
      // The field and the provider's code of each problem, never the value
      { problems: problems.map(problem => ({ field: problem.field, code: problem.code })) }
    )
  }

  private async assertCustomer(
    client: Pick<PrismaService['client'], 'customer'>,
    storeId: string,
    customerId: string,
    live: boolean
  ): Promise<void> {
    const customer = await client.customer.findFirst({
      where: { id: customerId, storeId, ...(live ? { mergedIntoId: null, erasedAt: null } : {}) },
      select: { id: true }
    })
    if (customer === null) throw resourceNotFound('customer')
  }

  // A row that cannot be opened (a key that changed) is an error to fix by writing the data again, never an empty answer that a person
  // would read as "this customer has no tax id"
  private open(sealed: Uint8Array, ref: SealedRef): FiscalReceiver {
    try {
      return receiverOf(
        openSealed(this.cipher, this.logger, sealed, SealedValueKind.CUSTOMER_DATA, ref)
      )
    } catch {
      throw new PlatformException(
        ErrorCodes.FISCAL_CUSTOMER_DATA_INVALID,
        'the fiscal data of the customer cannot be read: write it again',
        HttpStatusCodes.CONFLICT,
        { reason: 'unreadable' }
      )
    }
  }
}
