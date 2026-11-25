import { DSR_EXPORT_FRAGMENT_KEY, DSR_EXPORT_WEB_PATH } from '@platform/core/compliance'
import { generateToken, hashToken } from '@platform/core/crypto'
import type { PrismaTransaction } from '@platform/core/database'
import { DsrType, VerificationTokenType } from '@platform/core/domain'

// rls-context: runs inside the transaction (and the JobContext) of the notice that asks for it

export interface DsrExportLinkInput {
  requestId: string
  requestType: string
  // Until when the file is kept: the link works until then at most
  fileExpiresAt: Date | null
  // Origin of the web app
  frontendUrl: string
}

// The link that hands a person the file of their access or portability request: a NEW token of 256 bits each time the mail is queued (only its
// hash is stored), valid until the file is kept until. The tokens of earlier mails of the same request are KEPT until they expire: the mail job
// has a fixed id, so a job still in flight when the notice is asked for again keeps its own (older) link and BullMQ drops the new add; replacing
// the token would leave that job with a dead link. The notice is queued at most `DSR_NOTICE_MAX_ATTEMPTS` times, so that many links can be live,
// and the first download spends them all (`DsrExportDownloadService`). A request already downloaded gets no new link: a re-sent notice then says
// the store will hand the file over, and a reviewer decides whether to give another. The token goes in the fragment of the page, which a
// browser never sends to a server.
export async function dsrExportLinkOf(
  tx: PrismaTransaction,
  input: DsrExportLinkInput
): Promise<{ downloadUrl?: string }> {
  const isExport =
    input.requestType === String(DsrType.ACCESS) ||
    input.requestType === String(DsrType.PORTABILITY)
  if (!isExport || input.fileExpiresAt === null || input.fileExpiresAt.getTime() <= Date.now()) {
    return {}
  }
  const spent = await tx.verificationToken.count({
    where: {
      type: VerificationTokenType.DSR_EXPORT_DOWNLOAD,
      subject: input.requestId,
      usedAt: { not: null }
    }
  })
  if (spent > 0) return {}
  const token = generateToken()
  await tx.verificationToken.create({
    data: {
      type: VerificationTokenType.DSR_EXPORT_DOWNLOAD,
      tokenHash: hashToken(token),
      subject: input.requestId,
      expiresAt: input.fileExpiresAt
    }
  })
  const url = new URL(DSR_EXPORT_WEB_PATH, input.frontendUrl)
  url.hash = `${DSR_EXPORT_FRAGMENT_KEY}=${token}`
  return { downloadUrl: url.toString() }
}
