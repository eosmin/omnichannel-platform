import { createApiClient } from './api-client'
import { requestUploadUrl } from './media-api'
import {
  createProduct,
  deleteProduct,
  fetchProductImages,
  fetchProducts,
  searchProducts,
  updateProduct,
  updateVariant
} from './products-api'

const json = (status: number, body: unknown): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })

function setup(response: Response) {
  const fetchImpl = jest
    .fn<Promise<Response>, [string, RequestInit]>()
    .mockImplementation(() => Promise.resolve(response.clone()))
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const product = {
  id: 'p1',
  name: 'Shoe',
  description: null,
  priceCents: 1500,
  costCents: null,
  sku: null,
  imageMediaId: null,
  trackInventory: true,
  lowStockThreshold: null,
  active: true,
  freeShipping: false,
  createdAt: '2026-11-10T10:00:00.000Z',
  updatedAt: '2026-11-10T10:00:00.000Z'
}

const bodyOf = (call: [string, RequestInit] | undefined): unknown =>
  JSON.parse((call?.[1].body as string | undefined) ?? 'null')

describe('fetchProducts', () => {
  it('asks for the filter and the cursor it was given and for nothing else', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [{ ...product, variantCount: 2 }], nextCursor: null, hasMore: false })
    )

    const page = await fetchProducts(client, 's1', { active: false, cursor: 'cur' })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/products?active=false&cursor=cur'
    )
    expect(new Headers(fetchImpl.mock.calls[0]?.[1].headers).get('x-store-id')).toBe('s1')
    expect(page.data[0]?.variantCount).toBe(2)
  })

  it('reads an answer with no cost keys (a caller without products:view_cost) as no cost', async () => {
    const withoutCost = Object.fromEntries(
      Object.entries(product).filter(([key]) => key !== 'costCents')
    )
    const { client } = setup(
      json(200, { data: [{ ...withoutCost, variantCount: 0 }], nextCursor: null, hasMore: false })
    )

    const page = await fetchProducts(client, 's1', {})

    expect(page.data[0]?.costCents).toBeNull()
  })

  it('sends no query string when nothing narrows the list', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))
    await fetchProducts(client, 's1', {})
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/products')
  })

  it('refuses an answer that is not the contract', async () => {
    const { client } = setup(json(200, { data: [{ id: 'p1' }], nextCursor: null, hasMore: false }))
    await expect(fetchProducts(client, 's1', {})).rejects.toThrow()
  })
})

describe('the writes', () => {
  it('sends a price as whole cents, as the caller wrote it', async () => {
    const { client, fetchImpl } = setup(json(201, { ...product, variants: [] }))
    await createProduct(client, 's1', { name: 'Shoe', priceCents: 1500 })
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('POST')
    expect(bodyOf(fetchImpl.mock.calls[0])).toEqual({
      name: 'Shoe',
      priceCents: 1500
    })
  })

  it('clears the cover and a variant sku with null', async () => {
    const { client, fetchImpl } = setup(json(200, { ...product, variants: [] }))
    await updateProduct(client, 's1', 'p1', { imageMediaId: null })
    expect(bodyOf(fetchImpl.mock.calls[0])).toEqual({ imageMediaId: null })
    const variant = setup(json(500, { error: { code: 'X', message: 'x', metadata: {} } }))
    await expect(updateVariant(variant.client, 's1', 'p1', 'v1', { sku: null })).rejects.toThrow()
    expect(variant.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/products/p1/variants/v1'
    )
  })

  it('reads a delete with no body as done', async () => {
    const { client, fetchImpl } = setup(json(204, null))
    await expect(deleteProduct(client, 's1', 'p1')).resolves.toBeUndefined()
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('DELETE')
  })
})

describe('the pictures of a product', () => {
  it('lists them from the images route', async () => {
    const { client, fetchImpl } = setup(
      json(200, [
        {
          id: 'm1',
          filename: 'a.png',
          contentType: 'image/png',
          fileSize: 10,
          status: 'clean',
          createdAt: '2026-11-10T10:00:00.000Z'
        }
      ])
    )
    const images = await fetchProductImages(client, 's1', 'p1')
    expect(images).toHaveLength(1)
    expect(fetchImpl.mock.calls[0]?.[0]).toBe('https://api.example.com/api/v1/products/p1/images')
  })

  it('asks for the upload url with the purpose and the parent of a product', async () => {
    const { client, fetchImpl } = setup(
      json(200, { uploadUrl: 'https://bucket.example.com/x', key: 'k', mediaId: 'm1' })
    )
    await requestUploadUrl(
      client,
      's1',
      { filename: 'a.png', contentType: 'image/png', fileSizeBytes: 10 },
      { purpose: 'product', parentId: 'p1' }
    )
    expect(bodyOf(fetchImpl.mock.calls[0])).toEqual({
      purpose: 'product',
      parentId: 'p1',
      filename: 'a.png',
      contentType: 'image/png',
      fileSizeBytes: 10
    })
  })
})

describe('searchProducts', () => {
  it('asks with the text and whether archived products may answer, and returns the data', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        data: [
          {
            id: 'p1',
            name: 'Shoe',
            sku: null,
            priceCents: 1500,
            imageMediaId: null,
            active: true,
            matchedVariant: {
              id: 'v1',
              name: '42',
              sku: 'S-42',
              priceCents: null,
              effectivePriceCents: 1500
            }
          }
        ]
      })
    )

    const found = await searchProducts(client, 's1', { q: 'sho', includeArchived: true })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/products/search?q=sho&includeArchived=true'
    )
    expect(found[0]?.matchedVariant?.name).toBe('42')
  })
})
