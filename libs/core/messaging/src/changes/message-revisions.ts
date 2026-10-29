import type { PrismaTransaction } from '@platform/core/database'
import type { AuthorType } from '@platform/core/domain'

// Keeps the text a message had before an edit. A revision is numbered by the revisions that the message
// already has, not by `Message.version` (which also moves when an edit or a deletion is asked for and
// the channel then refuses), so that the numbers run 1, 2, 3 and two writers never take the same one.
// The caller holds the lock of the conversation, or of the handle for an inbound change.
export async function addRevision(
  tx: PrismaTransaction,
  revision: {
    storeId: string
    messageId: string
    content: string | null
    editedByType: AuthorType
    editedById: string | null
  }
): Promise<void> {
  const last = await tx.messageRevision.findFirst({
    where: { messageId: revision.messageId },
    orderBy: { version: 'desc' },
    select: { version: true }
  })
  await tx.messageRevision.create({ data: { ...revision, version: (last?.version ?? 0) + 1 } })
}
