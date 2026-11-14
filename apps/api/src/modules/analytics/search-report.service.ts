import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { AnalyticsEventNames } from '@platform/core/analytics'
import { PrismaService } from '@platform/core/database'
import {
  SearchReportConfig,
  type SearchTrackedScope,
  SearchTrackedScopes
} from '@platform/core/domain'

export interface SearchReportScope {
  scope: SearchTrackedScope
  // The searches of the kind that were counted: the palette's as-you-type ones are not (SearchApiParams)
  searches: number
  // Of those, the ones that found nothing
  zeroResults: number
  // The results opened after a search of the kind, the palette's included
  clicks: number
}

export interface SearchReport {
  days: number
  scopes: SearchReportScope[]
  // What was looked for in the catalog and not found, most asked first. Only the product searches keep their text:
  // what was asked of people, conversations, orders or the global search is a hash, so it cannot be listed.
  zeroResultQueries: { query: string; occurrences: number }[]
}

const scopeRowSchema = z.object({
  scope: z.string(),
  searches: z.number().int(),
  zero_results: z.number().int(),
  clicks: z.number().int()
})
const zeroRowSchema = z.object({ query: z.string(), occurrences: z.number().int() })

// What was searched in the store, read from `analytics_events` (TDD_08 §5.6): the volume of each kind of search, how many
// found nothing, how many ended in a click, and the texts of the catalog nobody found. The store is the one TenantGuard
// resolved and every statement filters by it; the window is a bind parameter, never spliced, counted in UTC days on `date` (the column the index of the table leads with after the store and the event): `days` = 1 is today.
@Injectable()
export class SearchReportService {
  constructor(private readonly prisma: PrismaService) {}

  async report(storeId: string, days: number): Promise<SearchReport> {
    // One after the other: the two statements share the connection of the request, so running them together only queues one
    const scopeRows = await this.prisma.client.$queryRaw<unknown[]>`
        SELECT data->>'scope' AS scope,
               COUNT(*) FILTER (WHERE event = ${AnalyticsEventNames.SEARCH_PERFORMED})::int AS searches,
               COUNT(*) FILTER (
                 WHERE event = ${AnalyticsEventNames.SEARCH_PERFORMED} AND (data->>'resultCount')::int = 0
               )::int AS zero_results,
               COUNT(*) FILTER (WHERE event = ${AnalyticsEventNames.SEARCH_CLICKED})::int AS clicks
        FROM analytics_events
        WHERE store_id = ${storeId}
          AND event IN (${AnalyticsEventNames.SEARCH_PERFORMED}, ${AnalyticsEventNames.SEARCH_CLICKED})
          AND date > (NOW() AT TIME ZONE 'UTC')::date - ${days}::int
        GROUP BY data->>'scope'
      `
    // One row for each text as the hash folds it (case, accents and spacing), under the spelling asked most recently
    const zeroRows = await this.prisma.client.$queryRaw<unknown[]>`
        SELECT (ARRAY_AGG(data->>'query' ORDER BY timestamp DESC))[1] AS query, COUNT(*)::int AS occurrences
        FROM analytics_events
        WHERE store_id = ${storeId}
          AND event = ${AnalyticsEventNames.SEARCH_PERFORMED}
          AND data->>'scope' = ${SearchTrackedScopes.PRODUCTS}
          AND (data->>'resultCount')::int = 0
          AND data->>'query' IS NOT NULL
          AND date > (NOW() AT TIME ZONE 'UTC')::date - ${days}::int
        GROUP BY data->>'queryHash'
        ORDER BY occurrences DESC, query ASC
        LIMIT ${SearchReportConfig.ZERO_RESULT_LIMIT}
      `
    const byScope = new Map(
      scopeRows.map(row => scopeRowSchema.parse(row)).map(row => [row.scope, row])
    )
    return {
      days,
      // Every kind has its row, even with no search: the screen does not draw a table that changes shape
      scopes: Object.values(SearchTrackedScopes).map(scope => {
        const row = byScope.get(scope)
        return {
          scope,
          searches: row?.searches ?? 0,
          zeroResults: row?.zero_results ?? 0,
          clicks: row?.clicks ?? 0
        }
      }),
      zeroResultQueries: zeroRows.map(row => zeroRowSchema.parse(row))
    }
  }
}
