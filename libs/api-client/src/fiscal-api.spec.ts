import { FiscalDocumentStatus } from '@platform/core/domain'

import { createApiClient } from './api-client'
import {
  fetchFiscalDocument,
  fetchFiscalDocumentPage,
  fetchFiscalIssuer,
  fetchFiscalProviders,
  patchFiscalReceiver,
  putFiscalIssuer,
  replaceFiscalDocument,
  retryFiscalDocument,
  voidFiscalDocument
} from './fiscal-api'

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

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>) => {
  const [url, init] = fetchImpl.mock.calls[0] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

const detail = {
  orderNumber: 'ORD-1',
  pricesIncludeTax: true,
  lines: [
    {
      description: 'Widget',
      quantity: 1,
      unitPriceCents: 1130,
      taxRateBps: 1300,
      taxCents: 130,
      totalCents: 1130
    }
  ],
  shippingCents: 0,
  shippingTaxCents: 0,
  discountCents: 0,
  taxBreakdown: [{ taxRateBps: 1300, baseCents: 1000, taxCents: 130 }],
  consistent: true,
  issuer: {
    legalName: 'Shop',
    taxId: 'T-1',
    registrationId: null,
    address: { line1: 'Street 1' },
    activityCode: null,
    establishmentCode: null,
    environment: 'sandbox'
  }
}

const document = {
  id: 'd1',
  storeId: 's1',
  orderId: 'o1',
  kind: 'sale',
  returnId: null,
  parentDocumentId: null,
  replacesDocumentId: null,
  journalEntryId: null,
  sequenceNumber: 12,
  documentType: 'pending',
  status: 'accepted',
  providerId: 'p',
  environment: 'sandbox',
  externalNumber: 'X-1',
  currency: 'USD',
  totalCents: 11300,
  taxCents: 1300,
  rejectionReason: null,
  attempts: 1,
  voidReason: null,
  voidedAt: null,
  issuedAt: '2026-02-03T10:00:00.000Z',
  createdAt: '2026-02-03T09:00:00.000Z',
  receiver: { name: 'Ana', taxIdMasked: '****1234', complete: true }
}

describe('the fiscal documents', () => {
  it('reads a page with only the filters that are set, for the store of the header', async () => {
    const { client, fetchImpl } = setup(
      json(200, { data: [document], nextCursor: '12', hasMore: true })
    )
    const page = await fetchFiscalDocumentPage(
      client,
      'store-1',
      { status: FiscalDocumentStatus.REJECTED },
      '40'
    )
    const { url, headers } = callOf(fetchImpl)
    expect(url).toContain('/fiscal/documents?')
    expect(url).toContain('status=rejected')
    expect(url).toContain('cursor=40')
    expect(url).not.toContain('orderId')
    expect(headers.get('X-Store-Id')).toBe('store-1')
    expect(page.data[0]?.sequenceNumber).toBe(12)
    expect(page.nextCursor).toBe('12')
  })

  it('asks with no query at all when nothing narrows the list', async () => {
    const { client, fetchImpl } = setup(json(200, { data: [], nextCursor: null, hasMore: false }))
    await fetchFiscalDocumentPage(client, 's', {}, null)
    expect(callOf(fetchImpl).url.endsWith('/fiscal/documents')).toBe(true)
  })

  it('refuses a document with a status the lifecycle does not have', async () => {
    const { client } = setup(
      json(200, { data: [{ ...document, status: 'invented' }], nextCursor: null, hasMore: false })
    )
    await expect(fetchFiscalDocumentPage(client, 's', {}, null)).rejects.toThrow()
  })

  it('reads one document from its envelope', async () => {
    const { client, fetchImpl } = setup(json(200, { data: { ...document, detail } }))
    const read = await fetchFiscalDocument(client, 's', 'd1')
    expect(read.receiver.taxIdMasked).toBe('****1234')
    expect(read.detail.lines[0]?.description).toBe('Widget')
    expect(callOf(fetchImpl).url).toContain('/fiscal/documents/d1')
  })

  it('refuses a detail with no sealed snapshot, and sends the period of the list', async () => {
    const bad = setup(json(200, { data: document }))
    await expect(fetchFiscalDocument(bad.client, 's', 'd1')).rejects.toThrow()
    const page = setup(json(200, { data: [], nextCursor: null, hasMore: false }))
    await fetchFiscalDocumentPage(
      page.client,
      's',
      { from: '2026-01-01T00:00:00.000Z', to: '' },
      null
    )
    const { url } = callOf(page.fetchImpl)
    expect(url).toContain('from=2026-01-01T00%3A00%3A00.000Z')
    expect(url).not.toContain('to=')
  })

  it('fixes a receiver with the body as given, and never reads a full tax id back', async () => {
    const { client, fetchImpl } = setup(json(200, { data: document }))
    await patchFiscalReceiver(client, 's', 'd1', { name: 'Ana', address: { line: 'Street 1' } })
    const { url, init } = callOf(fetchImpl)
    expect(url).toContain('/fiscal/documents/d1/receiver')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(init.body as string)).toEqual({ name: 'Ana', address: { line: 'Street 1' } })
  })

  it('sends again, voids with its reason and makes the document again', async () => {
    const retried = setup(json(200, { data: { queued: true } }))
    await retryFiscalDocument(retried.client, 's', 'd1')
    expect(callOf(retried.fetchImpl).url).toContain('/fiscal/documents/d1/retry')
    expect(callOf(retried.fetchImpl).init.method).toBe('POST')

    const voided = setup(json(200, { data: { ...document, status: 'voided' } }))
    const view = await voidFiscalDocument(voided.client, 's', 'd1', 'wrong receiver')
    expect(view.status).toBe('voided')
    expect(JSON.parse(callOf(voided.fetchImpl).init.body as string)).toEqual({
      reason: 'wrong receiver'
    })

    const replaced = setup(json(200, { data: { ...document, id: 'd2' } }))
    expect((await replaceFiscalDocument(replaced.client, 's', 'd1')).id).toBe('d2')
    expect(callOf(replaced.fetchImpl).url).toContain('/fiscal/documents/d1/replace')
  })

  it('refuses an answer to a retry that did not queue the document', async () => {
    const { client } = setup(json(200, { data: { queued: false } }))
    await expect(retryFiscalDocument(client, 's', 'd1')).rejects.toThrow()
  })
})

describe('the fiscal issuer', () => {
  const issuer = {
    providerId: 'p',
    legalName: 'Shop',
    taxId: '123',
    registrationId: null,
    address: { line: 'Street 1' },
    activityCode: null,
    establishmentCode: null,
    environment: 'sandbox',
    issueOn: 'delivered',
    nextSequence: 5,
    credentialsSet: true,
    updatedAt: '2026-02-03T10:00:00.000Z'
  }

  it('is null while none is set up', async () => {
    const { client } = setup(json(200, { data: null }))
    expect(await fetchFiscalIssuer(client, 's')).toBeNull()
  })

  it('reads whether credentials are set and never their values', async () => {
    const { client } = setup(json(200, { data: issuer }))
    const view = await fetchFiscalIssuer(client, 's')
    expect(view?.credentialsSet).toBe(true)
    expect(view).not.toHaveProperty('credentials')
  })

  it('writes the issuer with PUT and the body as given', async () => {
    const { client, fetchImpl } = setup(json(200, { data: issuer }))
    await putFiscalIssuer(client, 's', {
      providerId: 'p',
      legalName: 'Shop',
      taxId: '123',
      registrationId: null,
      address: { line: 'Street 1' },
      activityCode: null,
      establishmentCode: null,
      environment: 'sandbox' as never,
      issueOn: 'delivered' as never,
      credentials: { key: 'secret' }
    })
    const { url, init } = callOf(fetchImpl)
    expect(url).toContain('/fiscal/issuer')
    expect(init.method).toBe('PUT')
    expect((JSON.parse(init.body as string) as { credentials: unknown }).credentials).toEqual({
      key: 'secret'
    })
  })

  it('reads the providers of the deployment with their manifests', async () => {
    const { client } = setup(
      json(200, {
        data: [
          {
            id: 'p',
            countryCode: 'XX',
            manifest: {
              documentTypes: [{ id: 't', label: 'Type', requiredReceiverFields: ['name'] }],
              requiredIssuerFields: ['legalName'],
              credentialKeys: ['signingKey'],
              environments: ['sandbox']
            },
            contingency: null
          }
        ]
      })
    )
    const providers = await fetchFiscalProviders(client, 's')
    expect(providers[0]?.manifest.credentialKeys).toEqual(['signingKey'])
  })
})
