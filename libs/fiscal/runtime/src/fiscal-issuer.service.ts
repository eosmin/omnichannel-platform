import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  type FiscalEnvironment,
  type FiscalIssueOn,
  FiscalResourceTypes
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import type { FiscalIssuerInput } from '@platform/fiscal/sdk'

import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { toJson, record } from './json'

export interface FiscalActor {
  userId: string
  storeId: string
  ipAddress?: string
  userAgent?: string
}

export interface FiscalIssuerBody {
  providerId: string
  legalName: string
  taxId: string
  registrationId: string | null
  address: Record<string, string>
  activityCode: string | null
  establishmentCode: string | null
  environment: FiscalEnvironment
  issueOn: FiscalIssueOn
  // The correlative the next document takes. It only moves forward (a number is never used twice); absent keeps the stored one, and a new
  // issuer starts at 1. The format of a legal correlative is the provider's and the accountant's, not core's.
  nextSequence?: number
  // Written, never read back; absent keeps the ones stored (rotation = sending new ones)
  credentials?: Record<string, string>
}

export interface FiscalIssuerView {
  providerId: string
  legalName: string
  taxId: string
  registrationId: string | null
  address: Record<string, unknown>
  activityCode: string | null
  establishmentCode: string | null
  environment: FiscalEnvironment
  issueOn: FiscalIssueOn
  nextSequence: number
  credentialsSet: boolean
  updatedAt: string
}

// The issuer of the organization (TDD_18 §8.2): the legal entity the documents are made in the name of, and the provider that makes
// them. The credentials are encrypted like the carrier's and are never returned or logged: the audit entry names the fields only.
@Injectable()
export class FiscalIssuerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly cipher: CredentialCipher,
    private readonly providers: FiscalProviderRegistry
  ) {}

  listProviders(): ReturnType<FiscalProviderRegistry['list']> {
    return this.providers.list()
  }

  async get(organizationId: string): Promise<FiscalIssuerView | null> {
    const row = await this.prisma.client.fiscalIssuer.findUnique({ where: { organizationId } })
    if (row === null) return null
    return {
      providerId: row.providerId,
      legalName: row.legalName,
      taxId: row.taxId,
      registrationId: row.registrationId,
      address: record(row.address),
      activityCode: row.activityCode,
      establishmentCode: row.establishmentCode,
      environment: row.environment as FiscalEnvironment,
      issueOn: row.issueOn as FiscalIssueOn,
      nextSequence: row.nextSequence,
      credentialsSet: row.credentialsEncrypted !== null,
      updatedAt: row.updatedAt.toISOString()
    }
  }

  async upsert(
    organizationId: string,
    body: FiscalIssuerBody,
    actor: FiscalActor
  ): Promise<FiscalIssuerView> {
    const provider = this.providers.find(body.providerId)
    if (provider === undefined) {
      throw new PlatformException(
        ErrorCodes.FISCAL_PROVIDER_UNAVAILABLE,
        'this deployment has no such provider',
        HttpStatusCodes.CONFLICT
      )
    }
    const existing = await this.prisma.client.fiscalIssuer.findUnique({
      where: { organizationId },
      select: { credentialsEncrypted: true, providerId: true, nextSequence: true }
    })
    if (
      body.nextSequence !== undefined &&
      existing !== null &&
      body.nextSequence < existing.nextSequence
    ) {
      throw new PlatformException(
        ErrorCodes.FISCAL_ISSUER_INVALID,
        'the correlative only moves forward',
        HttpStatusCodes.BAD_REQUEST,
        { problems: ['nextSequence'] }
      )
    }
    // Credentials of another provider are not the new one's: switching provider asks for the new ones
    if (
      body.credentials === undefined &&
      existing !== null &&
      existing.providerId !== body.providerId
    ) {
      throw new PlatformException(
        ErrorCodes.FISCAL_ISSUER_INVALID,
        'a new provider needs its own credentials',
        HttpStatusCodes.BAD_REQUEST,
        { problems: ['credentials'] }
      )
    }
    const credentials =
      body.credentials ??
      (existing?.credentialsEncrypted == null
        ? {}
        : this.cipher.open(existing.credentialsEncrypted))
    const input: FiscalIssuerInput = {
      legalName: body.legalName,
      taxId: body.taxId,
      registrationId: body.registrationId,
      address: body.address,
      activityCode: body.activityCode,
      establishmentCode: body.establishmentCode,
      environment: body.environment
    }
    if (!provider.manifest.environments.includes(body.environment)) {
      throw new PlatformException(
        ErrorCodes.FISCAL_ISSUER_INVALID,
        'the provider does not work in that environment',
        HttpStatusCodes.BAD_REQUEST,
        { problems: ['environment'] }
      )
    }
    const check = await provider.validateIssuer(input, { credentials })
    if (!check.ok) {
      // The problems are codes the provider chose (a field, a certificate), never a value
      throw new PlatformException(
        ErrorCodes.FISCAL_ISSUER_INVALID,
        'the issuer does not pass the provider',
        HttpStatusCodes.BAD_REQUEST,
        { problems: check.problems }
      )
    }
    const sealed =
      Object.keys(credentials).length === 0 ? null : new Uint8Array(this.cipher.seal(credentials))
    const data = {
      providerId: body.providerId,
      legalName: body.legalName,
      taxId: body.taxId,
      registrationId: body.registrationId,
      address: toJson(body.address),
      activityCode: body.activityCode,
      establishmentCode: body.establishmentCode,
      environment: body.environment,
      issueOn: body.issueOn,
      ...(body.nextSequence === undefined ? {} : { nextSequence: body.nextSequence }),
      credentialsEncrypted: sealed
    }
    // The correlative is checked again under the lock of the row: a document that took a number between the first read and this write
    // would otherwise be given its number twice (the row is the lock that every document takes when it increments the counter)
    await this.prisma.transaction(async tx => {
      const locked = await tx.$queryRaw<
        { next_sequence: number }[]
      >`SELECT next_sequence FROM fiscal_issuers WHERE organization_id = ${organizationId} FOR UPDATE`
      const current = locked[0]?.next_sequence
      if (body.nextSequence !== undefined && current !== undefined && body.nextSequence < current) {
        throw new PlatformException(
          ErrorCodes.FISCAL_ISSUER_INVALID,
          'the correlative only moves forward',
          HttpStatusCodes.BAD_REQUEST,
          { problems: ['nextSequence'] }
        )
      }
      await tx.fiscalIssuer.upsert({
        where: { organizationId },
        create: { organizationId, ...data },
        update: data
      })
    })
    this.audit.log({
      action: AuditAction.FISCAL_ISSUER_CHANGED,
      actor: { userId: actor.userId },
      organizationId,
      storeId: actor.storeId,
      resourceType: FiscalResourceTypes.ISSUER,
      resourceId: organizationId,
      // The names of the fields the request set, never their values and never the credentials
      metadata: {
        fields: Object.keys(body).filter(key => key !== 'credentials'),
        credentialsChanged: body.credentials !== undefined
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    const view = await this.get(organizationId)
    if (view === null) throw new Error('the issuer was just written')
    return view
  }
}
