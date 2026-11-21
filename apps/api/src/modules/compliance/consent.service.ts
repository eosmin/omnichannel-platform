import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ConsentListLimits,
  ConsentPurposeLegalBasis,
  type ConsentPurpose,
  ConsentSources
} from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { resourceNotFound } from '@platform/core/errors'
import { lockCustomerForWrite } from '@platform/core/messaging'

import { type Actor, auditActorOf, auditViaOf } from '../tenancy'

import type { RecordConsentBody } from './compliance.schemas'

export interface ConsentView {
  id: string
  purpose: string
  legalBasis: string
  granted: boolean
  grantedAt: string | null
  revokedAt: string | null
  source: string
  createdAt: string
  // The newest row of its purpose: the answer that rules today. The older ones are the history.
  current: boolean
}

export interface ConsentList {
  items: ConsentView[]
}

export interface RecordedConsent {
  consent: ConsentView
  // False when the latest answer of the purpose was already this one: nothing was written
  changed: boolean
}

type Row = {
  id: string
  purpose: string
  legalBasis: string
  granted: boolean
  grantedAt: Date | null
  revokedAt: Date | null
  source: string
  createdAt: Date
}

const select = {
  id: true,
  purpose: true,
  legalBasis: true,
  granted: true,
  grantedAt: true,
  revokedAt: true,
  source: true,
  createdAt: true
} as const

function viewOf(row: Row, current: boolean): ConsentView {
  return {
    id: row.id,
    purpose: row.purpose,
    legalBasis: row.legalBasis,
    granted: row.granted,
    grantedAt: row.grantedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    source: row.source,
    createdAt: row.createdAt.toISOString(),
    current
  }
}

// What a row says today: a refusal, or an agreement the erasure of the customer has not revoked
const holds = (row: Pick<Row, 'granted' | 'revokedAt'>): boolean =>
  row.granted && row.revokedAt === null

// The consents of a customer (TDD_05 §10.2, `ConsentRecord`). The history is append-only: a change is a new row and the newest
// row of a purpose is the current answer, so what the customer agreed to, and when, is never rewritten. The only readers of the
// rows are the services that must stop (the messages of an order read the newest row of `order_messages`).
//
// The team records what the customer told them (`ConsentSources.STAFF`); the legal basis is the one of the purpose, not a field
// of the body. The address and browser of the person who clicks are not the customer's, so they are not kept on the row: the
// audit entry holds who recorded it and from where.
@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string, customerId: string): Promise<ConsentList> {
    const customer = await this.prisma.client.customer.findFirst({
      // A customer absorbed by a merge is not found here either, as it is not for `record`: its rows moved to the survivor
      where: { id: customerId, storeId, mergedIntoId: null },
      select: { erasedAt: true }
    })
    if (customer === null) throw resourceNotFound('customer')
    // An erased customer holds no personal data: what the erasure left is proof for the store, not something to show
    if (customer.erasedAt !== null) return { items: [] }
    const rows = await this.prisma.client.consentRecord.findMany({
      where: { storeId, customerId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: ConsentListLimits.MAX_ROWS,
      select
    })
    const seen = new Set<string>()
    return {
      items: rows.map(row => {
        const current = !seen.has(row.purpose)
        seen.add(row.purpose)
        return viewOf(row, current)
      })
    }
  }

  async record(storeId: string, body: RecordConsentBody, actor: Actor): Promise<RecordedConsent> {
    const purpose = body.purpose as ConsentPurpose
    const { consent, changed } = await this.prisma.transaction(async tx => {
      // The lock of the customer: two answers at once cannot both read the same "latest" and write two rows
      await lockCustomerForWrite(tx, storeId, body.customerId)
      const latest = await tx.consentRecord.findFirst({
        where: { storeId, customerId: body.customerId, purpose },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select
      })
      // The same answer again changes nothing and keeps the date of the first
      if (latest !== null && holds(latest) === body.granted) {
        return { consent: viewOf(latest, true), changed: false }
      }
      // The newest row rules, so the date of a new one is never behind the newest that exists: the clock of another instance a few
      // milliseconds ahead, or a clock set back, cannot put the withdrawal under the agreement it withdraws
      const clock = new Date()
      const now =
        latest !== null && latest.createdAt >= clock
          ? new Date(latest.createdAt.getTime() + 1)
          : clock
      const row = await tx.consentRecord.create({
        data: {
          storeId,
          customerId: body.customerId,
          purpose,
          legalBasis: ConsentPurposeLegalBasis[purpose],
          granted: body.granted,
          grantedAt: body.granted ? now : null,
          revokedAt: body.granted ? null : now,
          source: ConsentSources.STAFF,
          createdAt: now
        },
        select
      })
      return { consent: viewOf(row, true), changed: true }
    })
    if (changed) {
      this.audit.log({
        action: AuditAction.CONSENT_RECORDED,
        actor: auditActorOf(actor),
        storeId,
        resourceType: 'consent_record',
        resourceId: consent.id,
        metadata: {
          customerId: body.customerId,
          purpose,
          granted: body.granted,
          legalBasis: consent.legalBasis,
          ...auditViaOf(actor)
        },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return { consent, changed }
  }
}
