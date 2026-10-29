import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import {
  CONNECTION_ROW_SELECT,
  ChannelContextFactory,
  errorName,
  withTimeout
} from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import {
  ChannelConnectionStatus,
  CustomerProfileFetch,
  ProfileFailureKinds,
  OfActiveInstallation
} from '@platform/core/domain'
import { type ErrorCode, ErrorCodes } from '@platform/core/errors'
import { CustomerProfileService } from '@platform/core/messaging'
import type { FetchCustomerProfileJob } from '@platform/core/queues'
import { PluginRegistry } from '@platform/plugins/runtime'

import { refusalOf } from '../outbound/send-refusal'

// A plugin may be a third party's: what it hands over is checked before it is stored. A field it has
// not got may come as null, which is the same as absent.
const optionalText = z
  .string()
  .nullish()
  .catch(undefined)
  .transform(value => value ?? undefined)
const readSchema = z
  .object({ name: optionalText, username: optionalText, avatarUrl: optionalText })
  .nullable()

// What the retry sees of a failed attempt: the code and the name of the error, never its text
export class ProfileAttemptFailed extends Error {
  constructor(code: ErrorCode, cause: unknown) {
    super(`reading a profile failed: ${code} (${errorName(cause)})`)
    this.name = 'ProfileAttemptFailed'
  }
}

// The worker half of the name and photo of a customer: asks the plugin of the connection that delivered
// the message, and stores what it answers. Never part of the webhook, never blocking a message.
@Injectable()
export class ProfileFetcher {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: PluginRegistry,
    private readonly contexts: ChannelContextFactory,
    private readonly profiles: CustomerProfileService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(ProfileFetcher.name)
  }

  // Throws when the attempt should be repeated; returns when the read is settled or no longer wanted
  async fetch(job: FetchCustomerProfileJob, isLastAttempt: boolean): Promise<void> {
    const { storeId, identityId, connectionRowId } = job
    const [identity, connection] = await Promise.all([
      this.prisma.client.customerIdentity.findFirst({
        where: { id: identityId, storeId },
        select: { channelIdentity: true }
      }),
      this.prisma.client.channelConnection.findFirst({
        where: {
          id: connectionRowId,
          storeId,
          status: { in: [ChannelConnectionStatus.ACTIVE, ChannelConnectionStatus.ERROR] },
          ...OfActiveInstallation
        },
        select: CONNECTION_ROW_SELECT
      })
    ])
    // Either is gone since the job was queued: nothing to read, nothing to mark
    if (identity === null || connection === null) return

    const plugin = this.registry.find(connection.pluginId)
    if (plugin === undefined) {
      // A registry that is still filling is not a plugin that is gone: not a verdict on the channel
      if (!isLastAttempt) throw new Error('the plugin of the connection is not registered')
      await this.profiles.recordFailure(
        storeId,
        identityId,
        ErrorCodes.CHANNEL_NOT_CONNECTED,
        ProfileFailureKinds.OUTAGE
      )
      return
    }
    if (plugin.fetchProfile === undefined) {
      await this.profiles.recordFailure(
        storeId,
        identityId,
        ErrorCodes.CHANNEL_CAPABILITY_UNSUPPORTED,
        ProfileFailureKinds.REFUSED
      )
      return
    }
    // Only the call to the plugin is a channel failure: a fault of ours below is the job's to retry
    let read: unknown
    try {
      read = await withTimeout(
        plugin.fetchProfile(this.contexts.contextFor(connection), identity.channelIdentity),
        CustomerProfileFetch.TIMEOUT_MS
      )
    } catch (error) {
      const refused = refusalOf(error)
      // The message of the error may hold a token: only its name is logged, and none of it is stored
      this.logger.warn(
        {
          pluginId: connection.pluginId,
          identityId,
          code: refused.code,
          errorName: errorName(error)
        },
        'reading a customer profile failed'
      )
      if (refused.retryable && !isLastAttempt) throw new ProfileAttemptFailed(refused.code, error)
      await this.profiles.recordFailure(
        storeId,
        identityId,
        refused.code,
        // A token the channel refuses says nothing about the person: asked again once it is replaced
        refused.retryable || refused.code === ErrorCodes.CHANNEL_CREDENTIALS_INVALID
          ? ProfileFailureKinds.OUTAGE
          : ProfileFailureKinds.REFUSED
      )
      return
    }
    const parsed = readSchema.safeParse(read)
    if (!parsed.success) {
      await this.profiles.recordFailure(
        storeId,
        identityId,
        ErrorCodes.CHANNEL_MESSAGE_FAILED,
        ProfileFailureKinds.REFUSED
      )
      return
    }
    await this.profiles.recordRead(storeId, identityId, parsed.data)
  }
}
