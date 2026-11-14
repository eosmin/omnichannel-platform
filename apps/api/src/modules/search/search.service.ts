import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { type Permission, Permissions } from '@platform/core/auth'
import { PrismaService, SEARCH_LANGUAGE_SQL } from '@platform/core/database'
import {
  ConversationHiddenStatuses,
  MessageType,
  SearchConfig,
  SearchSnippetMarks
} from '@platform/core/domain'
import { escapeLike, foldInDatabase, phoneDigitsOf } from '@platform/core/messaging'

import type {
  CustomerSearchHit,
  MessageSearchHit,
  OrderSearchHit,
  SearchResult
} from './search.views'

// What the raw statements below return is read through these: a boundary, never trusted
const messageRow = z.object({
  id: z.string(),
  conversation_id: z.string(),
  type: z.string(),
  created_at: z.date(),
  customer_id: z.string(),
  customer_name: z.string().nullable(),
  snippet: z.string()
})
const customerRow = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable()
})
const orderRow = z.object({
  id: z.string(),
  order_number: z.string(),
  status: z.string(),
  total_cents: z.number(),
  currency: z.string(),
  created_at: z.date(),
  customer_id: z.string(),
  customer_name: z.string().nullable()
})

// Who is asking, as far as what they may read: the permissions of the request and who they are
export interface SearchViewer {
  userId: string
  held: readonly Permission[]
}

const SNIPPET_OPTIONS =
  `StartSel=${SearchSnippetMarks.START}, StopSel=${SearchSnippetMarks.STOP}, ` +
  `MaxWords=${SearchConfig.SNIPPET_MAX_WORDS}, MinWords=${SearchConfig.SNIPPET_MIN_WORDS}`

// The search of the store of the request (TDD_08 §5.4). Every statement filters by the store that TenantGuard put in
// the request, never by anything in the query string, and the text is ALWAYS a bind parameter, with the wildcards of
// LIKE (% _ and the backslash) escaped, so it is only ever read as the characters it is. The one piece of SQL that is
// spliced in is the text-search configuration, a constant of the platform. Everything is read accent-insensitive: the
// text and the stored text are folded the same way (`immutable_unaccent`, migration search_unaccent).
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  // The messages of the conversations the viewer may see. What a message search must NOT show is decided here, in the
  // statement: deleted messages (the text stays until the retention sweep, but it is not shown), internal notes for
  // who may not read them, conversations assigned to someone else for who may not see all, and the hidden ones (spam,
  // archived) for who may not archive. Without that, search would be a way around every rule of the thread.
  async searchMessages(
    storeId: string,
    viewer: SearchViewer,
    params: { q: string; limit: number; conversationId?: string }
  ): Promise<SearchResult<MessageSearchHit>> {
    const canViewAll = viewer.held.includes(Permissions.CONVERSATIONS_VIEW_ALL)
    const canSeeHidden = viewer.held.includes(Permissions.CONVERSATIONS_ARCHIVE)
    const canReadNotes = viewer.held.includes(Permissions.MESSAGES_INTERNAL_NOTE)
    // The line of an order says its number and its total: only who may read orders finds it (as the thread shows it)
    const canReadOrders = viewer.held.includes(Permissions.ORDERS_VIEW)
    const hidden = [...ConversationHiddenStatuses]
    const conversationId = params.conversationId ?? null
    // The candidates are the newest messages that match, ranked afterwards: ranking needs the text of each one folded
    // and parsed again, so it is never asked of every match of a common word. The snippet is made for the page only.
    // The tsquery is made once. `hits` leaves one more row than the page, to know if there is more.
    const rows = await this.prisma.client.$queryRaw<unknown[]>`
      WITH q AS (
        SELECT
          websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, immutable_unaccent(${params.q})) AS folded,
          -- The marks come from the folded text and from the typed one, because the stemmer folds accents unevenly
          -- and a word may be a match in one and not in the other
          websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, ${params.q})
            || websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, immutable_unaccent(${params.q})) AS marked
      ),
      candidates AS (
        SELECT m.id, m.conversation_id, m.type, m.created_at, m.content, c.customer_id,
          to_tsvector(${SEARCH_LANGUAGE_SQL}, immutable_unaccent(coalesce(m.content, ''))) AS vector
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id AND c.store_id = m.store_id
        JOIN customers cust ON cust.id = c.customer_id AND cust.store_id = c.store_id
        CROSS JOIN q
        WHERE m.store_id = ${storeId}
          AND m.deleted_at IS NULL
          AND m.discarded_at IS NULL
          -- The lines the platform writes into the thread (assignments, status changes) are not messages
          AND m.type <> ${MessageType.SYSTEM}
          AND cust.erased_at IS NULL
          AND (${canReadNotes}::boolean OR m.type <> ${MessageType.INTERNAL_NOTE})
          AND (${canReadOrders}::boolean OR m.type <> ${MessageType.ORDER_SUMMARY})
          AND (${canViewAll}::boolean OR c.assigned_to IS NULL OR c.assigned_to = ${viewer.userId})
          AND (${canSeeHidden}::boolean OR NOT (c.status = ANY(${hidden}::text[])))
          AND (${conversationId}::text IS NULL OR m.conversation_id = ${conversationId}::text)
          AND to_tsvector(${SEARCH_LANGUAGE_SQL}, immutable_unaccent(coalesce(m.content, ''))) @@ q.folded
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${SearchConfig.MESSAGE_CANDIDATES}
      ),
      page AS (
        SELECT cand.*, ts_rank(cand.vector, q.folded) AS rank
        FROM candidates cand CROSS JOIN q
        ORDER BY rank DESC, cand.created_at DESC, cand.id DESC
        LIMIT ${params.limit + 1}
      )
      SELECT
        page.id, page.conversation_id, page.type, page.created_at,
        cust.id AS customer_id, cust.name AS customer_name,
        ts_headline(${SEARCH_LANGUAGE_SQL}, page.content, q.marked, ${SNIPPET_OPTIONS}) AS snippet
      FROM page
      CROSS JOIN q
      JOIN customers cust ON cust.id = page.customer_id AND cust.store_id = ${storeId}
      ORDER BY page.rank DESC, page.created_at DESC, page.id DESC
    `
    const all = z
      .array(messageRow)
      .parse(rows)
      .map((row): MessageSearchHit => ({
        id: row.id,
        conversationId: row.conversation_id,
        type: row.type,
        createdAt: row.created_at.toISOString(),
        customerId: row.customer_id,
        customerName: row.customer_name,
        snippet: row.snippet
      }))
    return pageOf(params.q, all, params.limit)
  }

  // Customers by name (a part of it, with no accents, or a typo), by email and by a run of digits of their phone. The
  // ones erased and the ones a merge absorbed are not found. The name is compared in its folded column, which the
  // database generates, so the order of results does not depend on how a name was typed.
  async searchCustomers(
    storeId: string,
    params: { q: string; limit: number }
  ): Promise<SearchResult<CustomerSearchHit>> {
    const folded = await foldInDatabase(this.prisma.client, params.q)
    // The database may fold to nothing a text that looks like one here: an empty LIKE would match every customer
    if (folded === '') return pageOf(params.q, [], params.limit)
    const contains = `%${escapeLike(folded)}%`
    const startsWith = `${escapeLike(folded)}%`
    // The email is compared as typed (the list of customers does the same): it is not a name, and it has no accents to fold
    const typed = `%${escapeLike(params.q)}%`
    const digits = phoneDigitsOf(params.q)
    const byPhone = digits !== ''
    const rows = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT c.id, c.name, c.email, c.phone
      FROM customers c
      WHERE c.store_id = ${storeId}
        AND c.erased_at IS NULL
        AND c.merged_into_id IS NULL
        AND (
          c.name_search LIKE ${contains} ESCAPE '\\'
          OR c.email ILIKE ${typed} ESCAPE '\\'
          -- The % operator can use the index and reads pg_trgm.similarity_threshold, whose default is the constant
          -- (the integration spec checks it); the second test keeps a lower setting from widening the match
          OR (c.name_search % ${folded} AND similarity(c.name_search, ${folded}) > ${SearchConfig.SIMILARITY_THRESHOLD})
          OR (${byPhone}::boolean AND c.phone_normalized LIKE ${`%${digits}%`} ESCAPE '\\')
        )
      ORDER BY
        CASE
          WHEN c.name_search = ${folded} THEN 0
          WHEN c.name_search LIKE ${startsWith} ESCAPE '\\' THEN 1
          WHEN c.name_search LIKE ${contains} ESCAPE '\\' THEN 2
          ELSE 3
        END,
        similarity(c.name_search, ${folded}) DESC,
        c.name_search, c.id
      LIMIT ${params.limit + 1}
    `
    return pageOf(params.q, z.array(customerRow).parse(rows), params.limit)
  }

  // Orders by their number (a part of it) and by who they are for: the name of the customer, with no accents, or a run
  // of digits of their phone. The newest first among the ones that match the number the same way.
  async searchOrders(
    storeId: string,
    params: { q: string; limit: number }
  ): Promise<SearchResult<OrderSearchHit>> {
    const folded = await foldInDatabase(this.prisma.client, params.q)
    if (folded === '') return pageOf(params.q, [], params.limit)
    const escaped = escapeLike(folded)
    const contains = `%${escaped}%`
    const digits = phoneDigitsOf(params.q)
    const byPhone = digits !== ''
    const rows = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT
        o.id, o.order_number, o.status, o.total_cents, o.currency, o.created_at,
        cust.id AS customer_id,
        CASE WHEN cust.erased_at IS NULL THEN cust.name END AS customer_name
      FROM orders o
      JOIN customers cust ON cust.id = o.customer_id AND cust.store_id = o.store_id
      WHERE o.store_id = ${storeId}
        AND (
          o.order_number ILIKE ${contains} ESCAPE '\\'
          OR (cust.erased_at IS NULL AND cust.name_search LIKE ${contains} ESCAPE '\\')
          OR (${byPhone}::boolean AND cust.erased_at IS NULL AND cust.phone_normalized LIKE ${`%${digits}%`} ESCAPE '\\')
        )
      ORDER BY
        CASE
          WHEN lower(o.order_number) = ${folded} THEN 0
          WHEN o.order_number ILIKE ${`${escaped}%`} ESCAPE '\\' THEN 1
          ELSE 2
        END,
        o.created_at DESC, o.id DESC
      LIMIT ${params.limit + 1}
    `
    const all = z
      .array(orderRow)
      .parse(rows)
      .map((row): OrderSearchHit => ({
        id: row.id,
        orderNumber: row.order_number,
        status: row.status,
        totalCents: row.total_cents,
        currency: row.currency,
        createdAt: row.created_at.toISOString(),
        customerId: row.customer_id,
        customerName: row.customer_name
      }))
    return pageOf(params.q, all, params.limit)
  }
}

// A statement asks for one row more than the page: that row is what says there is more, and it is never shown
function pageOf<T>(query: string, rows: T[], limit: number): SearchResult<T> {
  return { query, hits: rows.slice(0, limit), hasMore: rows.length > limit }
}
