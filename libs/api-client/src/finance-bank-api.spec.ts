import { createApiClient } from './api-client'
import { ApiError } from './api-error'
import {
  confirmBankMatch,
  confirmExactBankLines,
  createBankProfile,
  deleteBankProfile,
  fetchBankDifference,
  fetchBankImport,
  fetchBankImports,
  fetchBankLines,
  fetchBankProfiles,
  fetchBankRegisterDraft,
  fetchBankStatus,
  importBankStatement,
  previewBankProfile,
  rejectBankMatch,
  undoBankMatch,
  updateBankProfile
} from './finance-bank-api'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

function setup(...responses: Response[]) {
  const queue = [...responses]
  const fetchImpl = jest.fn<Promise<Response>, [string, RequestInit]>().mockImplementation(() => {
    const next = queue.length > 1 ? queue.shift() : queue[0]
    return Promise.resolve((next as Response).clone())
  })
  const client = createApiClient({
    baseUrl: 'https://api.example.com',
    getAccessToken: () => 'token',
    refreshAccessToken: () => Promise.resolve('token'),
    fetchImpl: fetchImpl as unknown as typeof fetch
  })
  return { client, fetchImpl }
}

const callOf = (fetchImpl: jest.Mock<Promise<Response>, [string, RequestInit]>, index = 0) => {
  const [url, init] = fetchImpl.mock.calls[index] ?? ['', {}]
  return { url, init, headers: new Headers(init.headers) }
}

const bytesOf = (text: string): ArrayBuffer => new TextEncoder().encode(text).buffer

const BASE = 'https://api.example.com/api/v1/finance'

const profile = {
  id: 'p1',
  accountId: 'a1',
  name: 'Bank',
  delimiter: ',',
  hasHeader: true,
  skipRows: 0,
  decimalSeparator: '.',
  thousandsSeparator: 'none',
  dateFormat: 'yyyy-MM-dd',
  encoding: 'utf-8',
  dateWindowDays: 3,
  columns: { date: 'Date', amount: 'Amount' },
  createdAt: '2026-11-16T10:00:00.000Z',
  updatedAt: '2026-11-16T10:00:00.000Z'
}

const statement = {
  id: 'i1',
  accountId: 'a1',
  profileId: 'p1',
  mediaId: 'm1',
  lineCount: 3,
  newLineCount: 3,
  firstDay: '2026-11-01',
  lastDay: '2026-11-30',
  closingBalanceCents: 123456,
  closingOn: '2026-11-30',
  createdAt: '2026-12-01T10:00:00.000Z'
}

const line = {
  id: 'l1',
  importId: 'i1',
  lineNo: 1,
  postedOn: '2026-11-03',
  amountCents: -1500,
  description: 'Fuel',
  reference: 'REF-9',
  match: null,
  suggestions: [
    {
      bookLineId: 'j1',
      dayDifference: 0,
      referenceMatch: true,
      exact: true,
      entryId: 'e1',
      entryNumber: 'JE-7',
      entryDate: '2026-11-03',
      memo: null,
      signedCents: -1500
    }
  ]
}

describe('finance bank api', () => {
  it('reads the profiles of one account through the store of the request', async () => {
    const { client, fetchImpl } = setup(json(200, [profile]))

    const profiles = await fetchBankProfiles(client, 's1', 'a1')

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-profiles?accountId=a1`)
    expect(callOf(fetchImpl).headers.get('x-store-id')).toBe('s1')
    expect(profiles[0]?.columns).toEqual({ date: 'Date', amount: 'Amount' })
  })

  it('makes a profile with the account in the body, and changes one by its id', async () => {
    const { client, fetchImpl } = setup(json(201, profile), json(200, profile))
    const reading = {
      delimiter: ',',
      hasHeader: true,
      skipRows: 0,
      decimalSeparator: '.',
      thousandsSeparator: 'none',
      dateFormat: 'yyyy-MM-dd',
      encoding: 'utf-8',
      dateWindowDays: 3,
      columns: { date: 'Date', amount: 'Amount' }
    }

    await createBankProfile(client, 's1', { accountId: 'a1', name: 'Bank', ...reading })
    await updateBankProfile(client, 's1', 'p 1', { name: 'Renamed' })

    expect(callOf(fetchImpl).init.method).toBe('POST')
    expect(JSON.parse(callOf(fetchImpl).init.body as string)).toEqual({
      accountId: 'a1',
      name: 'Bank',
      ...reading
    })
    // The id is escaped: it is a path segment
    expect(callOf(fetchImpl, 1).url).toBe(`${BASE}/bank-profiles/p%201`)
    expect(callOf(fetchImpl, 1).init.method).toBe('PATCH')
  })

  it('deletes a profile and answers nothing', async () => {
    const { client, fetchImpl } = setup(new Response(null, { status: 204 }))

    await expect(deleteBankProfile(client, 's1', 'p1')).resolves.toBeUndefined()

    expect(callOf(fetchImpl).init.method).toBe('DELETE')
  })

  it('previews a sample with the mapping being tried', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        headers: ['Date'],
        rowCount: 1,
        lines: [],
        errors: [],
        errorCount: 0,
        dateFormatUndecided: false
      })
    )

    await previewBankProfile(client, 's1', {
      text: 'Date,Amount\n2026-11-01,1.00',
      profile: {
        delimiter: ',',
        hasHeader: true,
        skipRows: 0,
        decimalSeparator: '.',
        thousandsSeparator: 'none',
        dateFormat: 'yyyy-MM-dd',
        columns: { date: 'Date', amount: 'Amount' }
      }
    })

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-profiles/preview`)
    expect(callOf(fetchImpl).init.method).toBe('POST')
  })

  it('sends the file itself as text with its own content type and the closing balance in the query', async () => {
    const { client, fetchImpl } = setup(json(201, statement))

    await importBankStatement(client, 's1', {
      profileId: 'p1',
      bytes: bytesOf('Date;Amount\n2026-11-01;1,00'),
      contentType: 'text/csv',
      closing: { cents: 123456, on: '2026-11-30' }
    })

    const call = callOf(fetchImpl)
    expect(call.url).toBe(
      `${BASE}/bank-imports?profileId=p1&closingBalanceCents=123456&closingOn=2026-11-30`
    )
    // The bytes of the file, not a string: the api decodes them with the encoding of the profile
    expect(call.init.body).toBeInstanceOf(ArrayBuffer)
    expect(new Uint8Array(call.init.body as ArrayBuffer)).toEqual(
      new Uint8Array(bytesOf('Date;Amount\n2026-11-01;1,00'))
    )
    expect(call.headers.get('content-type')).toBe('text/csv')
  })

  it('sends no balance when the person gave none', async () => {
    const { client, fetchImpl } = setup(
      json(201, { ...statement, closingBalanceCents: null, closingOn: null })
    )

    const imported = await importBankStatement(client, 's1', {
      profileId: 'p1',
      bytes: bytesOf('x'),
      contentType: 'text/tab-separated-values'
    })

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-imports?profileId=p1`)
    expect(callOf(fetchImpl).headers.get('content-type')).toBe('text/tab-separated-values')
    expect(imported.closingBalanceCents).toBeNull()
  })

  it('keeps the rows a refused statement names', async () => {
    const { client } = setup(
      json(400, {
        correlationId: 'corr-1',
        error: {
          code: 'BANK_STATEMENT_INVALID',
          message: 'the file has rows that cannot be read',
          metadata: {
            errorCount: 1,
            errors: [{ row: 2, field: 'amount', code: 'invalid_amount', value: 'abc' }]
          }
        }
      })
    )

    const error = await importBankStatement(client, 's1', {
      profileId: 'p1',
      bytes: bytesOf('x'),
      contentType: 'text/csv'
    }).catch((caught: unknown) => caught)

    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).code).toBe('BANK_STATEMENT_INVALID')
    expect((error as ApiError).metadata.errorCount).toBe(1)
  })

  it('lists the statements of an account and reads one by its id', async () => {
    const { client, fetchImpl } = setup(json(200, [statement]), json(200, statement))

    await fetchBankImports(client, 's1', 'a1')
    await fetchBankImport(client, 's1', 'i1')

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-imports?accountId=a1&limit=100`)
    expect(callOf(fetchImpl, 1).url).toBe(`${BASE}/bank-imports/i1`)
  })

  it('reads a page of lines by the row of the last one and the filter', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        items: [line],
        next: 50,
        counts: { total: 3, matched: 0, unmatched: 2, suggested: 1 }
      })
    )

    const page = await fetchBankLines(client, 's1', 'i1', { filter: 'suggested', after: 25 })

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-imports/i1/lines?filter=suggested&after=25`)
    expect(page.items[0]?.suggestions[0]?.bookLineId).toBe('j1')
    expect(page.next).toBe(50)
  })

  it('asks for the first page with no cursor', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        items: [],
        next: null,
        counts: { total: 0, matched: 0, unmatched: 0, suggested: 0 }
      })
    )

    await fetchBankLines(client, 's1', 'i1', { filter: 'all', after: null })

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-imports/i1/lines?filter=all`)
  })

  it('confirms and rejects a pair by the line of the journal, and takes a decision back by its id', async () => {
    const { client, fetchImpl } = setup(json(201, line), json(201, line), json(200, line))

    await confirmBankMatch(client, 's1', 'l1', 'j1')
    await rejectBankMatch(client, 's1', 'l1', 'j1')
    await undoBankMatch(client, 's1', 'm1')

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-lines/l1/matches`)
    expect(JSON.parse(callOf(fetchImpl).init.body as string)).toEqual({ journalLineId: 'j1' })
    expect(callOf(fetchImpl, 1).url).toBe(`${BASE}/bank-lines/l1/rejections`)
    expect(callOf(fetchImpl, 2).url).toBe(`${BASE}/bank-matches/m1/undo`)
    expect(callOf(fetchImpl, 2).init.method).toBe('POST')
  })

  it('confirms the exact matches of a statement in one request that sends no list of lines', async () => {
    const { client, fetchImpl } = setup(json(200, { confirmed: 4, left: 2 }))

    const result = await confirmExactBankLines(client, 's1', 'i1')

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-imports/i1/confirm-exact`)
    expect(callOf(fetchImpl).init.method).toBe('POST')
    expect(callOf(fetchImpl).init.body).toBeUndefined()
    expect(result).toEqual({ confirmed: 4, left: 2 })
  })

  it('reads the difference, the draft of a line and the status of a month', async () => {
    const { client, fetchImpl } = setup(
      json(200, {
        importId: 'i1',
        accountId: 'a1',
        closingOn: '2026-11-30',
        statementBalanceCents: 100,
        bookBalanceCents: 90,
        differenceCents: 10,
        unmatchedStatement: { lines: 1, cents: 10 },
        unmatchedBook: { lines: 0, cents: 0 },
        unexplainedCents: 0
      }),
      json(200, {
        kind: 'expense',
        occurredOn: '2026-11-03',
        amountCents: 1500,
        fromAccountId: 'a1'
      }),
      json(200, {
        kind: 'expense',
        occurredOn: '2026-11-03',
        amountCents: 1500,
        fromAccountId: 'a1',
        memo: 'Bank fee'
      }),
      json(200, {
        accountId: 'a1',
        year: 2026,
        month: 11,
        book: { lines: 2, matched: 2, unmatched: 0, unmatchedCents: 0 },
        statement: { lines: 2, matched: 2, unmatched: 0, unmatchedCents: 0 },
        reconciled: true
      })
    )

    await fetchBankDifference(client, 's1', 'i1')
    const draft = await fetchBankRegisterDraft(client, 's1', 'l1')
    const withMemo = await fetchBankRegisterDraft(client, 's1', 'l1', {
      useDescriptionAsMemo: true
    })
    const status = await fetchBankStatus(client, 's1', { accountId: 'a1', year: 2026, month: 11 })

    expect(callOf(fetchImpl).url).toBe(`${BASE}/bank-imports/i1/difference`)
    expect(callOf(fetchImpl, 1).url).toBe(`${BASE}/bank-lines/l1/register-draft`)
    expect(draft.toAccountId).toBeUndefined()
    expect(callOf(fetchImpl, 2).url).toBe(
      `${BASE}/bank-lines/l1/register-draft?useDescriptionAsMemo=true`
    )
    expect(withMemo.memo).toBe('Bank fee')
    expect(callOf(fetchImpl, 3).url).toBe(
      `${BASE}/bank-reconciliation/status?accountId=a1&year=2026&month=11`
    )
    expect(status.reconciled).toBe(true)
  })

  it('refuses an answer whose amounts are not whole cents', async () => {
    const { client } = setup(json(200, [{ ...statement, closingBalanceCents: 12.5 }]))

    await expect(fetchBankImports(client, 's1', 'a1')).rejects.toThrow()
  })
})
