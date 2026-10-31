import { Injectable } from '@nestjs/common'

import { AuditService } from '@platform/core/audit-module'
import { lockStoreForWrite, PrismaService } from '@platform/core/database'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceNotFound
} from '@platform/core/errors'

import type { Actor } from '../tenancy'

import type { UpdateInboxSettingsBody } from './settings.schemas'
import { auditSettingsChange, lockSnippet } from './settings.support'

export interface InboxSettingsView {
  reopenWindowDays: number | null
  autoArchiveAfterDays: number
  resolveShowOptions: boolean
  sendClosingMessage: boolean
  closingSnippetId: string | null
  requestCsat: boolean
  agentLoadThreshold: number
}

// What the people who work the inbox read: how resolving behaves, the timezone the presets of a
// snooze are counted in, and the load at which the team widget flags an agent. The rest of the
// settings needs SETTINGS_VIEW.
export type InboxBehaviorView = Pick<
  InboxSettingsView,
  'resolveShowOptions' | 'sendClosingMessage' | 'closingSnippetId' | 'agentLoadThreshold'
> & { timezone: string }

const INBOX_SELECT = {
  reopenWindowDays: true,
  autoArchiveAfterDays: true,
  resolveShowOptions: true,
  sendClosingMessage: true,
  closingSnippetId: true,
  requestCsat: true,
  agentLoadThreshold: true
} as const

// How the inbox of a store behaves (TDD_09 section 3). A store always has its settings row: the
// owner bootstrap and the creation of a store write it.
@Injectable()
export class InboxSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async behavior(storeId: string): Promise<InboxBehaviorView> {
    const store = await this.prisma.client.store.findUnique({
      where: { id: storeId },
      select: {
        timezone: true,
        settings: {
          select: {
            resolveShowOptions: true,
            sendClosingMessage: true,
            closingSnippetId: true,
            agentLoadThreshold: true
          }
        }
      }
    })
    if (store === null || store.settings === null) throw resourceNotFound('store settings')
    return { ...store.settings, timezone: store.timezone }
  }

  async get(storeId: string): Promise<InboxSettingsView> {
    const row = await this.prisma.client.storeSettings.findUnique({
      where: { storeId },
      select: INBOX_SELECT
    })
    if (row === null) throw resourceNotFound('store settings')
    return row
  }

  async update(
    storeId: string,
    body: UpdateInboxSettingsBody,
    actor: Actor
  ): Promise<InboxSettingsView> {
    const row = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      if (body.closingSnippetId !== undefined && body.closingSnippetId !== null) {
        await lockSnippet(tx, storeId, body.closingSnippetId, 'reference')
      }
      const current = await tx.storeSettings.findUnique({
        where: { storeId },
        select: { sendClosingMessage: true, closingSnippetId: true }
      })
      if (current === null) throw resourceNotFound('store settings')
      // The state the row will be in, not only the fields of the body
      const sends = body.sendClosingMessage ?? current.sendClosingMessage
      const snippet =
        body.closingSnippetId === undefined ? current.closingSnippetId : body.closingSnippetId
      if (sends && snippet === null) {
        throw new PlatformException(
          ErrorCodes.VALIDATION_FAILED,
          'a closing message needs a closing snippet',
          HttpStatusCodes.BAD_REQUEST
        )
      }
      return tx.storeSettings.update({ where: { storeId }, data: body, select: INBOX_SELECT })
    })
    auditSettingsChange(this.audit, storeId, actor, 'store_settings', storeId, {
      change: 'updated',
      fields: Object.keys(body)
    })
    return row
  }
}
