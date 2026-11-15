import { createHash } from 'node:crypto'

import { LedgerHash } from '@platform/core/domain'

// The hash chain of the journal (TDD_18 §2.5, §11): each entry carries the hash of the one before it, so an entry
// changed in place, or one removed from the middle, breaks the chain and an auditor holding only the CSV can see it.
// The chain proves that; it does not prove that the last entries were not truncated (the frozen head of a closed
// period and the auditor's copy of the CSV cover that, TDD_18 §11).

// Version of the canonical form. It is the first field hashed, so a future form cannot collide with this one.
export const LEDGER_HASH_VERSION = 'v1'

export interface HashableLine {
  lineNo: number
  accountId: string
  debitCents: number
  creditCents: number
  storeId: string | null
  partyType: string | null
  partyId: string | null
  taxRateId: string | null
  memo: string | null
}

export interface HashableEntry {
  number: bigint
  // 'YYYY-MM-DD'
  entryDate: string
  // The period the entry sits in and the total it carries: moving an entry to another period or changing its total is detected
  periodId: string
  totalCents: number
  currency: string
  type: string
  sourceType: string | null
  sourceId: string | null
  // 'YYYY-MM-DD' or null: when the source event really happened
  sourceDate: string | null
  reversesEntryId: string | null
  // Covered too, with the memos, the tax rate of a line, the source date, the period, the total and the number of each line: a figure or an attribution edited behind the
  // application is detected, which TDD_18 §11 does not ask for and costs nothing (decision of Step 4B.2)
  idempotencyKey: string
  memo: string | null
  origin: string
  createdBy: string | null
  prevHash: string | null
  lines: readonly HashableLine[]
}

// A field cannot contain a separator: `\`, `|` and `,` are escaped, so two different entries never share a canonical
// string (`a|b` and `a`, `b` are not the same thing)
// A missing value (NULL) and an empty one ('') are different rows and hash differently: a present value is written after a
// `=`, a missing one as nothing at all
const escaped = (value: string | number | bigint | null): string =>
  value === null ? '' : `=${String(value).replace(/[\\|,]/g, character => `\\${character}`)}`

export function canonicalEntry(entry: HashableEntry): string {
  const lines = entry.lines.map(line =>
    [
      line.lineNo,
      line.accountId,
      line.debitCents,
      line.creditCents,
      line.storeId,
      // A party is its type and its id, kept as two fields
      line.partyType,
      line.partyId,
      line.taxRateId,
      line.memo
    ]
      .map(escaped)
      .join(',')
  )
  return (
    [
      LEDGER_HASH_VERSION,
      entry.prevHash,
      entry.number,
      entry.entryDate,
      entry.periodId,
      entry.totalCents,
      entry.currency,
      entry.type,
      entry.sourceType,
      entry.sourceId,
      entry.sourceDate,
      entry.reversesEntryId,
      entry.idempotencyKey,
      entry.memo,
      entry.origin,
      entry.createdBy
    ]
      .map(escaped)
      // The fields of a line are escaped already: its own commas are the only unescaped ones, and the separator of the
      // entry is the only unescaped bar
      .concat(lines)
      .join(LedgerHash.SEPARATOR)
  )
}

export function hashEntry(entry: HashableEntry): string {
  return createHash(LedgerHash.ALGORITHM).update(canonicalEntry(entry), 'utf8').digest('hex')
}

export interface ChainEntry extends HashableEntry {
  id: string
  hash: string
}

export interface ChainBreak {
  entryId: string
  number: bigint
  reason: 'number_gap' | 'prev_hash_mismatch' | 'hash_mismatch'
}

// Walks the entries of one organization in number order: the numbers go 1, 2, 3 with no gap, each prevHash is the hash
// of the entry before (null for the first), and each hash is the one its content gives. Returns the first break, or
// null for a sound chain. `from` is where the walk starts: number 1 and no previous hash for the whole chain, or the
// number after a frozen head with the hash the chain had there.
export function verifyChain(
  entries: readonly ChainEntry[],
  from: { number: bigint; prevHash: string | null } = { number: 1n, prevHash: null }
): ChainBreak | null {
  let expectedNumber = from.number
  let previousHash = from.prevHash
  for (const entry of entries) {
    const at = { entryId: entry.id, number: entry.number }
    if (entry.number !== expectedNumber) return { ...at, reason: 'number_gap' }
    if (entry.prevHash !== previousHash) return { ...at, reason: 'prev_hash_mismatch' }
    if (hashEntry(entry) !== entry.hash) return { ...at, reason: 'hash_mismatch' }
    expectedNumber += 1n
    previousHash = entry.hash
  }
  return null
}
