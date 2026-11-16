import { randomUUID } from 'node:crypto'

import { BankLineFilters } from '@platform/core/domain'

import {
  bankImportQuerySchema,
  bankPairSchema,
  bankPreviewSchema,
  bankStatusQuerySchema,
  createBankProfileSchema,
  listBankLinesQuerySchema,
  updateBankProfileSchema
} from '../../apps/api/src/modules/finance/finance-bank.schemas'
import {
  type BankProfileDraft,
  bankReadingOf,
  createBankProfileInputOf,
  emptyBankDraft,
  MoneyModes,
  updateBankProfileInputOf
} from '../../apps/web/lib/finance/bank-form'
import { importInputOf } from '../../apps/web/lib/finance/bank-statement'

// What the bank reconciliation screen sends, checked against the schemas the api refuses with (Step 4B.9a-3). The screen builds its
// payloads in pure functions (`bank-form`, `bank-statement`) and the api validates them with strict zod schemas it owns: this is the
// one place where both are held together, so a field that one side renames or tightens fails here and not in front of an accountant.

const draft = (over: Partial<BankProfileDraft> = {}): BankProfileDraft => ({
  ...emptyBankDraft(),
  name: 'Banco Uno',
  date: 'Fecha',
  amount: 'Monto',
  ...over
})

const DRAFTS: [string, BankProfileDraft][] = [
  ['a signed amount with a header', draft()],
  [
    'a debit and a credit column',
    draft({ mode: MoneyModes.SPLIT, amount: '', debit: 'Cargo', credit: 'Abono' })
  ],
  ['optional columns', draft({ description: 'Detalle', reference: 'Referencia' })],
  ['no header, by position', draft({ hasHeader: false, date: '0', amount: '3', reference: '5' })],
  [
    'semicolons, a decimal comma and day first',
    draft({
      delimiter: ';',
      decimalSeparator: ',',
      thousandsSeparator: 'dot',
      dateFormat: 'dd/MM/yyyy',
      encoding: 'windows-1252',
      dateWindowDays: '0'
    })
  ],
  ['a tab and the widest window', draft({ delimiter: '\t', dateWindowDays: '31' })],
  ['a name with an accent', draft({ name: 'Cuenta de ahorros ñ' })]
]

describe('the profile the screen makes is the one the api takes', () => {
  it.each(DRAFTS)('creates a profile with %s', (_name, source) => {
    const input = createBankProfileInputOf(source, randomUUID())

    expect(input.ok).toBe(true)
    if (!input.ok) return
    expect(createBankProfileSchema.safeParse(input.value).success).toBe(true)
  })

  it.each(DRAFTS)('changes a profile with %s', (_name, source) => {
    const input = updateBankProfileInputOf(source)

    expect(input.ok).toBe(true)
    if (!input.ok) return
    expect(updateBankProfileSchema.safeParse(input.value).success).toBe(true)
  })

  it.each(DRAFTS)('previews a sample with %s', (_name, source) => {
    const reading = bankReadingOf(source)

    expect(reading.ok).toBe(true)
    if (!reading.ok) return
    expect(
      bankPreviewSchema.safeParse({ text: 'Fecha;Monto\n2026-11-01;1,00', profile: reading.value })
        .success
    ).toBe(true)
  })

  it('keeps the profile the api refuses out of the screen too', () => {
    // The rules of the profiles are one function of the domain, so a form the screen refuses is a body the api refuses
    const refused = [
      draft({ reference: 'Fecha' }),
      draft({ delimiter: ',', decimalSeparator: ',' }),
      draft({ thousandsSeparator: 'dot', decimalSeparator: '.' })
    ]
    for (const source of refused) {
      expect(bankReadingOf(source).ok).toBe(false)
    }
    const valid = createBankProfileInputOf(draft(), randomUUID())
    if (!valid.ok) throw new Error('the form refused a valid profile')
    expect(createBankProfileSchema.safeParse(valid.value).success).toBe(true)
    expect(
      createBankProfileSchema.safeParse({ ...valid.value, decimalSeparator: ',' }).success
    ).toBe(false)
  })
})

describe('the import the screen sends is the one the api takes', () => {
  const file = {
    bytes: new TextEncoder().encode('Fecha,Monto\n2026-11-01,1.00').buffer,
    contentType: 'text/csv'
  }
  const queryOf = (
    profileId: string,
    closing?: { cents: number; on: string }
  ): Record<string, string> => {
    const input = importInputOf(
      {
        profileId,
        closingBalance: closing === undefined ? '' : String(closing.cents / 100),
        closingOn: closing?.on ?? ''
      },
      file
    )
    if (!input.ok) throw new Error('the form refused')
    const search = new URLSearchParams({ profileId: input.value.profileId })
    if (input.value.closing !== undefined) {
      search.set('closingBalanceCents', String(input.value.closing.cents))
      search.set('closingOn', input.value.closing.on)
    }
    return Object.fromEntries(search.entries())
  }

  it('imports with no closing balance', () => {
    expect(bankImportQuerySchema.safeParse(queryOf(randomUUID())).success).toBe(true)
  })

  it('imports with the closing balance in whole cents and its day', () => {
    const parsed = bankImportQuerySchema.safeParse(
      queryOf(randomUUID(), { cents: 123456, on: '2026-11-30' })
    )

    expect(parsed.success && parsed.data.closingBalanceCents).toBe(123456)
  })

  it('imports a negative balance', () => {
    const parsed = bankImportQuerySchema.safeParse(
      queryOf(randomUUID(), { cents: -5000, on: '2026-11-30' })
    )

    expect(parsed.success && parsed.data.closingBalanceCents).toBe(-5000)
  })
})

describe('the other requests of the screen are the ones the api takes', () => {
  it('asks for a page of lines with every filter', () => {
    for (const filter of Object.values(BankLineFilters)) {
      expect(listBankLinesQuerySchema.safeParse({ filter, after: '25' }).success).toBe(true)
    }
    expect(listBankLinesQuerySchema.safeParse({ filter: 'all' }).success).toBe(true)
  })

  it('decides on a pair by the line of the journal', () => {
    expect(bankPairSchema.safeParse({ journalLineId: randomUUID() }).success).toBe(true)
    expect(
      bankPairSchema.safeParse({ journalLineId: randomUUID(), status: 'confirmed' }).success
    ).toBe(false)
  })

  it('asks for the status of a month', () => {
    expect(
      bankStatusQuerySchema.safeParse({ accountId: randomUUID(), year: '2026', month: '11' })
        .success
    ).toBe(true)
  })
})
