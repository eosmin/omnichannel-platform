import { Injectable } from '@nestjs/common'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { errorName } from '@platform/channels/connections'
import { PrismaService } from '@platform/core/database'
import { type MediaUnavailableCode, UNAVAILABLE_FILES_KEY } from '@platform/core/domain'
import { DomainEvents } from '@platform/core/event-bus'
import { Events } from '@platform/core/events'
import { lockMessageRow, publishMessageChanged } from '@platform/core/messaging'

// What the channel put in the metadata stays as it is
const storedListSchema = z.object({
  [UNAVAILABLE_FILES_KEY]: z.array(z.record(z.string(), z.json()))
})
const keptMetadataSchema = z.record(z.string(), z.json())

// Writes down, in the metadata of the message, that a file the customer sent was given up on, and tells
// the team so the thread draws the line. Never throws: the job already decided its own outcome, and a
// failure here must not turn a kept decision into a retry that would fetch the file again.
@Injectable()
export class UnavailableFileMarker {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: DomainEvents,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(UnavailableFileMarker.name)
  }

  async mark(
    storeId: string,
    messageId: string,
    index: number,
    code: MediaUnavailableCode
  ): Promise<void> {
    try {
      await this.prisma.transaction(async tx => {
        // An album is several jobs on one message: they take turns on its row
        await lockMessageRow(tx, messageId)
        const message = await tx.message.findFirst({
          where: { id: messageId, storeId },
          select: { metadata: true }
        })
        if (message === null) return
        // Read as it is stored: an entry this version does not know (a newer worker wrote it) is kept
        const current =
          storedListSchema.safeParse(message.metadata).data?.[UNAVAILABLE_FILES_KEY] ?? []
        // Asked twice (a retry, a redelivered job): one entry per place of the file
        if (current.some(file => file.index === index)) return
        const kept = keptMetadataSchema.safeParse(message.metadata).data ?? {}
        await tx.message.updateMany({
          where: { id: messageId, storeId },
          data: {
            metadata: {
              ...kept,
              [UNAVAILABLE_FILES_KEY]: [...current, { index, code }]
            }
          }
        })
        await publishMessageChanged(this.events, tx, Events.MEDIA_UNAVAILABLE, storeId, messageId)
      })
    } catch (error) {
      this.logger.warn(
        { messageId, index, errorName: errorName(error) },
        'a file that could not be kept was not recorded'
      )
    }
  }

  // The opposite of `mark`: the file of that place is stored now (a dead job re-run by hand), so the
  // thread must stop saying it was lost. Never throws, for the same reason as `mark`.
  async clear(storeId: string, messageId: string, index: number): Promise<void> {
    try {
      // Most files were never listed: look without the lock first, and lock only to change something
      const peek = await this.prisma.client.message.findFirst({
        where: { id: messageId, storeId },
        select: { metadata: true }
      })
      const listed = storedListSchema.safeParse(peek?.metadata).data?.[UNAVAILABLE_FILES_KEY] ?? []
      if (!listed.some(file => file.index === index)) return
      await this.prisma.transaction(async tx => {
        await lockMessageRow(tx, messageId)
        const message = await tx.message.findFirst({
          where: { id: messageId, storeId },
          select: { metadata: true }
        })
        if (message === null) return
        const current =
          storedListSchema.safeParse(message.metadata).data?.[UNAVAILABLE_FILES_KEY] ?? []
        const remaining = current.filter(file => file.index !== index)
        // Nothing was listed for this place: the common case, no write and no event
        if (remaining.length === current.length) return
        // Metadata that does not parse is left alone: writing it back would drop what the parse lost
        const parsed = keptMetadataSchema.safeParse(message.metadata)
        if (!parsed.success) return
        const kept = parsed.data
        const others = Object.fromEntries(
          Object.entries(kept).filter(([key]) => key !== UNAVAILABLE_FILES_KEY)
        )
        await tx.message.updateMany({
          where: { id: messageId, storeId },
          data: {
            metadata:
              remaining.length === 0 ? others : { ...others, [UNAVAILABLE_FILES_KEY]: remaining }
          }
        })
        // The thread reads the message again on this event and draws what the row holds now
        await publishMessageChanged(this.events, tx, Events.MEDIA_UNAVAILABLE, storeId, messageId)
      })
    } catch (error) {
      this.logger.warn(
        { messageId, index, errorName: errorName(error) },
        'a stored file was not cleared from the lost list'
      )
    }
  }
}
