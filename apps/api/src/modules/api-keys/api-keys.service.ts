import { Injectable } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import type { Permission } from '@platform/core/auth'
import { generateToken, hashToken } from '@platform/core/crypto'
import { lockStoreForWrite, lockStoreScope, PrismaService } from '@platform/core/database'
import {
  API_KEY_RESOURCE_TYPE,
  API_KEY_TOKEN_PREFIX,
  ApiKeyLimits,
  ApiKeyStatus
} from '@platform/core/domain'
import {
  ErrorCodes,
  HttpStatusCodes,
  PlatformException,
  resourceConflict,
  resourceNotFound
} from '@platform/core/errors'

import { type Actor, missingPermissions } from '../tenancy'

import type { CreateApiKeyBody } from './api-keys.schemas'
import {
  API_KEY_SELECT,
  apiKeyView,
  type ApiKeyView,
  type ApiKeyWithTokenView
} from './api-keys.views'

const SCOPE = 'api-key'
// The status column is text: compared with the value of the enum as text
const REVOKED: string = ApiKeyStatus.REVOKED

// The keys with which a store's own systems call its public API (Settings → API keys, TDD_05 §4.3). Only the prefix and
// the SHA-256 of a key are kept: the key has 256 bits of entropy, so there is nothing to brute-force, and what leaks from
// the database cannot be used. It is shown once, when it is made. A key never holds a scope that its maker lacks, and
// never one that runs the account (ApiKeyScopePrefixes), so a key cannot be a way up.
@Injectable()
export class ApiKeysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService
  ) {}

  async list(storeId: string): Promise<ApiKeyView[]> {
    const rows = await this.prisma.client.apiKey.findMany({
      where: { storeId },
      select: API_KEY_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      // Revoked keys stay for the record: the page shows the newest ones
      take: ApiKeyLimits.LIST_MAX
    })
    return rows.map(apiKeyView)
  }

  async create(
    storeId: string,
    body: CreateApiKeyBody,
    held: readonly Permission[],
    actor: Actor
  ): Promise<ApiKeyWithTokenView> {
    const lacking = missingPermissions(held, body.scopes)
    if (lacking.length > 0) {
      throw new PlatformException(
        ErrorCodes.PERMISSION_DENIED,
        'a key cannot hold a scope that its maker lacks',
        HttpStatusCodes.FORBIDDEN,
        { scopes: lacking }
      )
    }
    const key = `${API_KEY_TOKEN_PREFIX}${generateToken(ApiKeyLimits.SECRET_BYTES)}`
    const row = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      await lockStoreScope(tx, storeId, SCOPE)
      // A key past its date cannot authenticate any more, so it does not take room
      const active = await tx.apiKey.count({
        where: {
          storeId,
          status: ApiKeyStatus.ACTIVE,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        }
      })
      if (active >= ApiKeyLimits.MAX_PER_STORE) {
        throw resourceConflict(`a store holds at most ${ApiKeyLimits.MAX_PER_STORE} active keys`, {
          limit: ApiKeyLimits.MAX_PER_STORE
        })
      }
      return tx.apiKey.create({
        data: {
          storeId,
          name: body.name,
          keyPrefix: key.slice(0, ApiKeyLimits.DISPLAY_PREFIX_LENGTH),
          keyHash: hashToken(key),
          scopes: body.scopes,
          expiresAt: body.expiresAt ?? null,
          createdBy: actor.userId
        },
        select: API_KEY_SELECT
      })
    })
    // The key is not in the entry: only which one was made, and what it may do
    this.audit.log({
      action: AuditAction.API_KEY_CREATED,
      actor: { userId: actor.userId },
      storeId,
      resourceType: API_KEY_RESOURCE_TYPE,
      resourceId: row.id,
      metadata: { name: row.name, keyPrefix: row.keyPrefix, scopes: row.scopes },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return { ...apiKeyView(row), key }
  }

  // The row stays, revoked: the audit log and the list keep saying which key it was. A key already revoked is left as it is.
  async revoke(storeId: string, keyId: string, actor: Actor): Promise<ApiKeyView> {
    const { row, changed } = await this.prisma.transaction(async tx => {
      await lockStoreForWrite(tx, storeId)
      const locked = await tx.$queryRaw<{ status: string }[]>`
        SELECT status FROM api_keys WHERE id = ${keyId} AND store_id = ${storeId} FOR UPDATE`
      const status = locked[0]?.status
      if (status === undefined) throw resourceNotFound('api key')
      if (status === REVOKED) {
        const current = await tx.apiKey.findUniqueOrThrow({
          where: { id: keyId },
          select: API_KEY_SELECT
        })
        return { row: current, changed: false }
      }
      const updated = await tx.apiKey.update({
        where: { id: keyId },
        data: { status: ApiKeyStatus.REVOKED, revokedAt: new Date() },
        select: API_KEY_SELECT
      })
      return { row: updated, changed: true }
    })
    if (changed) {
      this.audit.log({
        action: AuditAction.API_KEY_REVOKED,
        actor: { userId: actor.userId },
        storeId,
        resourceType: API_KEY_RESOURCE_TYPE,
        resourceId: keyId,
        metadata: { name: row.name, keyPrefix: row.keyPrefix },
        ipAddress: actor.ipAddress,
        userAgent: actor.userAgent
      })
    }
    return apiKeyView(row)
  }
}
