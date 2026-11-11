import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Injectable } from '@nestjs/common'
import type { Counter } from '@prometheus-io/client'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'
import { z } from 'zod'

import { CredentialCipher } from '@platform/core/crypto'
import { PrismaService } from '@platform/core/database'
import {
  CarrierCapability,
  CarrierConnectionStatus,
  CarrierWebhookLimits,
  uuidSchema
} from '@platform/core/domain'
import { ErrorCodes, HttpStatusCodes, PlatformException } from '@platform/core/errors'
import { MetricNames } from '@platform/core/metrics'
import { InjectMetric } from '@platform/core/metrics-module'
import { JobNames, QueueNames } from '@platform/core/queues'
import {
  CarrierRegistry,
  carrierEventSchema,
  type ProcessCarrierEventJob
} from '@platform/plugins/runtime'
import type { CarrierPlugin } from '@platform/plugins/sdk'

// Why a request was not taken, for the metric and the log. Never part of the answer: all of them are the same 401.
export const CarrierWebhookRejections = {
  MALFORMED_ADDRESS: 'malformed_address',
  UNKNOWN_CONNECTION: 'unknown_connection',
  DISCONNECTED: 'disconnected',
  NO_WEBHOOK: 'no_webhook',
  NO_RAW_BODY: 'no_raw_body',
  VERIFIER_FAILED: 'verifier_failed',
  EVENT_DROPPED: 'event_dropped',
  SECRET_UNREADABLE: 'secret_unreadable',
  BAD_SIGNATURE: 'bad_signature',
  BODY_TOO_LARGE: 'body_too_large'
} as const
type Rejection = (typeof CarrierWebhookRejections)[keyof typeof CarrierWebhookRejections]

const secretSchema = z.object({ secret: z.string().min(1) })

// Compared with the real thing when the connection is not usable, so that "no such connection" does not answer measurably
// faster than "bad signature". A key that lives and dies with the process.
const DECOY_KEY = randomBytes(32)

function invalid(): PlatformException {
  return new PlatformException(
    ErrorCodes.CARRIER_WEBHOOK_SIGNATURE_INVALID,
    'invalid signature',
    HttpStatusCodes.UNAUTHORIZED
  )
}

// The signature check of the plugin, with the secret of the connection as its key. A throw is a refusal, not a 500 (what it
// cannot verify it does not trust), but it is told apart from a bad signature: a plugin whose check throws on every call
// would otherwise look like an attack.
function verification(
  plugin: Pick<CarrierPlugin, 'validateWebhookSignature'>,
  body: string,
  headers: Record<string, string>,
  secret: string
): 'valid' | 'invalid' | 'failed' {
  try {
    return plugin.validateWebhookSignature?.(body, headers, secret) === true ? 'valid' : 'invalid'
  } catch {
    return 'failed'
  }
}

// The public door of the carriers (TDD_17 §4.9): the webhook of a connection. The signature, checked with the secret of the
// connection, is what authenticates it; the store is the one of that connection and never a value of the request. It
// verifies, normalizes through the plugin, queues one job per event and returns, because a carrier retries what it does not
// hear back about quickly. Everything that is not a good signature on a live connection is the same answer.
@Injectable()
export class CarrierWebhookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: CarrierRegistry,
    private readonly cipher: CredentialCipher,
    @InjectQueue(QueueNames.WEBHOOKS) private readonly queue: Queue<ProcessCarrierEventJob>,
    @InjectMetric(MetricNames.CARRIER_WEBHOOK_RECEIVED) private readonly received: Counter<string>,
    @InjectMetric(MetricNames.CARRIER_WEBHOOK_REJECTED) private readonly rejected: Counter<string>,
    private readonly logger: PinoLogger
  ) {
    // Not @InjectPinoLogger(name): see ProcessorSupport
    this.logger.setContext(CarrierWebhookService.name)
  }

  async receive(
    connectionId: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string>,
    body: unknown,
    correlationId?: string
  ): Promise<void> {
    // The size is checked before anything reads a row: it says nothing about any connection
    if (rawBody !== undefined && rawBody.length > CarrierWebhookLimits.MAX_BODY_BYTES) {
      this.reject(CarrierWebhookRejections.BODY_TOO_LARGE)
      throw new PlatformException(
        ErrorCodes.PAYLOAD_TOO_LARGE,
        'the body is too large',
        HttpStatusCodes.PAYLOAD_TOO_LARGE
      )
    }
    // The signature is over the exact bytes: a request the api kept no bytes of (a type it does not capture) is not one that
    // can be verified, and an empty string must never stand in for its body
    if (rawBody === undefined) {
      this.reject(CarrierWebhookRejections.NO_RAW_BODY)
      throw invalid()
    }
    const raw = rawBody.toString('utf8')
    const target = await this.targetOf(connectionId)
    if ('rejection' in target) {
      // The comparison is made anyway, against a key nobody has
      const decoy = createHmac('sha256', DECOY_KEY).update(raw).digest()
      timingSafeEqual(
        decoy,
        createHmac('sha256', DECOY_KEY)
          .update(headers['x-signature'] ?? '')
          .digest()
      )
      this.reject(target.rejection)
      throw invalid()
    }
    const { connection, plugin, secret } = target
    const outcome = verification(plugin, raw, headers, secret)
    if (outcome !== 'valid') {
      this.reject(
        outcome === 'failed'
          ? CarrierWebhookRejections.VERIFIER_FAILED
          : CarrierWebhookRejections.BAD_SIGNATURE,
        connection.carrierId
      )
      throw invalid()
    }
    this.received.inc({ carrier: connection.carrierId })

    const events = await this.normalize(connection.carrierId, plugin, body)
    if (events.length === 0) return
    const receivedAt = new Date().toISOString()
    const jobs = events.map(event => ({
      name: JobNames.PROCESS_CARRIER_EVENT,
      data: {
        storeId: connection.storeId,
        connectionId: connection.id,
        event,
        receivedAt,
        ...(correlationId === undefined ? {} : { correlationId })
      }
      // No job id on purpose: a retry of the carrier must be able to queue an event whose first job failed. What makes a
      // duplicate harmless is the dedupe of the status engine (Step 4.8 PR C2c)
    }))
    // Every event of a body is queued, however many: the size of the body is what bounds them
    for (let i = 0; i < jobs.length; i += CarrierWebhookLimits.BULK_CHUNK) {
      await this.queue.addBulk(jobs.slice(i, i + CarrierWebhookLimits.BULK_CHUNK))
    }
  }

  // The live connection the address names, with its plugin and the secret opened for this call only. The connection is read
  // by its id alone: the request has no store to filter by, and the signature is what proves it belongs to the caller.
  private async targetOf(connectionId: string): Promise<
    | { rejection: Rejection }
    | {
        connection: { id: string; storeId: string; carrierId: string }
        plugin: NonNullable<ReturnType<CarrierRegistry['find']>>
        secret: string
      }
  > {
    if (!uuidSchema.safeParse(connectionId).success) {
      return { rejection: CarrierWebhookRejections.MALFORMED_ADDRESS }
    }
    const row = await this.prisma.client.carrierConnection.findUnique({
      where: { id: connectionId },
      select: { id: true, storeId: true, carrierId: true, status: true, webhookSecret: true }
    })
    if (row === null) return { rejection: CarrierWebhookRejections.UNKNOWN_CONNECTION }
    // A connection that was let go has no secret and takes nothing, whatever arrives for it (one with a failing health check
    // still gets what its carrier pushes: the status of its packages does not wait for the credentials)
    if (row.status === String(CarrierConnectionStatus.DISABLED) || row.webhookSecret === null) {
      return { rejection: CarrierWebhookRejections.DISCONNECTED }
    }
    const plugin = this.registry.find(row.carrierId)
    if (
      plugin === undefined ||
      !this.registry.hasCapability(plugin.id, CarrierCapability.WEBHOOK_STATUS) ||
      plugin.handleWebhook === undefined ||
      plugin.validateWebhookSignature === undefined
    ) {
      return { rejection: CarrierWebhookRejections.NO_WEBHOOK }
    }
    try {
      const opened = secretSchema.parse(this.cipher.open(row.webhookSecret))
      return {
        connection: { id: row.id, storeId: row.storeId, carrierId: row.carrierId },
        plugin,
        secret: opened.secret
      }
    } catch (error) {
      // The key was rotated or the row is damaged: the owner has to make a new secret. Said, with no id of the secret.
      this.logger.error(
        { err: error, connectionId: row.id },
        'the webhook secret of a connection cannot be read'
      )
      return { rejection: CarrierWebhookRejections.SECRET_UNREADABLE }
    }
  }

  // A body the plugin cannot read is acknowledged and said, not failed: the signature is good, so it is the carrier's real
  // request, and a 500 would have it sent again for ever. What the plugin returns is not trusted either: an event that
  // does not fit is left out and said, and the rest goes on.
  private async normalize(
    carrierId: string,
    plugin: NonNullable<ReturnType<CarrierRegistry['find']>>,
    body: unknown
  ): Promise<ProcessCarrierEventJob['event'][]> {
    let candidates: unknown
    try {
      candidates = await plugin.handleWebhook?.(body)
    } catch (error) {
      this.logger.error({ err: error, carrierId }, 'a carrier plugin could not read a webhook body')
      return []
    }
    if (!Array.isArray(candidates)) {
      this.logger.error(
        { carrierId },
        'a carrier plugin returned something that is not a list of events'
      )
      return []
    }
    const events: ProcessCarrierEventJob['event'][] = []
    for (const candidate of candidates as unknown[]) {
      const parsed = carrierEventSchema.safeParse(candidate)
      if (!parsed.success) {
        // Counted: the carrier is answered 200 (the signature was good), so this is the only trace of a lost status
        this.reject(CarrierWebhookRejections.EVENT_DROPPED, carrierId)
        this.logger.warn(
          { carrierId, issues: parsed.error.issues.map(issue => issue.path.join('.')) },
          'event of a carrier plugin left out: it does not fit its schema'
        )
        continue
      }
      events.push(parsed.data)
    }
    return events
  }

  private reject(reason: Rejection, carrierId?: string): void {
    this.rejected.inc({ reason })
    // No address and no body: the id of a connection a stranger guessed says nothing a log needs
    this.logger.warn(
      { reason, ...(carrierId === undefined ? {} : { carrierId }) },
      'carrier webhook rejected'
    )
  }
}
