import {
  canonicalEntry,
  type ChainEntry,
  hashEntry,
  type HashableEntry,
  verifyChain
} from './ledger-hash'

const base = (number: bigint, prevHash: string | null): HashableEntry => ({
  number,
  entryDate: '2026-11-15',
  periodId: 'p1',
  totalCents: 100,
  currency: 'USD',
  type: 'expense',
  sourceType: null,
  sourceId: null,
  sourceDate: null,
  reversesEntryId: null,
  idempotencyKey: `k${number}`,
  memo: null,
  origin: 'user',
  createdBy: 'u1',
  prevHash,
  lines: [
    {
      lineNo: 1,
      accountId: 'a',
      debitCents: 100,
      creditCents: 0,
      storeId: null,
      partyType: null,
      partyId: null,
      taxRateId: null,
      memo: null
    },
    {
      lineNo: 2,
      accountId: 'b',
      debitCents: 0,
      creditCents: 100,
      storeId: 's',
      partyType: 'supplier',
      partyId: 'p',
      taxRateId: null,
      memo: null
    }
  ]
})

// An element that has to be there: a spec fails on its own if it is not
function at<T>(items: readonly T[], index: number): T {
  const item = items[index]
  if (item === undefined) throw new Error(`no element at ${index}`)
  return item
}

const firstLine = at(base(1n, null).lines, 0)

function chain(length: number): ChainEntry[] {
  const out: ChainEntry[] = []
  let prev: string | null = null
  for (let n = 1; n <= length; n++) {
    const body = base(BigInt(n), prev)
    const hash = hashEntry(body)
    out.push({ ...body, id: `e${n}`, hash })
    prev = hash
  }
  return out
}

describe('hashEntry', () => {
  it('is pinned: the canonical form and the digest never change under an existing chain', () => {
    // If this fails the canonical form changed: every chain already written would break. Bump LEDGER_HASH_VERSION instead.
    expect(canonicalEntry(base(1n, null))).toBe(
      '=v1||=1|=2026-11-15|=p1|=100|=USD|=expense|||||=k1||=user|=u1|=1,=a,=100,=0,,,,,|=2,=b,=0,=100,=s,=supplier,=p,,'
    )
    expect(hashEntry(base(1n, null))).toBe(
      '931f02f6fce826974754758b893795596f9557d7c1fc80b948ebc78e3d141e28'
    )
  })

  it('changes with any field of the entry or of a line', () => {
    const original = hashEntry(base(1n, null))
    const variants: HashableEntry[] = [
      { ...base(1n, null), number: 2n },
      { ...base(1n, null), entryDate: '2026-11-16' },
      { ...base(1n, null), periodId: 'p2' },
      { ...base(1n, null), totalCents: 101 },
      { ...base(1n, null), currency: 'COP' },
      {
        ...base(1n, null),
        lines: base(1n, null).lines.map(line => ({ ...line, lineNo: line.lineNo + 1 }))
      },
      { ...base(1n, null), type: 'income' },
      { ...base(1n, null), sourceType: 'order' },
      { ...base(1n, null), sourceId: 'x' },
      { ...base(1n, null), sourceDate: '2026-11-01' },
      { ...base(1n, null), reversesEntryId: 'x' },
      { ...base(1n, null), idempotencyKey: 'other' },
      { ...base(1n, null), memo: 'edited' },
      { ...base(1n, null), origin: 'system' },
      { ...base(1n, null), createdBy: 'u2' },
      { ...base(1n, null), prevHash: 'abc' },
      { ...base(1n, null), lines: base(1n, null).lines.slice(0, 1) },
      {
        ...base(1n, null),
        lines: base(1n, null).lines.map(line => ({ ...line, debitCents: line.debitCents + 1 }))
      },
      {
        ...base(1n, null),
        lines: base(1n, null).lines.map(line => ({ ...line, accountId: 'z' }))
      },
      {
        ...base(1n, null),
        lines: base(1n, null).lines.map(line => ({ ...line, storeId: 'other' }))
      },
      {
        ...base(1n, null),
        lines: base(1n, null).lines.map(line => ({ ...line, partyId: 'other' }))
      },
      {
        ...base(1n, null),
        lines: base(1n, null).lines.map(line => ({ ...line, taxRateId: 'iva-exempt' }))
      },
      {
        ...base(1n, null),
        lines: base(1n, null).lines.map(line => ({ ...line, memo: 'edited' }))
      }
    ]
    for (const variant of variants) expect(hashEntry(variant)).not.toBe(original)
  })

  it('tells a missing value from an empty one', () => {
    const missing = base(1n, null)
    expect(hashEntry({ ...missing, memo: '' })).not.toBe(hashEntry(missing))
    expect(hashEntry({ ...missing, sourceId: '' })).not.toBe(hashEntry(missing))
    expect(
      hashEntry({ ...missing, lines: missing.lines.map(line => ({ ...line, partyId: '' })) })
    ).not.toBe(hashEntry(missing))
  })

  it('does not let two different entries share a canonical string through a separator', () => {
    const a: HashableEntry = { ...base(1n, null), sourceType: 'a|b', sourceId: 'c' }
    const b: HashableEntry = { ...base(1n, null), sourceType: 'a', sourceId: 'b|c' }
    const commas: HashableEntry = {
      ...base(1n, null),
      lines: [{ ...firstLine, accountId: 'x,1' }]
    }
    const split: HashableEntry = {
      ...base(1n, null),
      lines: [{ ...firstLine, accountId: 'x', debitCents: 1 }]
    }
    expect(hashEntry(a)).not.toBe(hashEntry(b))
    expect(hashEntry(commas)).not.toBe(hashEntry(split))
    expect(canonicalEntry({ ...base(1n, null), memo: 'back\\slash' })).toContain('back\\\\slash')
  })
})

describe('verifyChain', () => {
  it('accepts a sound chain, an empty one and one that starts after a frozen head', () => {
    expect(verifyChain(chain(5))).toBeNull()
    expect(verifyChain([])).toBeNull()
    const full = chain(5)
    expect(verifyChain(full.slice(2), { number: 3n, prevHash: at(full, 1).hash })).toBeNull()
  })

  it('finds an entry changed in place', () => {
    const entries = chain(4)
    entries[1] = { ...at(entries, 1), memo: 'edited behind the application' }
    expect(verifyChain(entries)).toEqual({ entryId: 'e2', number: 2n, reason: 'hash_mismatch' })
  })

  it('finds an entry removed from the middle, by the gap of the numbers', () => {
    const entries = chain(4)
    entries.splice(1, 1)
    expect(verifyChain(entries)).toEqual({ entryId: 'e3', number: 3n, reason: 'number_gap' })
  })

  it('finds a link that points at another entry', () => {
    const entries = chain(3)
    entries[2] = { ...at(entries, 2), prevHash: 'f'.repeat(64) }
    expect(verifyChain(entries)).toEqual({
      entryId: 'e3',
      number: 3n,
      reason: 'prev_hash_mismatch'
    })
  })

  it('finds a first entry that claims a predecessor', () => {
    const entries = chain(2)
    entries[0] = { ...at(entries, 0), prevHash: 'a' }
    expect(verifyChain(entries)?.reason).toBe('prev_hash_mismatch')
  })
})
