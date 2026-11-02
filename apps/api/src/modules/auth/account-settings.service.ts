import { Injectable, Logger } from '@nestjs/common'

import { AuditAction } from '@platform/core/audit'
import { AuditService } from '@platform/core/audit-module'
import { PrismaService } from '@platform/core/database'
import { MediaStatus } from '@platform/core/domain'
import { resourceNotFound, unauthorized } from '@platform/core/errors'
import { MediaPurpose } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import type { UpdateAccountPreferencesBody, UpdateProfileBody } from './account.schemas'

export interface ProfileView {
  id: string
  email: string
  name: string
  avatarMediaId: string | null
  // A short-lived signed link, only for a picture the scan found clean and the worker re-encoded; null
  // while it is being scanned or processed (the id is there), when it was refused, or when there is none
  avatarUrl: string | null
}

export interface AccountPreferencesView {
  locale: string
  timezone: string | null
  density: string
}

// Who is asking, for the audit entry: the person acts on themselves, so there is no store
export interface AccountActor {
  userId: string
  ipAddress: string | undefined
  userAgent: string | undefined
}

const PREFERENCES_SELECT = { locale: true, timezone: true, density: true } as const

// The settings of a person's own account (Step 3.6). Nothing here takes a user id: it is always the
// one of the access token, so there is no route by which one person changes another's account.
@Injectable()
export class AccountSettingsService {
  private readonly logger = new Logger(AccountSettingsService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService
  ) {}

  async profile(userId: string): Promise<ProfileView> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, avatarMediaId: true }
    })
    // The access token outlives the account for up to its lifetime
    if (user === null) throw unauthorized('account no longer exists')
    const avatar = await this.avatar(user.avatarMediaId)
    return { ...user, avatarMediaId: avatar.mediaId, avatarUrl: avatar.url }
  }

  async updateProfile(
    userId: string,
    body: UpdateProfileBody,
    actor: AccountActor
  ): Promise<ProfileView> {
    const replaced = await this.prisma.transaction(async tx => {
      // The row is locked while the picture is swapped: two requests that change it at once each
      // find the one the other left, so no uploaded file is left without an owner
      const rows = await tx.$queryRaw<{ avatar_media_id: string | null }[]>`
        SELECT avatar_media_id FROM users WHERE id = ${userId} FOR UPDATE`
      const current = rows[0]
      if (current === undefined) throw unauthorized('account no longer exists')
      if (body.avatarMediaId !== undefined && body.avatarMediaId !== null) {
        // Only an avatar the person uploaded themselves, not refused by the scan. Anything else
        // (another person's, a message file, a missing id) is the same answer.
        // Locked while the pointer is written: the cleanup of the worker takes unattached avatars with
        // the same kind of lock (and skips a locked one), so it cannot delete the row under this change
        const own = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM media
          WHERE id = ${body.avatarMediaId} AND store_id IS NULL AND purpose = ${MediaPurpose.AVATAR}
            AND uploaded_by = ${userId}
            AND status IN (${MediaStatus.PENDING}, ${MediaStatus.CLEAN})
          FOR UPDATE`
        if (own.length === 0) throw resourceNotFound('media')
      }
      await tx.user.update({
        where: { id: userId },
        data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.avatarMediaId === undefined ? {} : { avatarMediaId: body.avatarMediaId })
        }
      })
      const previous = current.avatar_media_id
      if (
        body.avatarMediaId === undefined ||
        previous === null ||
        previous === body.avatarMediaId
      ) {
        return null
      }
      // The picture it replaces is of no use to anyone: the row goes with the change. (The column has
      // no foreign key, so the row may already be gone.)
      const old = await tx.media.findFirst({
        where: { id: previous, storeId: null, purpose: MediaPurpose.AVATAR, uploadedBy: userId },
        select: { key: true }
      })
      if (old === null) return null
      await tx.media.deleteMany({ where: { id: previous } })
      return old
    })
    if (replaced !== null) await this.dropObject(replaced.key)

    this.audit.log({
      action: AuditAction.ACCOUNT_PROFILE_UPDATED,
      actor: { userId },
      resourceType: 'user',
      resourceId: userId,
      // Which fields, never their values: a name is personal data
      metadata: { fields: Object.keys(body) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.profile(userId)
  }

  async preferences(userId: string): Promise<AccountPreferencesView> {
    const user = await this.prisma.client.user.findUnique({
      where: { id: userId },
      select: PREFERENCES_SELECT
    })
    if (user === null) throw unauthorized('account no longer exists')
    return user
  }

  async updatePreferences(
    userId: string,
    body: UpdateAccountPreferencesBody,
    actor: AccountActor
  ): Promise<AccountPreferencesView> {
    const { count } = await this.prisma.client.user.updateMany({
      where: { id: userId },
      data: body
    })
    if (count === 0) throw unauthorized('account no longer exists')
    this.audit.log({
      action: AuditAction.ACCOUNT_PREFERENCES_UPDATED,
      actor: { userId },
      resourceType: 'user',
      resourceId: userId,
      metadata: { fields: Object.keys(body) },
      ipAddress: actor.ipAddress,
      userAgent: actor.userAgent
    })
    return this.preferences(userId)
  }

  // A picture the scan refused (or whose row is gone) is no picture: the profile says there is none,
  // instead of naming an id that never shows. One still being scanned or re-encoded keeps its id and
  // has no link yet.
  private async avatar(
    mediaId: string | null
  ): Promise<{ mediaId: string | null; url: string | null }> {
    if (mediaId === null) return { mediaId: null, url: null }
    const media = await this.prisma.client.media.findFirst({
      where: { id: mediaId, storeId: null, purpose: MediaPurpose.AVATAR },
      select: { key: true, filename: true, contentType: true, status: true, processedAt: true }
    })
    if (media === null) return { mediaId: null, url: null }
    if (
      media.status === String(MediaStatus.INFECTED) ||
      media.status === String(MediaStatus.UNSCANNABLE)
    ) {
      return { mediaId: null, url: null }
    }
    // Only the file the worker re-encoded is served: until then the picture is the one uploaded, with
    // whatever metadata it carries (location, camera), and it has no link
    if (media.status !== String(MediaStatus.CLEAN) || media.processedAt === null) {
      return { mediaId, url: null }
    }
    const url = await this.storage.downloadUrl({
      key: media.key,
      contentType: media.contentType,
      filename: media.filename
    })
    return { mediaId, url }
  }

  // A failure leaves a stray object, not a wrong picture: it is logged and the object stays unreachable
  private async dropObject(key: string): Promise<void> {
    try {
      await this.storage.delete(key)
    } catch (error) {
      this.logger.warn({ key, err: error }, 'could not delete the file of a replaced avatar')
    }
  }
}
