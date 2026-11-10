import { randomUUID } from 'node:crypto'

import type { INestApplication } from '@nestjs/common'

import { ApiRoutes } from '@platform/core/api'
import { Permissions } from '@platform/core/auth'
import type { OwnerClient } from '@platform/core/database-testing'
import { ProductSearchConfig } from '@platform/core/domain'
import { ErrorCodes } from '@platform/core/errors'

import { createProduct, createProductVariant } from '../builders'
import { actorWithPermissions } from '../helpers/actors'
import { createTestApp } from '../helpers/app'
import { seedTestContext, type TestContext } from '../helpers/context'
import { cleanUp, newRunPrefix, ownerClient } from '../helpers/database'
import { api } from '../helpers/http'

interface Suggestion {
  id: string
  name: string
  sku: string | null
  priceCents: number
  imageMediaId: string | null
  active: boolean
  matchedVariant: {
    id: string
    name: string
    sku: string | null
    priceCents: number | null
    effectivePriceCents: number
  } | null
}
interface SearchBody {
  data: Suggestion[]
}

const OK = 200
const BAD_REQUEST = 400
const FORBIDDEN = 403

describe('The search of products for the autocomplete', () => {
  const prefix = newRunPrefix()
  let app: INestApplication
  let owner: OwnerClient
  let ctx: TestContext
  // Everything of this run carries this word, so that a search is never answered by another test's rows
  const tag = `zq${randomUUID().slice(0, 6)}`

  beforeAll(async () => {
    owner = ownerClient()
    app = await createTestApp()
    ctx = await seedTestContext(owner, app, prefix)
  })
  afterAll(async () => {
    await cleanUp(owner, prefix)
    await app.close()
    await owner.$disconnect()
  })

  const asAdmin = () => api(app, ctx.adminA, ctx.storeA)
  const search = async (
    q: string,
    extra: Record<string, unknown> = {}
  ): Promise<{ status: number; data: Suggestion[]; body: unknown }> => {
    const response = await asAdmin()
      .get(ApiRoutes.products.search)
      .query({ q, ...extra })
    const body = response.body as SearchBody
    return { status: response.status, data: body.data ?? [], body: response.body }
  }
  const names = (data: Suggestion[]): string[] => data.map(item => item.name)

  describe('what it finds', () => {
    it('finds a product by a part of its name, whatever the case, and by its sku', async () => {
      const shoe = await createProduct(owner, {
        storeId: ctx.storeA.id,
        name: `${tag} Running Shoe`,
        sku: `${tag}-SHOE-1`,
        priceCents: 4500
      })

      const byName = await search(`${tag} RUNNING`)
      expect(byName.status).toBe(OK)
      expect(byName.data.map(item => item.id)).toEqual([shoe.id])
      expect(byName.data[0]).toEqual({
        id: shoe.id,
        name: `${tag} Running Shoe`,
        sku: `${tag}-SHOE-1`,
        priceCents: 4500,
        imageMediaId: null,
        active: true,
        matchedVariant: null
      })

      expect((await search(`${tag}-shoe`)).data.map(item => item.id)).toEqual([shoe.id])
      expect((await search('hoe-1')).data.map(item => item.id)).toContain(shoe.id)
    })

    it('finds a variant by its name or its sku and says which one matched, with its price', async () => {
      const product = await createProduct(owner, {
        storeId: ctx.storeA.id,
        name: `${tag} Jacket`,
        priceCents: 8000
      })
      const red = await createProductVariant(owner, {
        productId: product.id,
        name: `${tag} Crimson L`,
        sku: `${tag}-JKT-RED-L`,
        priceCents: 8500
      })
      await createProductVariant(owner, {
        productId: product.id,
        name: `${tag} Navy M`,
        sku: `${tag}-JKT-NAVY-M`
      })

      const byVariantName = await search(`${tag} crimson`)
      expect(byVariantName.data).toHaveLength(1)
      expect(byVariantName.data[0]).toMatchObject({
        id: product.id,
        name: `${tag} Jacket`,
        matchedVariant: {
          id: red.id,
          name: `${tag} Crimson L`,
          sku: `${tag}-JKT-RED-L`,
          priceCents: 8500,
          effectivePriceCents: 8500
        }
      })

      const bySku = await search(`${tag}-jkt-navy`)
      expect(bySku.data).toHaveLength(1)
      // A variant with no price of its own is sold at the price of its product
      expect(bySku.data[0]?.matchedVariant).toMatchObject({
        name: `${tag} Navy M`,
        priceCents: null,
        effectivePriceCents: 8000
      })
    })

    it('shows a product once, with no variant, when only its own name matches', async () => {
      const product = await createProduct(owner, { storeId: ctx.storeA.id, name: `${tag} Scarf` })
      await createProductVariant(owner, { productId: product.id, name: 'One size' })
      await createProductVariant(owner, { productId: product.id, name: 'Kids' })

      const found = await search(`${tag} scarf`)

      expect(found.data.map(item => item.id)).toEqual([product.id])
      expect(found.data[0]?.matchedVariant).toBeNull()
    })

    it('puts an exact sku first, then names that start with the text, then the rest, then by name', async () => {
      const word = `ord${randomUUID().slice(0, 5)}`
      const contains = await createProduct(owner, {
        storeId: ctx.storeA.id,
        name: `Big ${word} box`
      })
      const prefixB = await createProduct(owner, { storeId: ctx.storeA.id, name: `${word} B` })
      const prefixA = await createProduct(owner, { storeId: ctx.storeA.id, name: `${word} A` })
      const exact = await createProduct(owner, {
        storeId: ctx.storeA.id,
        name: `Zeta thing`,
        sku: word.toUpperCase()
      })

      const found = await search(word)

      expect(found.data.map(item => item.id)).toEqual([
        exact.id,
        prefixA.id,
        prefixB.id,
        contains.id
      ])
    })

    it('answers with the small shape the autocomplete needs and nothing else', async () => {
      await createProduct(owner, { storeId: ctx.storeA.id, name: `${tag} Shape` })

      const found = await search(`${tag} shape`)

      expect(Object.keys(found.data[0] ?? {}).sort()).toEqual([
        'active',
        'id',
        'imageMediaId',
        'matchedVariant',
        'name',
        'priceCents',
        'sku'
      ])
    })

    it('leaves archived products and variants out, unless they are asked for', async () => {
      const archived = await createProduct(owner, {
        storeId: ctx.storeA.id,
        name: `${tag} Archived thing`,
        active: false
      })
      const product = await createProduct(owner, { storeId: ctx.storeA.id, name: `${tag} Live` })
      await owner.productVariant.create({
        data: { productId: product.id, name: `${tag} Hidden size`, attributes: {}, active: false }
      })

      expect((await search(`${tag} archived`)).data).toEqual([])
      expect((await search(`${tag} hidden`)).data).toEqual([])

      const withArchived = await search(`${tag} archived`, { includeArchived: 'true' })
      expect(withArchived.data.map(item => item.id)).toEqual([archived.id])
      expect(withArchived.data[0]?.active).toBe(false)
      const variant = await search(`${tag} hidden`, { includeArchived: 'true' })
      expect(variant.data[0]?.matchedVariant?.name).toBe(`${tag} Hidden size`)
    })
  })

  describe('the size of the answer', () => {
    it('gives the default number of rows, the number asked for, and never more than the ceiling', async () => {
      const word = `many${randomUUID().slice(0, 5)}`
      await owner.product.createMany({
        data: Array.from({ length: ProductSearchConfig.MAX_LIMIT + 5 }, (_, index) => ({
          storeId: ctx.storeA.id,
          name: `${word} ${String(index).padStart(3, '0')}`,
          priceCents: 100
        }))
      })

      expect((await search(word)).data).toHaveLength(ProductSearchConfig.DEFAULT_LIMIT)
      expect((await search(word, { limit: 3 })).data).toHaveLength(3)
      expect((await search(word, { limit: ProductSearchConfig.MAX_LIMIT })).data).toHaveLength(
        ProductSearchConfig.MAX_LIMIT
      )
      for (const limit of [0, -1, ProductSearchConfig.MAX_LIMIT + 1, 1.5, 'many']) {
        expect((await search(word, { limit })).status).toBe(BAD_REQUEST)
      }
    })
  })

  describe('a text that is not a name', () => {
    beforeAll(async () => {
      await createProduct(owner, { storeId: ctx.storeA.id, name: 'Abc plain' })
      await createProduct(owner, { storeId: ctx.storeA.id, name: 'Sale 10% off' })
      await createProduct(owner, { storeId: ctx.storeA.id, name: 'Snake_case item' })
      await createProduct(owner, { storeId: ctx.storeA.id, name: 'Back\\slash item' })
    })

    it.each([
      ['%'],
      ['%%'],
      ['%%%%'],
      ['_'],
      ['__'],
      ['\\'],
      ['\\\\'],
      ['%_'],
      [' % '],
      ['.*'],
      ['%a%']
    ])('returns nothing for %p, which is not a wildcard', async text => {
      const found = await search(text)

      expect(found.status).toBe(OK)
      expect(found.data).toEqual([])
    })

    it('reads % _ and \\ as the characters they are', async () => {
      expect(names((await search('10%')).data)).toEqual(['Sale 10% off'])
      expect(names((await search('snake_c')).data)).toEqual(['Snake_case item'])
      // "a_c" is not "abc": the underscore is not a wildcard
      expect(names((await search('a_c')).data)).toEqual([])
      expect(names((await search('k\\s')).data)).toEqual(['Back\\slash item'])
    })

    it('is not a way into the query: it is a value, never a piece of the statement', async () => {
      const before = await owner.product.count({ where: { storeId: ctx.storeA.id } })

      for (const text of ["'; DROP TABLE products; --", "' OR '1'='1", '") OR TRUE --']) {
        const found = await search(text)
        expect(found.status).toBe(OK)
        expect(found.data).toEqual([])
      }

      expect(await owner.product.count({ where: { storeId: ctx.storeA.id } })).toBe(before)
    })

    it('answers an empty list, without searching, for a text shorter than the minimum', async () => {
      expect(ProductSearchConfig.MIN_QUERY_LENGTH).toBe(2)
      for (const text of ['', ' ', 'a', ' a ', 'A']) {
        const found = await search(text)
        expect(found.status).toBe(OK)
        expect(found.data).toEqual([])
      }
      // Two characters is a search
      expect(names((await search('ab')).data)).toContain('Abc plain')
    })

    it('refuses a request with no text, one that is too long, and a parameter it does not know', async () => {
      const missing = await asAdmin().get(ApiRoutes.products.search)
      expect(missing.status).toBe(BAD_REQUEST)
      expect((missing.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.VALIDATION_FAILED
      )
      const long = await search('x'.repeat(ProductSearchConfig.MAX_QUERY_LENGTH + 1))
      expect(long.status).toBe(BAD_REQUEST)
      const nul = await search('nul\0')
      expect(nul.status).toBe(BAD_REQUEST)
      const stranger = await search('abc', { storeId: ctx.storeB.id })
      expect(stranger.status).toBe(BAD_REQUEST)
    })

    it('is served by its own route and not taken for the id of a product', async () => {
      const response = await asAdmin().get(ApiRoutes.products.search).query({ q: 'ab' })

      expect(response.status).toBe(OK)
    })
  })

  describe('the other stores', () => {
    it('never finds the products or the variants of another store, even by their exact sku', async () => {
      const word = `foreign${randomUUID().slice(0, 5)}`
      const foreign = await createProduct(owner, {
        storeId: ctx.storeB.id,
        name: `${word} thing`,
        sku: `${word}-SKU`
      })
      await createProductVariant(owner, {
        productId: foreign.id,
        name: `${word} variant`,
        sku: `${word}-VAR`
      })
      const sibling = await createProduct(owner, {
        storeId: ctx.storeA2.id,
        name: `${word} sibling`
      })

      for (const text of [word, `${word}-SKU`, `${word}-VAR`, `${word} variant`]) {
        expect((await search(text)).data).toEqual([])
      }
      const fromB = await api(app, ctx.adminB, ctx.storeB)
        .get(ApiRoutes.products.search)
        .query({ q: word })
      expect((fromB.body as SearchBody).data.map(item => item.id)).toEqual([foreign.id])
      const fromSibling = await api(app, ctx.adminA2, ctx.storeA2)
        .get(ApiRoutes.products.search)
        .query({ q: word })
      expect((fromSibling.body as SearchBody).data.map(item => item.id)).toEqual([sibling.id])
    })
  })

  describe('permissions', () => {
    it('needs products:view, and gives it to a member who only views', async () => {
      await createProduct(owner, { storeId: ctx.storeA.id, name: `${tag} Visible` })
      const viewer = await api(app, ctx.viewerA, ctx.storeA)
        .get(ApiRoutes.products.search)
        .query({ q: `${tag} visible` })
      expect(viewer.status).toBe(OK)
      expect((viewer.body as SearchBody).data).toHaveLength(1)

      const editor = await actorWithPermissions(owner, app, {
        prefix,
        name: 'search-editor',
        organizationId: ctx.orgA.id,
        storeId: ctx.storeA.id,
        permissions: [Permissions.PRODUCTS_EDIT, Permissions.PRODUCTS_CREATE]
      })
      const denied = await api(app, editor, ctx.storeA)
        .get(ApiRoutes.products.search)
        .query({ q: `${tag} visible` })
      expect(denied.status).toBe(FORBIDDEN)
      expect((denied.body as { error: { code: string } }).error.code).toBe(
        ErrorCodes.PERMISSION_DENIED
      )
    })
  })
})
