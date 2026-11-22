import { Inject, Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { DSR_CONFIG, type DsrConfig, DsrResourceTypes } from '@platform/core/compliance'
import { hashToken } from '@platform/core/crypto'
import { contextOf, PrismaService, resolveDsrVerification } from '@platform/core/database'
import { DsrStatus, VerificationTokenType } from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'

import type { DsrVerifyBody } from './compliance.schemas'

export interface DsrVerifyAnswer {
  verified: true
}

// One answer for a token that is unknown, used, expired, of a request that no longer waits, or for the flow being off
function invalidToken(): PlatformException {
  return new PlatformException(
    ErrorCodes.DSR_VERIFICATION_INVALID,
    'the verification of the data request is not valid',
    HttpStatusCodes.BAD_REQUEST
  )
}

// The person confirms the request with the token of the mail (TDD_05 §10.2). Confirming proves they read that mailbox, nothing more:
// the request goes to manual review and nothing is done to any customer. The token is claimed and the request moves in ONE transaction.
@Injectable()
export class DsrVerifyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig
  ) {}

  async verify(body: DsrVerifyBody): Promise<DsrVerifyAnswer> {
    if (!this.config.enabled) throw invalidToken()
    const tokenHash = hashToken(body.token)
    // The request is found by the hash of the token, before there is a context; its rows are touched only inside the context it opens
    const found = await resolveDsrVerification(this.prisma.client, tokenHash)
    if (found === null) throw invalidToken()

    const moved = await this.prisma.tenantTransaction(contextOf(found), async () => {
      // The claim: exactly one caller flips an unused, unexpired token. A second click, or a mail scanner racing the person, finds nothing.
      const claimed = await this.prisma.client.verificationToken.updateMany({
        where: {
          tokenHash,
          type: VerificationTokenType.DSR_VERIFICATION,
          usedAt: null,
          expiresAt: { gt: new Date() }
        },
        data: { usedAt: new Date() }
      })
      if (claimed.count !== 1) return false
      const request = await this.prisma.client.dataSubjectRequest.updateMany({
        where: {
          id: found.id,
          storeId: found.storeId,
          status: DsrStatus.PENDING_VERIFICATION
        },
        data: { status: DsrStatus.MANUAL_REVIEW, verifiedAt: new Date() }
      })
      // Not waiting any more: the token is not spent for a request that cannot take it
      if (request.count !== 1) throw invalidToken()
      return true
    })
    if (!moved) throw invalidToken()

    // Ids only: no address, no name (the audit log outlives the store's retention windows)
    this.audit.log({
      action: AuditAction.DSR_VERIFIED,
      actor: { system: true },
      storeId: found.storeId,
      organizationId: found.organizationId,
      resourceType: DsrResourceTypes.REQUEST,
      resourceId: found.id
    })
    return { verified: true }
  }
}
