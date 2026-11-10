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

// The autocomplete of the products of the store of the request. The store comes from TenantGuard and filters the
// products; the variants are only ever read through those products (`v.product_id = p.id|h.id`), so a variant of
// another store cannot come in. The text is ALWAYS a bind parameter, with the wildcards of LIKE
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
    // `ESCAPE '\'` names the escape character (a plain string literal: `standard_conforming_strings` is on, the default
    // of Postgres since 9.1 and what the platform's databases run with). Everything
    // that changes is a bind parameter, the text and the flag alike: no piece of the statement is built from input.
    const rows = await this.prisma.client.$queryRaw<unknown[]>`
      SELECT
        h.id, h.name, h.sku, h.price_cents, h.image_media_id, h.active,
        mv.id AS variant_id, mv.name AS variant_name, mv.sku AS variant_sku,
        mv.price_cents AS variant_price_cents
      FROM (
        SELECT
          p.id, p.name, p.sku, p.price_cents, p.image_media_id, p.active,
          CASE
            WHEN lower(p.sku) = lower(${text}) THEN 0
            WHEN EXISTS (
              SELECT 1 FROM product_variants v
              WHERE v.product_id = p.id AND lower(v.sku) = lower(${text}) AND (${archived}::boolean OR v.active)
            ) THEN 0
            WHEN p.name ILIKE ${startsWith} ESCAPE '\\' OR p.sku ILIKE ${startsWith} ESCAPE '\\' THEN 1
            ELSE 2
          END AS rank
        FROM products p
        WHERE p.store_id = ${storeId}
          AND (${archived}::boolean OR p.active)
          AND (
            p.name ILIKE ${contains} ESCAPE '\\'
            OR p.sku ILIKE ${contains} ESCAPE '\\'
            OR EXISTS (
              SELECT 1 FROM product_variants v
              WHERE v.product_id = p.id
                AND (v.name ILIKE ${contains} ESCAPE '\\' OR v.sku ILIKE ${contains} ESCAPE '\\')
                AND (${archived}::boolean OR v.active)
            )
          )
        ORDER BY rank, p.name, p.id
        LIMIT ${query.limit}
      ) h
      LEFT JOIN LATERAL (
        SELECT v.id, v.name, v.sku, v.price_cents
        FROM product_variants v
        WHERE v.product_id = h.id
          -- A product that matched by itself (its name or its sku) is shown as itself: the variant is only
          -- named when it is the reason the product is in the answer
          AND NOT (
            h.name ILIKE ${contains} ESCAPE '\\'
            OR coalesce(h.sku ILIKE ${contains} ESCAPE '\\', false)
          )
          AND (v.name ILIKE ${contains} ESCAPE '\\' OR v.sku ILIKE ${contains} ESCAPE '\\')
          AND (${archived}::boolean OR v.active)
        ORDER BY coalesce(lower(v.sku) = lower(${text}), false) DESC, v.name, v.id
        LIMIT 1
      ) mv ON TRUE
      ORDER BY h.rank, h.name, h.id
    `
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
