import { createApiClient } from './api-client'
import {
  attachCustomerTag,
  createCustomerAddress,
  deleteCustomerNote,
  fetchCustomer,
  fetchCustomerConversations,
  fetchCustomerMergePreview,
  fetchCustomers,
  fetchCustomerTimeline,
  linkCustomerIdentity,
  mergeCustomers,
  unlinkCustomerIdentity,
  unmergeCustomers,
  updateCustomer
} from './customers-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

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

const note = {
  type: 'note',
  id: 'n1',
  at: '2026-10-30T10:00:00.000Z',
  authorId: 'u1',
  authorName: 'María',
  content: 'VIP'
}

describe('fetchCustomerTimeline', () => {
  it('asks for the kind and the cursor, and for nothing that is not named', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [note], nextCursor: null, hasMore: false })
    )

    const page = await fetchCustomerTimeline(client, 's1', 'c1', 'note', 'cur')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/timeline?type=note&cursor=cur'
    )
    expect(page.data).toEqual([note])
  })

  it('has no query string when nothing narrows it', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchCustomerTimeline(client, 's1', 'c1', undefined, null)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/timeline'
    )
  })

  it('leaves out an entry of a kind it does not know, and keeps the rest', async () => {
    const future = { type: 'order', id: 'o1', at: '2026-10-30T10:00:00.000Z' }
    const { client } = setup(json(200, { data: [future, note], nextCursor: null, hasMore: false }))

    const page = await fetchCustomerTimeline(client, 's1', 'c1', undefined, null)

    expect(page.data).toEqual([note])
  })

  it('sends the store of the request in X-Store-Id', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchCustomerTimeline(client, 's1', 'c1', undefined, null)

    expect(new Headers(fetchImpl.mock.calls[0]?.[1].headers).get('X-Store-Id')).toBe('s1')
  })
})

describe('fetchCustomerConversations', () => {
  it('names the page size', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))

    await fetchCustomerConversations(client, 's1', 'c1', 100)

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/conversations?limit=100'
    )
  })
})

describe('fetchCustomer', () => {
  it('refuses an answer that is not a customer', async () => {
    const { client } = setup(json(200, { id: 'c1' }))

    await expect(fetchCustomer(client, 's1', 'c1')).rejects.toThrow()
  })
})

describe('fetchCustomers', () => {
  const page = { data: [], nextCursor: null, hasMore: false }

  it('sends the search and the cursor, and nothing for an empty search', async () => {
    const { client, fetchImpl } = setup(json(200, page))

    await fetchCustomers(client, 's1', { q: 'ana', cursor: 'cur' })
    await fetchCustomers(client, 's1', { q: '', cursor: null })

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers?q=ana&cursor=cur'
    )
    expect(fetchImpl.mock.calls[1]?.[0]).toBe('https://api.example.com/api/v1/customers')
  })
})

describe('customer changes', () => {
  const detail = {
    id: 'c1',
    name: 'Ana',
    email: null,
    phone: null,
    locale: null,
    isCaution: false,
    cautionReason: null,
    identities: [],
    addresses: [],
    tags: [],
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z'
  }

  it('patches only the fields it is given, with null to clear', async () => {
    const { client, fetchImpl } = setup(json(200, detail))

    await updateCustomer(client, 's1', 'c1', { email: null })

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/customers/c1')
    expect(init?.method).toBe('PATCH')
    expect(init?.body).toBe(JSON.stringify({ email: null }))
  })

  it('posts a new address and reads the one it answers', async () => {
    const address = {
      id: 'a1',
      label: null,
      line1: 'Calle 1',
      line2: null,
      city: 'SS',
      state: null,
      postalCode: null,
      country: 'SV',
      isDefault: false
    }
    const { client, fetchImpl } = setup(json(201, address))

    const created = await createCustomerAddress(client, 's1', 'c1', {
      line1: 'Calle 1',
      city: 'SS'
    })

    expect(created.id).toBe('a1')
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/addresses'
    )
  })

  it('attaches a tag and answers the tags the customer holds', async () => {
    const { client } = setup(json(200, [{ id: 't1', name: 'VIP', color: '#ff0000' }]))

    await expect(attachCustomerTag(client, 's1', 'c1', 't1')).resolves.toEqual([
      { id: 't1', name: 'VIP', color: '#ff0000' }
    ])
  })

  it('deletes a note and accepts the empty answer', async () => {
    const { client, fetchImpl } = setup(new Response(null, { status: 204 }))

    await expect(deleteCustomerNote(client, 's1', 'c1', 'n1')).resolves.toBeUndefined()
    expect(fetchImpl.mock.calls[0]?.[1].method).toBe('DELETE')
  })
})

const side = (id: string) => ({ id, name: 'Ana', email: null, phone: null, channels: ['whatsapp'] })
const count = { survivor: 4, absorbed: 2, merged: 6 }
const detail = {
  id: 'c1',
  name: 'Ana',
  email: null,
  phone: null,
  locale: null,
  isCaution: false,
  cautionReason: null,
  identities: [],
  addresses: [],
  tags: [],
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z'
}

describe('the merge', () => {
  it('asks the preview for the absorbed customer of the survivor', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        survivor: side('c1'),
        absorbed: side('c2'),
        counts: {
          conversations: count,
          notes: count,
          addresses: count,
          tags: count,
          identities: count
        },
        conflicts: ['name']
      })
    )

    const preview = await fetchCustomerMergePreview(client, 's1', 'c1', 'c2')

    expect(fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/merge-preview?absorbedId=c2'
    )
    expect(preview.conflicts).toEqual(['name'])
    expect(preview.counts.conversations.merged).toBe(6)
  })

  it('posts the absorbed customer and the choices to the survivor', async () => {
    const { client, fetchImpl } = setup(json(200, detail))

    await mergeCustomers(client, 's1', 'c1', 'c2', { name: 'absorbed' })

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/customers/c1/merge')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe(
      JSON.stringify({ absorbedId: 'c2', fieldChoices: { name: 'absorbed' } })
    )
  })

  it('posts the merge id to undo it', async () => {
    const { client, fetchImpl } = setup(json(200, detail))

    await unmergeCustomers(client, 's1', 'c1', 'm1')

    const [url, init] = fetchImpl.mock.calls[0] ?? []
    expect(url).toBe('https://api.example.com/api/v1/customers/c1/unmerge')
    expect(init?.body).toBe(JSON.stringify({ mergeId: 'm1' }))
  })
})

describe('the identities', () => {
  it('links a handle and unlinks it by id', async () => {
    const identity = {
      id: 'i1',
      channelType: 'whatsapp',
      channelIdentity: '50370000000',
      displayName: null,
      lastInboundAt: null
    }
    const link = setup(json(201, identity))
    await expect(
      linkCustomerIdentity(link.client, 's1', 'c1', {
        channelType: 'whatsapp',
        channelIdentity: '7000 0000'
      })
    ).resolves.toEqual(identity)
    expect(link.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/identities'
    )

    const unlink = setup(new Response(null, { status: 204 }))
    await unlinkCustomerIdentity(unlink.client, 's1', 'c1', 'i1')
    expect(unlink.fetchImpl.mock.calls[0]?.[0]).toBe(
      'https://api.example.com/api/v1/customers/c1/identities/i1'
    )
    expect(unlink.fetchImpl.mock.calls[0]?.[1].method).toBe('DELETE')
  })
})
