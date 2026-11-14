import { createHmac, randomUUID } from 'node:crypto'

import { InjectQueue } from '@nestjs/bullmq'
import { Inject, Injectable } from '@nestjs/common'
import type { Queue } from 'bullmq'
import { PinoLogger } from 'nestjs-pino'

import { AnalyticsEventNames } from '@platform/core/analytics'
import {
  foldForSearch,
  SEARCH_HASH_KEY,
  type SearchEventData,
  type SearchTrackedScope,
  SearchTrackedScopes,
  SearchTracking
} from '@platform/core/domain'
import { JobNames, QueueNames, type TrackAnalyticsJob } from '@platform/core/queues'

// Every search leaves one `search.performed` event in the analytics queue (TDD_08 §5.6): what was asked (a hash of the
// folded text), of what, how many results and how long it took. The text itself is kept only when nothing was found,
// which is what the zero-result report is for. A search never waits for this and never fails because of it: the
// queue being down costs an event, not an answer.
@Injectable()
export class SearchTracker {
  constructor(
    @InjectQueue(QueueNames.ANALYTICS) private readonly queue: Queue<TrackAnalyticsJob>,
    @Inject(SEARCH_HASH_KEY) private readonly hashKey: string,
    private readonly logger: PinoLogger
  ) {
    this.logger.setContext(SearchTracker.name)
  }

  // Events not yet taken by the queue. A queue whose connection is down keeps its promises pending, so the count is
  // capped: past it an event is dropped, which costs a row of a report and never memory or an answer.
  private inFlight = 0

  track(
    storeId: string,
    scope: SearchTrackedScope,
    query: string,
    resultCount: number,
    startedAt: number
  ): void {
    const data: SearchEventData = {
      queryHash: queryHashOf(this.hashKey, storeId, query),
      scope,
      resultCount,
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      ...(resultCount === 0 && mayKeepText(scope, query) ? { query: capUnits(query) } : {})
    }
    if (this.inFlight >= SearchTracking.MAX_IN_FLIGHT) return this.logBacklog(scope)
    this.inFlight++
    try {
      void this.queue
        .add(JobNames.TRACK_SEARCH, {
          event: AnalyticsEventNames.SEARCH_PERFORMED,
          storeId,
          data,
          timestamp: new Date().toISOString(),
          // A job delivered again after a stalled worker carries the same key and writes no second row
          eventKey: randomUUID()
        })
        .catch((error: unknown) => this.logQueueFailure(error, scope))
        .finally(() => {
          this.inFlight--
        })
    } catch (error) {
      this.inFlight--
      // A queue that throws at once (closed, not connected) is the same: the search was answered
      this.logQueueFailure(error, scope)
    }
  }

  private logBacklog(scope: SearchTrackedScope): void {
    this.logger.debug({ scope }, 'a search event was dropped: the analytics queue is backed up')
  }

  private logQueueFailure(error: unknown, scope: SearchTrackedScope): void {
    this.logger.warn({ err: error, scope }, 'a search event could not be queued')
  }
}

// The text of a search that found nothing is kept for the zero-result report (what the store sells that people ask for
// and it does not have), which is about products, not about people. What was asked of the customers, the messages, the
// orders or the global search (where a name is as likely as a product) is only a hash, and so is any text that is an
// email address or a phone number: analytics rows are tied to no customer, so an erasure could not reach a name, an
// email or a phone left in them.
// A stretch of the text with no letter in it that holds seven digits or more, whatever separates them (spaces, dashes,
// commas, slashes): a phone number, a document or an account. "ana 71234567" and "7123 - 4567" are personal, "talla 42
// modelo 2026" is not.
function hasPersonalDigits(query: string): boolean {
  return query
    .split(/\p{L}/u)
    .some(stretch => stretch.replace(/\D/g, '').length >= SearchTracking.PERSONAL_DIGITS)
}

export function mayKeepText(scope: SearchTrackedScope, query: string): boolean {
  if (scope !== SearchTrackedScopes.PRODUCTS) return false
  // A run of digits anywhere is a phone number, a document or an account: "ana 71234567" is as personal as "71234567"
  return !query.includes('@') && !hasPersonalDigits(query)
}

// At most QUERY_MAX_LENGTH UTF-16 units (what the worker's schema counts), never cutting a character in two: a lone
// half of a surrogate pair is not valid text for the database
export function capUnits(query: string): string {
  let kept = ''
  for (const character of query) {
    if (kept.length + character.length > SearchTracking.QUERY_MAX_LENGTH) break
    kept += character
  }
  return kept
}

// The same text with other case, accents or spacing is one hash, and it is another in each store
export function queryHashOf(key: string, storeId: string, query: string): string {
  return createHmac('sha256', key)
    .update(`search-query:${storeId}:${foldForSearch(query).replaceAll(/\s+/g, ' ').trim()}`)
    .digest('hex')
    .slice(0, SearchTracking.HASH_LENGTH)
}
