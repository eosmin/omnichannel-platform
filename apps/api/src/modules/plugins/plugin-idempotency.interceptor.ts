import {
  type CallHandler,
  type ExecutionContext,
  Injectable,
  type NestInterceptor
} from '@nestjs/common'
import type { Response } from 'express'
import { PinoLogger } from 'nestjs-pino'
import { catchError, from, map, mergeMap, type Observable, of, throwError } from 'rxjs'

import { DatabaseNull, PrismaService, type TenantContext } from '@platform/core/database'
import {
  PluginIdempotency,
  PluginIdempotencyConflicts,
  PluginIdempotencyState
} from '@platform/core/domain'
import {
  ErrorCodes,
  errorName,
  HttpStatusCodes,
  PlatformException,
  resourceConflict
} from '@platform/core/errors'
import type { AuthenticatedRequest } from '@platform/core/logger'

import { idempotencyKeyOf, requestFingerprint } from './plugin-idempotency'

const HOUR_MS = 3_600_000

// What JSON.parse gives back, and what the Json column takes
type Json = string | number | boolean | (Json | null)[] | { [key: string]: Json | null }

// What the claim of a key decided
type Claim = { kind: 'run'; claimedAt: Date } | { kind: 'replay'; status: number; body: unknown }

interface Subject {
  tenant: TenantContext
  storeId: string
  installationId: string
  key: string
}

// The idempotency of the writes of a plugin (Step 7.3 S4, TDD_10 §6.7). A POST, PUT, PATCH or DELETE of the plugin API that carries
// `Idempotency-Key` is made once per installation and key: the first call claims the key, runs, and keeps its answer for
// PluginIdempotency.TTL_HOURS; the same call again gets that answer (status and body, with `Idempotent-Replayed: true`) and the route
// does not run. The same key on another request (other route, parameters or body) is a 409, never the first call's answer. A call
// that is still running makes a second one with its key wait with a 409; a call that failed removes its claim, so the retry runs. A
// route with no key behaves as it always did. It runs after PluginApiKeyGuard (which says who the installation is), inside the
// transaction of the request when the switch of the context is on.
//
// With the switch of the context on, the claim, the write and the answer are one transaction (one connection): a failed call rolls
// back its claim, and a concurrent call with the same key waits on the unique index until it commits. With the switch off, the claim
// and its removal are units of their own, so a concurrent call sees the claim at once; what is left open is that a process that dies
// between the write and the answer leaves a claim that, after STALE_CLAIM_SECONDS, a retry takes and runs again (plan, Step 7.3-S4).
// rls-context: the table is read and written inside the context of the store of the installation (the one the guard resolved)
@Injectable()
export class PluginIdempotencyInterceptor implements NestInterceptor {
  constructor(
    private readonly prisma: PrismaService,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(PluginIdempotencyInterceptor.name)
  }

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') return next.handle()
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>()
    const header = request.headers[PluginIdempotency.HEADER]
    if (
      header === undefined ||
      !(PluginIdempotency.METHODS as readonly string[]).includes(request.method)
    ) {
      return next.handle()
    }
    const { pluginInstallation: installation, store } = request
    // Only the guard of the plugin API sets them: with neither, this is not a route of a plugin and the header means nothing
    if (installation === undefined || store === undefined) return next.handle()
    const key = idempotencyKeyOf(header)
    if (key === null) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        `${PluginIdempotency.HEADER} must be 1 to ${PluginIdempotency.KEY_MAX_LENGTH} visible ASCII characters`,
        HttpStatusCodes.BAD_REQUEST
      )
    }
    // The fingerprint reads the parsed body: a file or other raw body would leave only the method and the address in it, and a key reused
    // with another file would get the first answer. A key is for a JSON body (or none).
    const contentType = request.headers['content-type']
    if (
      typeof contentType === 'string' &&
      !/^application\/(?:[\w.+-]+\+)?json\b/i.test(contentType)
    ) {
      throw new PlatformException(
        ErrorCodes.VALIDATION_INVALID_INPUT,
        `${PluginIdempotency.HEADER} is only for a JSON body`,
        HttpStatusCodes.BAD_REQUEST
      )
    }
    const subject: Subject = {
      tenant: { storeIds: [store.id], organizationIds: [store.organizationId] },
      storeId: store.id,
      installationId: installation.id,
      key
    }
    const response = context.switchToHttp().getResponse<Response>()
    const claim = await this.claim(subject, requestFingerprint(request))
    if (claim.kind === 'replay') {
      response.status(claim.status)
      response.setHeader(PluginIdempotency.REPLAY_HEADER, PluginIdempotency.REPLAY_VALUE)
      return of(claim.body)
    }
    return next.handle().pipe(
      // Before the close: a failure of the close must not remove a claim whose write is done
      catchError((error: unknown) =>
        from(this.release(subject, claim.claimedAt)).pipe(mergeMap(() => throwError(() => error)))
      ),
      mergeMap((body: unknown) =>
        from(this.close(subject, claim.claimedAt, response.statusCode, body)).pipe(map(() => body))
      )
    )
  }

  private async claim(subject: Subject, requestHash: string): Promise<Claim> {
    const { storeId, installationId, key } = subject
    const now = new Date()
    const expiresAt = new Date(now.getTime() + PluginIdempotency.TTL_HOURS * HOUR_MS)
    const staleBefore = new Date(now.getTime() - PluginIdempotency.STALE_CLAIM_SECONDS * 1000)
    return this.inUnit(subject, async () => {
      const table = this.prisma.client.pluginIdempotencyKey
      const made = await table.createMany({
        data: [
          {
            storeId,
            installationId,
            key,
            requestHash,
            state: PluginIdempotencyState.IN_PROGRESS,
            claimedAt: now,
            expiresAt
          }
        ],
        skipDuplicates: true
      })
      if (made.count === 1) return { kind: 'run', claimedAt: now }
      const row = await table.findFirst({ where: { storeId, installationId, key } })
      // Removed by the cleanup between the two statements: the retry finds it free
      if (row === null) throw this.conflict(PluginIdempotencyConflicts.IN_PROGRESS)
      const abandoned =
        row.expiresAt <= now ||
        (row.state === PluginIdempotencyState.IN_PROGRESS && row.claimedAt <= staleBefore)
      if (abandoned) {
        // Only the call that read this very claim takes it
        const taken = await table.updateMany({
          where: {
            id: row.id,
            storeId,
            claimedAt: row.claimedAt,
            // What was read, not only the claim: a call that closed it since then is not taken
            state: row.state,
            expiresAt: row.expiresAt
          },
          data: {
            requestHash,
            state: PluginIdempotencyState.IN_PROGRESS,
            responseStatus: null,
            responseBody: DatabaseNull,
            responseOmitted: false,
            claimedAt: now,
            expiresAt
          }
        })
        if (taken.count !== 1) throw this.conflict(PluginIdempotencyConflicts.IN_PROGRESS)
        return { kind: 'run', claimedAt: now }
      }
      if (row.requestHash !== requestHash)
        throw this.conflict(PluginIdempotencyConflicts.KEY_REUSED)
      if (row.state !== PluginIdempotencyState.COMPLETED) {
        throw this.conflict(PluginIdempotencyConflicts.IN_PROGRESS)
      }
      if (row.responseOmitted || row.responseStatus === null) {
        throw this.conflict(PluginIdempotencyConflicts.RESULT_NOT_KEPT)
      }
      return {
        kind: 'replay',
        status: row.responseStatus,
        body: (row.responseBody as unknown) ?? undefined
      }
    })
  }

  // Keeps the answer for the replay. Where the route wrote: inside the transaction of the request when it has one, so a request that
  // rolls back leaves a claim and no answer (the claim goes stale and the retry runs), never an answer for a write that did not happen.
  private async close(
    subject: Subject,
    claimedAt: Date,
    status: number,
    body: unknown
  ): Promise<void> {
    const { storeId, installationId, key } = subject
    try {
      // An answer that is not JSON (or is too big) is not kept: the write is done, and a replay says so
      let json: string | undefined
      let omitted = false
      try {
        json = body === undefined ? undefined : JSON.stringify(body)
        omitted = json !== undefined && Buffer.byteLength(json) > PluginIdempotency.BODY_MAX_BYTES
      } catch {
        omitted = true
      }
      const parsed = json === undefined || omitted ? null : (JSON.parse(json) as Json | null)
      const write = () =>
        this.prisma.client.pluginIdempotencyKey.updateMany({
          where: {
            storeId,
            installationId,
            key,
            claimedAt,
            state: PluginIdempotencyState.IN_PROGRESS
          },
          data: {
            state: PluginIdempotencyState.COMPLETED,
            responseStatus: status,
            responseBody: parsed === null ? DatabaseNull : parsed,
            responseOmitted: omitted
          }
        })
      await this.inUnit(subject, write)
      if (omitted) {
        this.logger.warn(
          { installationId },
          'the answer of a write with an idempotency key was too big to keep'
        )
      }
    } catch (error) {
      // The write is done and the plugin gets its answer: the claim stays and, until it goes stale, a retry waits instead of repeating
      this.logger.error(
        { installationId, errorName: errorName(error) },
        'the answer of a write with an idempotency key could not be kept'
      )
    }
  }

  // The call failed: the key is free again for the retry. Never throws: the error of the call is the one that matters. Inside the
  // transaction of the request there is nothing to remove: the request rolls back, and the claim with it.
  private async release(subject: Subject, claimedAt: Date): Promise<void> {
    if (this.prisma.hasTenantContext()) return
    const { storeId, installationId, key } = subject
    try {
      await this.prisma.tenantTransaction(subject.tenant, () =>
        this.prisma.client.pluginIdempotencyKey.deleteMany({
          where: {
            storeId,
            installationId,
            key,
            claimedAt,
            state: PluginIdempotencyState.IN_PROGRESS
          }
        })
      )
    } catch (error) {
      this.logger.error(
        { installationId, errorName: errorName(error) },
        'the claim of an idempotency key could not be released'
      )
    }
  }

  // In the transaction of the request when it has one (the switch of the context is on): one connection, and the claim, the write and
  // the answer stand or fall together. With no transaction, each step is a unit of its own, so a concurrent call sees the claim at once.
  private inUnit<T>(subject: Subject, work: () => Promise<T>): Promise<T> {
    return this.prisma.hasTenantContext()
      ? work()
      : this.prisma.tenantTransaction(subject.tenant, work)
  }

  private conflict(reason: string): PlatformException {
    const messages: Record<string, string> = {
      [PluginIdempotencyConflicts.KEY_REUSED]: 'this idempotency key was used for another request',
      [PluginIdempotencyConflicts.IN_PROGRESS]:
        'the request with this idempotency key is still running',
      [PluginIdempotencyConflicts.RESULT_NOT_KEPT]:
        'the request with this idempotency key was done, but its answer was too big to keep'
    }
    return resourceConflict(messages[reason] ?? reason, { reason })
  }
}
