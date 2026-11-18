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

// The search of the store of the request (TDD_08 §5.4). Every read goes through a SQL function of the database
// (migration rls_search_functions) that runs as the owner of the tables, so that Row-Level Security does not take the search
// off its indexes, and that filters by itself what the policy would: the store is the one of the transaction context (the one
// TenantGuard put in the request, see `inContext`), never an argument, and a call with no context raises. What stays here is what the code
// decides: the permissions of the viewer, as booleans, and the text, ALWAYS a bind parameter, with the wildcards of LIKE
// (% _ and the backslash) escaped, so it is only ever read as the characters it is. Everything is read accent-insensitive:
// the text and the stored text are folded the same way (`immutable_unaccent`, migration search_unaccent).
@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  // The messages of the conversations the viewer may see. What a message search must NOT show is decided by the function:
  // deleted messages (the text stays until the retention sweep, but it is not shown), internal notes for who may not read
  // them, conversations assigned to someone else for who may not see all, and the hidden ones (spam, archived) for who may
  // not archive. Without that, search would be a way around every rule of the thread.
  searchMessages(
    storeId: string,
    viewer: SearchViewer,
    params: { q: string; limit: number; conversationId?: string }
  ): Promise<SearchResult<MessageSearchHit>> {
    return this.inContext(storeId, viewer.userId, () => this.messagesInContext(viewer, params))
  }

  private async messagesInContext(
    viewer: SearchViewer,
    params: { q: string; limit: number; conversationId?: string }
  ): Promise<SearchResult<MessageSearchHit>> {
    const visibility = [
      params.conversationId ?? null,
      viewer.held.includes(Permissions.CONVERSATIONS_VIEW_ALL),
      viewer.held.includes(Permissions.CONVERSATIONS_ARCHIVE),
      viewer.held.includes(Permissions.MESSAGES_INTERNAL_NOTE),
      // The line of an order says its number and its total: only who may read orders finds it (as the thread shows it)
      viewer.held.includes(Permissions.ORDERS_VIEW)
    ] as const
    const [conversationId, canViewAll, canSeeHidden, canReadNotes, canReadOrders] = visibility
    const hidden = [...ConversationHiddenStatuses]
    // A text of only stop words ("cuando") leaves the tsquery empty, and an empty tsquery matches nothing: the person
    // typed something real and would be told there is none. Those texts are read as the words they are instead.
    const reading = await this.readQuery(params.q)
    let rows: unknown[]
    if (reading.empty) {
      // The words are what is compared ("¿cuándo?" finds "cuándo"): the punctuation around them is not part of what the
      // person looks for. A text with no letter or digit at all ("!!!") is compared as the symbols it is.
      const words = reading.folded.match(/[\p{L}\p{N}]+/gu)
      const needle = words ? words.join(' ') : reading.folded.trim()
      if ([...needle].length < SearchConfig.MESSAGE_AS_TYPED_MIN_LENGTH) {
        return pageOf(params.q, [], params.limit)
      }
      rows = await this.prisma.client.$queryRaw<unknown[]>`
        SELECT f.* FROM public.rls_search_messages_typed(
          ${`%${escapeLike(needle)}%`}, ${params.q}, ${params.limit}::integer, ${conversationId}::text,
          ${canViewAll}::boolean, ${canSeeHidden}::boolean, ${canReadNotes}::boolean, ${canReadOrders}::boolean,
          ${hidden}::text[], ${MessageType.SYSTEM}, ${MessageType.INTERNAL_NOTE}, ${MessageType.ORDER_SUMMARY},
          ${SNIPPET_OPTIONS}
        ) WITH ORDINALITY AS f ORDER BY f.ordinality`
    } else {
      // The candidates are the newest messages that match, ranked afterwards (inside the function): ranking needs the
      // text of each one folded and parsed again, so it is never asked of every match of a common word.
      rows = await this.prisma.client.$queryRaw<unknown[]>`
        SELECT f.* FROM public.rls_search_messages(
          ${params.q}, ${params.limit}::integer, ${SearchConfig.MESSAGE_CANDIDATES}::integer, ${conversationId}::text,
          ${canViewAll}::boolean, ${canSeeHidden}::boolean, ${canReadNotes}::boolean, ${canReadOrders}::boolean,
          ${hidden}::text[], ${MessageType.SYSTEM}, ${MessageType.INTERNAL_NOTE}, ${MessageType.ORDER_SUMMARY},
          ${SNIPPET_OPTIONS}
        ) WITH ORDINALITY AS f ORDER BY f.ordinality`
    }
    return pageOf(params.q, z.array(messageRow).parse(rows).map(toMessageHit), params.limit)
  }

  // The search functions read the store from the context of the transaction, so they run in one. The request already has it when the
  // interceptor of the context is on (then it must be the context of THIS store alone: the functions answer for every store of the
  // context); with the switch off the search opens its own, for the store the TenantGuard put in the request.
  private inContext<T>(
    storeId: string,
    userId: string | undefined,
    work: () => Promise<T>
  ): Promise<T> {
    const current = this.prisma.currentTenantContext()
    if (current) {
      if (current.storeIds.length !== 1 || current.storeIds[0] !== storeId) {
        throw new Error(
          'the search runs in the context of the store of the request, and of that store alone'
        )
      }
      return work()
    }
    return this.prisma.tenantTransaction({ storeIds: [storeId], organizationIds: [], userId }, work)
  }

  // One round trip: whether the text has no word the index can look for (only stop words, or only symbols, so its
  // tsquery is empty) and the text folded the way the database folds the stored one. It reads no table.
  private async readQuery(q: string): Promise<{ empty: boolean; folded: string }> {
    const rows = await this.prisma.client.$queryRaw<{ empty: boolean; folded: string }[]>`
      SELECT
        numnode(websearch_to_tsquery(${SEARCH_LANGUAGE_SQL}, immutable_unaccent(${q}))) = 0 AS empty,
        lower(immutable_unaccent(${q})) AS folded`
    return { empty: rows[0]?.empty === true, folded: rows[0]?.folded ?? '' }
  }

  // Customers by name (a part of it, with no accents, or a typo), by email and by a run of digits of their phone. The
  // ones erased and the ones a merge absorbed are not found. The name is compared in its folded column, which the
  // database generates, so the order of results does not depend on how a name was typed.
  searchCustomers(
    storeId: string,
    params: { q: string; limit: number }
  ): Promise<SearchResult<CustomerSearchHit>> {
    return this.inContext(storeId, undefined, () => this.customersInContext(params))
  }

  private async customersInContext(params: {
    q: string
    limit: number
  }): Promise<SearchResult<CustomerSearchHit>> {
    const folded = await foldInDatabase(this.prisma.client, params.q)
    // The database may fold to nothing a text that looks like one here: an empty LIKE would match every customer
    if (folded === '') return pageOf(params.q, [], params.limit)
    const digits = phoneDigitsOf(params.q)
    const rows = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT f.* FROM public.rls_search_customers(
        ${folded}, ${`%${escapeLike(folded)}%`}, ${`${escapeLike(folded)}%`},
        -- The email is compared as typed (the list of customers does the same): it is not a name, and it has no accents to fold
        ${`%${escapeLike(params.q)}%`}, ${`%${digits}%`}, ${digits !== ''}::boolean,
        ${[...folded].length >= SearchConfig.WORD_SIMILARITY_MIN_LENGTH}::boolean, ${params.limit}::integer,
        ${SearchConfig.SIMILARITY_THRESHOLD}::real, ${SearchConfig.WORD_SIMILARITY_THRESHOLD}::real
      ) WITH ORDINALITY AS f ORDER BY f.ordinality`
    return pageOf(params.q, z.array(customerRow).parse(rows), params.limit)
  }

  // Orders by their number (a part of it) and by who they are for: the name of the customer, with no accents, or a run
  // of digits of their phone. The newest first among the ones that match the number the same way.
  // `byCustomer` false (a plugin whose key lacks `customers:read`): the order is found by its number only, and the name and the
  // phone of the customer are not even compared, so the answer cannot tell who an order is for
  searchOrders(
    storeId: string,
    params: { q: string; limit: number },
    // Required on purpose: the caller says whether the customer may be searched; there is no default that opens it
    byCustomer: boolean
  ): Promise<SearchResult<OrderSearchHit>> {
    return this.inContext(storeId, undefined, () => this.ordersInContext(params, byCustomer))
  }

  private async ordersInContext(
    params: { q: string; limit: number },
    byCustomer: boolean
  ): Promise<SearchResult<OrderSearchHit>> {
    const folded = await foldInDatabase(this.prisma.client, params.q)
    if (folded === '') return pageOf(params.q, [], params.limit)
    const escaped = escapeLike(folded)
    const digits = phoneDigitsOf(params.q)
    const rows = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT f.* FROM public.rls_search_orders(
        ${folded}, ${`%${escaped}%`}, ${`${escaped}%`}, ${`%${digits}%`},
        ${byCustomer}::boolean, ${byCustomer && digits !== ''}::boolean, ${params.limit}::integer
      ) WITH ORDINALITY AS f ORDER BY f.ordinality`
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

function toMessageHit(row: z.infer<typeof messageRow>): MessageSearchHit {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    type: row.type,
    createdAt: row.created_at.toISOString(),
    customerId: row.customer_id,
    customerName: row.customer_name,
    snippet: row.snippet
  }
}

// A statement asks for one row more than the page: that row is what says there is more, and it is never shown
function pageOf<T>(query: string, rows: T[], limit: number): SearchResult<T> {
  return { query, hits: rows.slice(0, limit), hasMore: rows.length > limit }
}
