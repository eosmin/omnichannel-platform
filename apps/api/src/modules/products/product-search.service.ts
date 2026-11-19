import { Injectable } from '@nestjs/common'
import { z } from 'zod'

import { PrismaService } from '@platform/core/database'
import { ProductSearchConfig } from '@platform/core/domain'
import { escapeLike } from '@platform/core/messaging'

import type { SearchProductsQuery } from './products.schemas'
import type { ProductSuggestion, ProductSuggestions } from './products.views'

// The raw statement below is a boundary: what it returns is read through this, not trusted
const rowSchema = z.object({
  id: z.string(),
  name: z.string(),
  sku: z.string().nullable(),
  price_cents: z.number(),
  image_media_id: z.string().nullable(),
  active: z.boolean(),
  variant_id: z.string().nullable(),
  variant_name: z.string().nullable(),
  variant_sku: z.string().nullable(),
  variant_price_cents: z.number().nullable()
})

// The autocomplete of the products of the store of the request. The store comes from TenantGuard and is the one of the context
// the function reads; the variants are only ever read through those products, so a variant of another store cannot come in. The text is ALWAYS a bind parameter, with the wildcards of LIKE
// (% _ and the backslash) escaped, so it is only ever read as the characters it is.
@Injectable()
export class ProductSearchService {
  constructor(private readonly prisma: PrismaService) {}

  async search(storeId: string, query: SearchProductsQuery): Promise<ProductSuggestions> {
    const text = query.q
    // Too short to be a name: nothing is asked of the database
    // Characters, not UTF-16 units: one emoji is one character
    if ([...text].length < ProductSearchConfig.MIN_QUERY_LENGTH) return { data: [] }

    const escaped = escapeLike(text)
    const contains = `%${escaped}%`
    const startsWith = `${escaped}%`
    const archived = query.includeArchived
    // The statement is a function of the database (migration rls_search_products) that runs as the owner of the tables, so that
    // Row-Level Security does not take the search off its trigram indexes, and that filters by itself what the policy would: the
    // store is the one of the transaction context, never an argument. Everything that changes is a bind parameter, the text and the
    // flag alike: no piece of the statement is built from input.
    const rows = await this.prisma.inStoreContext(
      storeId,
      () =>
        this.prisma.client.$queryRaw<unknown[]>`
        SELECT f.* FROM public.rls_search_products(
          ${text}::text, ${startsWith}::text, ${contains}::text, ${archived}::boolean, ${query.limit}::integer
        ) WITH ORDINALITY AS f ORDER BY f.ordinality`
    )
    return { data: z.array(rowSchema).parse(rows).map(suggestionOf) }
  }
}

function suggestionOf(row: z.infer<typeof rowSchema>): ProductSuggestion {
  return {
    id: row.id,
    name: row.name,
    sku: row.sku,
    priceCents: row.price_cents,
    imageMediaId: row.image_media_id,
    active: row.active,
    matchedVariant:
      row.variant_id === null || row.variant_name === null
        ? null
        : {
            id: row.variant_id,
            name: row.variant_name,
            sku: row.variant_sku,
            priceCents: row.variant_price_cents,
            effectivePriceCents: row.variant_price_cents ?? row.price_cents
          }
  }
}
