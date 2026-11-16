import { randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { CredentialCipher } from '@platform/core/crypto'
import { isUniqueViolation, PrismaService } from '@platform/core/database'
import {
  FiscalDocumentStatus,
  FiscalEvidenceContentType,
  FiscalEvidenceKind,
  FiscalLimits,
  MediaStatus
} from '@platform/core/domain'
import { errorName } from '@platform/core/errors'
import { JobNames, QueueNames, type ScanFileJob } from '@platform/core/queues'
import { MediaPurpose, StorageKeys } from '@platform/core/storage'
import { StorageService } from '@platform/core/storage-module'

import { record, toJson } from './json'

// What a kind of evidence is made from and in which states of the document it exists: the document as it was built and what the
// authority answered to its acceptance exist once the document is accepted (and stay when it is voided), the answer to the invalidation
// only once it is voided.
const KIND_STATES: Record<FiscalEvidenceKind, readonly FiscalDocumentStatus[]> = {
  [FiscalEvidenceKind.DOCUMENT]: [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.VOIDED],
  [FiscalEvidenceKind.RESPONSE]: [FiscalDocumentStatus.ACCEPTED, FiscalDocumentStatus.VOIDED],
  [FiscalEvidenceKind.VOID_RESPONSE]: [FiscalDocumentStatus.VOIDED]
}

export const isEvidenceKind = (value: string): value is FiscalEvidenceKind =>
  (Object.values(FiscalEvidenceKind) as string[]).includes(value)

// The evidence of a fiscal document as files of `Media` (TDD_18 §8.3, Step 4B.7b-2): the file is made from the row of the document (which is
// immutable once accepted, so it is always the same file), put in the bucket, written down once per kind (the database says it) and scanned
// like any file before anybody is given a link. The files hold the receiver's data: they are served by a signed link to whoever reads the
// fiscal documents, in the store of the document, and are never deleted (the database says that too).
// Keeping evidence never decides the document: the authority has answered already, and a file that cannot be made now is made the next
// time somebody asks for it (`keep` is safe to repeat), with the sealed copy in the row as the source.
@Injectable()
export class FiscalEvidenceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: CredentialCipher,
    private readonly storage: StorageService,
    @InjectQueue(QueueNames.HEAVY_PROCESSING) private readonly heavyQueue: Queue<ScanFileJob>,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(FiscalEvidenceService.name)
  }

  // After the document was accepted or voided: every kind the document has. A failure of one never stops the others and never reaches
  // the caller (the decision is made; the evidence is made again when it is asked for).
  async keepAll(organizationId: string, documentId: string): Promise<void> {
    for (const kind of Object.values(FiscalEvidenceKind)) {
      try {
        await this.keep(organizationId, documentId, kind)
      } catch (error) {
        this.logger.error(
          { documentId, kind, err: errorName(error) },
          'the evidence of a fiscal document could not be kept'
        )
      }
    }
  }

  // The file of one kind of evidence of a document of the organization, made when it does not exist yet. Null when the document has no
  // such evidence (it is not in a state that has it, or it is a document of another organization).
  async keep(
    organizationId: string,
    documentId: string,
    kind: FiscalEvidenceKind
  ): Promise<{ mediaId: string } | null> {
    const doc = await this.prisma.client.fiscalDocument.findFirst({
      where: { id: documentId, organizationId },
      select: {
        id: true,
        storeId: true,
        status: true,
        sequenceNumber: true,
        documentType: true,
        externalNumber: true,
        providerData: true,
        builtPayloadEncrypted: true,
        response: true,
        voidReason: true,
        voidedAt: true,
        voidResponse: true,
        issuedAt: true
      }
    })
    if (doc === null || !KIND_STATES[kind].includes(doc.status as FiscalDocumentStatus)) return null
    const existing = await this.prisma.client.media.findFirst({
      where: { fiscalDocumentId: doc.id, fiscalEvidenceKind: kind },
      select: { id: true }
    })
    if (existing !== null) return { mediaId: existing.id }

    const content = this.contentOf(kind, doc)
    if (content === null) return null
    const bytes = Buffer.from(JSON.stringify(content), 'utf8')
    if (bytes.byteLength > FiscalLimits.EVIDENCE_MAX_BYTES) {
      this.logger.error(
        { documentId, kind, bytes: bytes.byteLength },
        'the evidence of a fiscal document is larger than what is kept as a file'
      )
      return null
    }
    const mediaId = randomUUID()
    const filename = `fiscal-${doc.sequenceNumber}-${kind}.json`
    const key = StorageKeys.fiscalEvidence(doc.storeId, doc.id, mediaId, filename)
    await this.storage.put(key, bytes, FiscalEvidenceContentType)
    try {
      await this.prisma.client.media.create({
        data: {
          id: mediaId,
          storeId: doc.storeId,
          purpose: MediaPurpose.FISCAL_EVIDENCE,
          fiscalDocumentId: doc.id,
          fiscalEvidenceKind: kind,
          key,
          filename,
          contentType: FiscalEvidenceContentType,
          fileSize: bytes.byteLength,
          status: MediaStatus.PENDING
        }
      })
    } catch (error) {
      // The object is not the file of any row: it goes, whatever the reason
      await this.storage.delete(key).catch(() => undefined)
      if (!isUniqueViolation(error)) throw error
      // Another request kept the same evidence first: it is the one
      const winner = await this.prisma.client.media.findFirst({
        where: { fiscalDocumentId: doc.id, fiscalEvidenceKind: kind },
        select: { id: true }
      })
      return winner === null ? null : { mediaId: winner.id }
    }
    // Scanned like any file: nobody is given a link before it is clean. A queue that blinks leaves a pending file that the sweep of stuck
    // scans of the media cleanup asks again.
    await this.heavyQueue
      .add(JobNames.SCAN_FILE, { mediaId }, { jobId: `${JobNames.SCAN_FILE}-${mediaId}` })
      .catch((error: unknown) => {
        this.logger.warn(
          { mediaId, err: errorName(error) },
          'the scan of a fiscal evidence file was not queued'
        )
      })
    return { mediaId }
  }

  // The content of a kind, read from the row. The built document is sealed in the row (it holds the receiver): it is opened here and
  // written as the evidence, a file only the people who read the fiscal documents are given a link to. A row whose sealed copy cannot be
  // opened has no document evidence to make (null), never an empty one.
  private contentOf(
    kind: FiscalEvidenceKind,
    doc: {
      documentType: string
      externalNumber: string | null
      providerData: unknown
      builtPayloadEncrypted: Uint8Array | null
      response: unknown
      voidReason: string | null
      voidedAt: Date | null
      voidResponse: unknown
      issuedAt: Date | null
      sequenceNumber: number
    }
  ): Record<string, unknown> | null {
    if (kind === FiscalEvidenceKind.DOCUMENT) {
      if (doc.builtPayloadEncrypted === null) return null
      let payload: Record<string, unknown>
      try {
        payload = this.cipher.open(doc.builtPayloadEncrypted)
      } catch {
        return null
      }
      if (payload['unreadable'] === true) return null
      return {
        sequenceNumber: doc.sequenceNumber,
        documentType: doc.documentType,
        externalNumber: doc.externalNumber,
        issuedAt: doc.issuedAt?.toISOString() ?? null,
        payload: record(toJson(payload))
      }
    }
    if (kind === FiscalEvidenceKind.RESPONSE) {
      return {
        sequenceNumber: doc.sequenceNumber,
        externalNumber: doc.externalNumber,
        providerData: doc.providerData ?? null,
        response: doc.response ?? null
      }
    }
    if (doc.voidedAt === null) return null
    return {
      sequenceNumber: doc.sequenceNumber,
      externalNumber: doc.externalNumber,
      voidedAt: doc.voidedAt.toISOString(),
      voidReason: doc.voidReason,
      response: doc.voidResponse ?? null
    }
  }
}
