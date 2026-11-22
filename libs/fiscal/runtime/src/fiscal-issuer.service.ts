import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  type FiscalEnvironment,
  type FiscalIssueOn,
  FiscalLimits,
  FiscalResourceTypes,
  FiscalSeriesScopeKeys,
  SealedValueKind
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import type { FiscalIssuerInput } from '@platform/fiscal/sdk'

import { FiscalProviderRegistry } from './fiscal-provider.registry'
import { toJson, record } from './json'
import { openSealed } from './sealed-open'
import { withTimeout } from './with-timeout'

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
  address: Record<string, string>
  // Absent keeps the stored one, null clears it
  registrationId?: string | null
  activityCode?: string | null
  establishmentCode?: string | null
  establishmentType?: string | null
  pointOfSaleCode?: string | null
  phone?: string | null
  email?: string | null
  environment: FiscalEnvironment
  // Absent keeps the stored one; a new issuer starts at delivered (the column's default)
  issueOn?: FiscalIssueOn
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
  establishmentType: string | null
  pointOfSaleCode: string | null
  phone: string | null
  email: string | null
  environment: FiscalEnvironment
  issueOn: FiscalIssueOn
  nextSequence: number
  credentialsSet: boolean
  updatedAt: string
}

// A series of correlatives as a person reads it: what it counts (the provider, the environment and whatever its manifest declares: the type
// of document, the establishment, the point of sale) and the number the next document of it takes. The key it is stored under is a hash
// and never shown.
export interface FiscalSeriesView {
  scope: Record<string, string>
  nextNumber: number
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
    private readonly providers: FiscalProviderRegistry,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalIssuerService.name)
  }

  // The series of the organization, in the order a person reads them (provider, environment, document type, establishment, point of sale);
  // the hashed key breaks a tie so the list does not move between reads. Filtered by the organization of the request.
  async listSeries(organizationId: string): Promise<FiscalSeriesView[]> {
    const rows = await this.prisma.client.fiscalSequence.findMany({
      where: { organizationId },
      orderBy: { scopeKey: 'asc' }
    })
    const readable = (row: { scope: unknown }): string =>
      Object.values(FiscalSeriesScopeKeys)
        .map(key => {
          const value = record(row.scope)[key]
          return typeof value === 'string' ? value : ''
        })
        .join('\u0000')
    // A stable sort: rows with the same readable scope keep the order of their keys
    return [...rows]
      .sort((a, b) => readable(a).localeCompare(readable(b)))
      .map(row => ({
        scope: Object.fromEntries(
          Object.entries(record(row.scope)).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string'
          )
        ),
        nextNumber: row.nextValue,
        updatedAt: row.updatedAt.toISOString()
      }))
  }

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
      establishmentType: row.establishmentType,
      pointOfSaleCode: row.pointOfSaleCode,
      phone: row.phone,
      email: row.email,
      environment: row.environment as FiscalEnvironment,
      issueOn: row.issueOn as FiscalIssueOn,
      nextSequence: row.nextSequence,
      credentialsSet: row.credentialsEncrypted !== null,
      updatedAt: row.updatedAt.toISOString()
    }
  }

  private storedCredentials(
    sealed: Uint8Array | null,
    organizationId: string
  ): Record<string, unknown> {
    if (sealed === null) return {}
    try {
      return openSealed(this.cipher, this.logger, sealed, SealedValueKind.ISSUER_CREDENTIALS, {
        organizationId
      })
    } catch {
      throw new PlatformException(
        ErrorCodes.FISCAL_ISSUER_INVALID,
        'the stored credentials cannot be read: send them again',
        HttpStatusCodes.BAD_REQUEST,
        { problems: ['credentials'] }
      )
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
    if (!provider.manifest.environments.includes(body.environment)) {
      throw new PlatformException(
        ErrorCodes.FISCAL_ISSUER_INVALID,
        'the provider does not work in that environment',
        HttpStatusCodes.BAD_REQUEST,
        { problems: ['environment'] }
      )
    }
    // Everything that depends on what is stored (the credentials to keep, the guards, the correlative) is read under the lock of the
    // row, which every document also takes when it takes a number: a request that rotates the credentials and one that does not can
    // never overwrite each other with what each read before the other committed
    // Credentials sent empty are credentials not sent: they never wipe the stored ones
    const sent =
      body.credentials === undefined || Object.keys(body.credentials).length === 0
        ? undefined
        : body.credentials
    await this.prisma
      .transaction(async tx => {
        await tx.$queryRaw`SELECT organization_id FROM fiscal_issuers WHERE organization_id = ${organizationId} FOR UPDATE`
        const existing = await tx.fiscalIssuer.findUnique({
          where: { organizationId },
          select: {
            credentialsEncrypted: true,
            providerId: true,
            environment: true,
            nextSequence: true,
            registrationId: true,
            activityCode: true,
            establishmentCode: true,
            establishmentType: true,
            pointOfSaleCode: true,
            phone: true,
            email: true
          }
        })
        // What the provider is told is what will be stored: the value sent, or the one kept when the request leaves it out
        const kept = <T>(sentValue: T | undefined, stored: T | undefined): T | null =>
          sentValue !== undefined ? sentValue : (stored ?? null)
        // The codes of the issuer are the old provider's or environment's when either changes: a client that moves to another one and
        // leaves them out does not carry them over (the credentials guard below holds the same line for the keys)
        const moved =
          existing !== null &&
          (existing.providerId !== body.providerId ||
            (existing.environment as FiscalEnvironment) !== body.environment)
        const keptCode = (
          sentValue: string | null | undefined,
          stored: string | null | undefined
        ) => kept(sentValue, moved ? undefined : stored)
        const input: FiscalIssuerInput = {
          legalName: body.legalName,
          taxId: body.taxId,
          registrationId: keptCode(body.registrationId, existing?.registrationId),
          address: body.address,
          activityCode: keptCode(body.activityCode, existing?.activityCode),
          establishmentCode: keptCode(body.establishmentCode, existing?.establishmentCode),
          establishmentType: kept(body.establishmentType, existing?.establishmentType),
          pointOfSaleCode: kept(body.pointOfSaleCode, existing?.pointOfSaleCode),
          phone: kept(body.phone, existing?.phone),
          email: kept(body.email, existing?.email),
          environment: body.environment
        }
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
        // Credentials of another provider, or of another environment, are not the new one's: a sandbox key is never kept as the key of
        // production, so a change of either asks for the new ones
        if (
          sent === undefined &&
          existing !== null &&
          (existing.providerId !== body.providerId ||
            (existing.environment as FiscalEnvironment) !== body.environment)
        ) {
          throw new PlatformException(
            ErrorCodes.FISCAL_ISSUER_INVALID,
            'a new provider or a new environment needs its own credentials',
            HttpStatusCodes.BAD_REQUEST,
            { problems: ['credentials'] }
          )
        }
        const credentials =
          sent ?? this.storedCredentials(existing?.credentialsEncrypted ?? null, organizationId)
        // A provider that throws, or that does not answer in a few seconds (the row is locked meanwhile), is an issuer that does not pass:
        // never a 500, and never a lock held for long. Validating reads the fields and the certificate; it never reaches the authority.
        const check = (await withTimeout(
          () => Promise.resolve().then(() => provider.validateIssuer(input, { credentials })),
          FiscalLimits.ISSUER_CHECK_TIMEOUT_MS
        ).catch(() => null)) ?? { ok: false, problems: ['provider_error'] }
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
          Object.keys(credentials).length === 0
            ? null
            : new Uint8Array(this.cipher.seal(credentials))
        const data = {
          providerId: body.providerId,
          legalName: body.legalName,
          taxId: body.taxId,
          address: toJson(body.address),
          // What the provider was told is what is stored: the value sent, the stored one kept, or null after a move to another provider
          registrationId: input.registrationId,
          activityCode: input.activityCode,
          establishmentCode: input.establishmentCode,
          ...(body.establishmentType === undefined
            ? {}
            : { establishmentType: body.establishmentType }),
          ...(body.pointOfSaleCode === undefined ? {} : { pointOfSaleCode: body.pointOfSaleCode }),
          ...(body.phone === undefined ? {} : { phone: body.phone }),
          ...(body.email === undefined ? {} : { email: body.email }),
          environment: body.environment,
          ...(body.issueOn === undefined ? {} : { issueOn: body.issueOn }),
          ...(body.nextSequence === undefined ? {} : { nextSequence: body.nextSequence }),
          credentialsEncrypted: sealed
        }
        await tx.fiscalIssuer.upsert({
          where: { organizationId },
          create: { organizationId, ...data },
          update: data
        })
      })
      .catch((error: unknown) => {
        // Two first writes at once: there is no row to lock yet, and the second one finds the first one's
        if ((error as { code?: string }).code === 'P2002') {
          throw new PlatformException(
            ErrorCodes.FISCAL_ISSUER_INVALID,
            'the issuer was being written by another request: send it again',
            HttpStatusCodes.CONFLICT
          )
        }
        throw error
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
        credentialsChanged: sent !== undefined
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    const view = await this.get(organizationId)
    if (view === null) throw new Error('the issuer was just written')
    return view
  }
}
