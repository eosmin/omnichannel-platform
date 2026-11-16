import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import { FiscalResourceTypes } from '@platform/core/domain'
import {
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

// What a person may send: a field left out stays, a field sent as null is removed (the same rule as the receiver of a document)
export type CustomerFiscalDataPatch = Partial<
  Record<'name' | 'taxId' | 'registrationId' | 'taxpayerType' | 'economicActivity', string | null>
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
    private readonly providers: FiscalProviderRegistry
  ) {}

  // The data of a customer of the store, masked. `null` when the customer has none.
  async get(storeId: string, customerId: string): Promise<MaskedCustomerFiscalData | null> {
    await this.assertCustomer(this.prisma.client, storeId, customerId)
    const row = await this.prisma.client.customerFiscalData.findFirst({
      where: { storeId, customerId },
      select: { dataEncrypted: true }
    })
    if (row === null) return null
    return maskedCustomerFiscalData(this.open(row.dataEncrypted))
  }

  async put(
    organizationId: string,
    storeId: string,
    customerId: string,
    patch: CustomerFiscalDataPatch,
    actor: FiscalActor
  ): Promise<MaskedCustomerFiscalData | null> {
    const result = await this.prisma.transaction(async tx => {
      await this.assertCustomer(tx, storeId, customerId)
      // One writer at a time per customer: two requests that each merge into what they read cannot lose each other's fields
      await tx.$queryRaw`SELECT id FROM customers WHERE id = ${customerId} AND store_id = ${storeId} FOR UPDATE`
      const row = await tx.customerFiscalData.findFirst({
        where: { storeId, customerId },
        select: { dataEncrypted: true }
      })
      // What cannot be opened is replaced by what the person sends now: it is how the data is written again after a key change
      const current = row === null ? receiverOf({}) : this.openOrEmpty(row.dataEncrypted)
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
            : (current.economicActivity ?? null)
      }
      const stored = receiverRecord(next)
      // Nothing left to keep is no row: clearing every field is clearing the data
      if (Object.keys(stored).length === 0) {
        await tx.customerFiscalData.deleteMany({ where: { storeId, customerId } })
        return null
      }
      await this.check(tx, organizationId, receiverOf(stored))
      const sealed = new Uint8Array(this.cipher.seal(stored))
      await tx.customerFiscalData.upsert({
        where: { customerId },
        create: { storeId, customerId, dataEncrypted: sealed, updatedBy: actor.userId },
        update: { dataEncrypted: sealed, updatedBy: actor.userId }
      })
      return maskedCustomerFiscalData(receiverOf(stored))
    })
    this.audit.log({
      action:
        result === null
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
    return result
  }

  // Removes all of it. A fiscal document already made keeps its own copy: it is the legal evidence and this data does not reach it.
  async clear(storeId: string, customerId: string, actor: FiscalActor): Promise<void> {
    const removed = await this.prisma.transaction(async tx => {
      await this.assertCustomer(tx, storeId, customerId)
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
    receiver: FiscalReceiver
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
    } catch {
      // What a provider throws may carry the value: only the fact is kept
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'the provider could not check the fiscal data of the customer',
        HttpStatusCodes.CONFLICT
      )
    }
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
    customerId: string
  ): Promise<void> {
    const customer = await client.customer.findFirst({
      where: { id: customerId, storeId, mergedIntoId: null, erasedAt: null },
      select: { id: true }
    })
    if (customer === null) throw resourceNotFound('customer')
  }

  private openOrEmpty(sealed: Uint8Array): FiscalReceiver {
    try {
      return receiverOf(this.cipher.open(sealed))
    } catch {
      return receiverOf({})
    }
  }

  // A row that cannot be opened (a key that changed) is an error to fix by writing the data again, never an empty answer that a person
  // would read as "this customer has no tax id"
  private open(sealed: Uint8Array): FiscalReceiver {
    try {
      return receiverOf(this.cipher.open(sealed))
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
