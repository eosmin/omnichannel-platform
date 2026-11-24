import { randomBytes } from 'node:crypto'

import { Inject, Injectable } from '@nestjs/common'

import { AuditAction, type AuditActionType } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import {
  ComplianceConfig,
  DSR_CONFIG,
  type DsrConfig,
  DsrResourceTypes
} from '@platform/core/compliance'
import { PrismaService } from '@platform/core/database'
import { resourceConflict, resourceNotFound } from '@platform/core/errors'

import { type Actor, auditActorOf } from '../tenancy'

import type { DsrFormKeyBody } from './compliance.schemas'

// What the screen of Settings reads: the key of the public form of the store (null = the store takes no public requests) and whether the
// whole public flow is open at all. The key is public by design: it travels in the address of the form and is how the worker finds the
// store, so it is stored and shown as it is. Only whoever holds `customers:dsr_manage_form` reads it here.
export interface DsrFormView {
  key: string | null
  // False while `DSR_PUBLIC_INTAKE_ENABLED` is off (or the flow is not declared ready): the key exists but the form takes nothing yet
  open: boolean
}

// The key of the public form of data requests (TDD_05 §10.2, Step 7.2-H2b C1a): made, replaced and switched off by the people of the store.
@Injectable()
export class DsrFormService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Inject(DSR_CONFIG) private readonly config: DsrConfig
  ) {}

  // Read from the row, never from the store the guard cached: after a change the cache could still hold the old key
  async get(storeId: string): Promise<DsrFormView> {
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: { dsrPublicKey: true }
    })
    if (store === null) throw resourceNotFound('store')
    return { key: store.dsrPublicKey, open: this.config.enabled }
  }

  // Makes the first key, or replaces the one the screen showed. Compare and swap: the row changes only if it still holds `current`.
  async makeKey(storeId: string, body: DsrFormKeyBody, actor: Actor): Promise<DsrFormView> {
    const key = randomBytes(ComplianceConfig.DSR_FORM_KEY_BYTES).toString('base64url')
    const { count } = await this.prisma.client.store.updateMany({
      where: { id: storeId, dsrPublicKey: body.current },
      data: { dsrPublicKey: key }
    })
    if (count !== 1) throw this.changed()
    this.log(
      body.current === null ? AuditAction.DSR_FORM_KEY_CREATED : AuditAction.DSR_FORM_KEY_ROTATED,
      storeId,
      actor,
      key,
      body.current
    )
    return { key, open: this.config.enabled }
  }

  // Switches the form off. Compare and swap like the change; switching off what is already off answers the same and writes nothing
  async revoke(storeId: string, body: DsrFormKeyBody, actor: Actor): Promise<DsrFormView> {
    if (body.current === null) return this.get(storeId)
    const { count } = await this.prisma.client.store.updateMany({
      where: { id: storeId, dsrPublicKey: body.current },
      data: { dsrPublicKey: null }
    })
    if (count !== 1) throw this.changed()
    this.log(AuditAction.DSR_FORM_KEY_REVOKED, storeId, actor, body.current)
    return { key: null, open: this.config.enabled }
  }

  private changed(): ReturnType<typeof resourceConflict> {
    return resourceConflict('the key of the public form changed since it was read')
  }

  // The last characters only: the audit log outlives the key and says which one was meant, not what it opens. A change also says which
  // key it replaced (`previousHint`), so a link that stopped working can be tied to the change that killed it.
  private log(
    action: AuditActionType,
    storeId: string,
    actor: Actor,
    key: string,
    previous: string | null = null
  ): void {
    this.audit.log({
      action,
      actor: auditActorOf(actor),
      storeId,
      resourceType: DsrResourceTypes.FORM_KEY,
      resourceId: storeId,
      metadata: {
        hint: key.slice(-ComplianceConfig.DSR_FORM_KEY_HINT_LENGTH),
        ...(previous === null
          ? {}
          : { previousHint: previous.slice(-ComplianceConfig.DSR_FORM_KEY_HINT_LENGTH) })
      },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
  }
}
