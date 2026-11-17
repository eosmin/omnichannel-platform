import { FiscalEnvironment, FiscalVoidKind } from '@platform/core/domain'
import type { FiscalVoidDetails } from '@platform/fiscal/sdk'

import { SvDocumentTypes, SvVoidRefusals } from './sv-constants'
import {
  addMonths,
  buildInvalidation,
  invalidationCode,
  invalidationDeadline,
  type SvInvalidationInput
} from './sv-invalidation'
import { acceptedDocument, BUSINESS, ISSUER, schemaErrors } from './testing/sv-fixtures'

const PERSON = { name: 'Ana Pérez', idType: '13', idNumber: '012345678' }
const REQUESTER = { name: 'Luis Gómez', idType: '36', idNumber: '06140101011011' }
// A Tuesday of the same month the document was made in (its date is 2026-11-16)
const OTHER_UUID = '2b9d6bcd-bbfd-4b2d-9b5d-ab8dfbbd4bed'
const NOW = '2026-11-18T15:00:00.000Z'

function input(over: Partial<SvInvalidationInput> = {}): SvInvalidationInput {
  return {
    doc: acceptedDocument(),
    issuer: ISSUER,
    reason: 'Datos del cliente equivocados',
    details: { kind: FiscalVoidKind.RESCISSION, responsible: PERSON, requester: REQUESTER },
    code: invalidationCode('key-1'),
    now: NOW,
    ...over
  }
}

const refusal = (built: ReturnType<typeof buildInvalidation>): string | null =>
  built.ok ? null : built.reason

describe('the deadlines of an invalidation', () => {
  it('counts three calendar months for an invoice, to the last day of a shorter month', () => {
    expect(addMonths('2026-11-16', 3)).toBe('2027-02-16')
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28')
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29')
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31')
    expect(invalidationDeadline(SvDocumentTypes.INVOICE, '2026-11-16')).toBe('2027-02-16')
  })

  it('gives a tax credit document or a credit note the tenth business day of the next month', () => {
    // December 2026 starts on a Tuesday: business days 1,2,3,4 | 7,8,9,10,11 | 14 -> the tenth is the 15th (Monday)
    // 1 Tue, 2 Wed, 3 Thu, 4 Fri, 7 Mon, 8 Tue, 9 Wed, 10 Thu, 11 Fri, 14 Mon
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-11-16')).toBe('2026-12-14')
    expect(invalidationDeadline(SvDocumentTypes.CREDIT_NOTE, '2026-11-30')).toBe('2026-12-14')
    // The same whatever the day of the month
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-11-01')).toBe('2026-12-14')
  })

  it('crosses the year and skips the holidays it is given', () => {
    // January 2027 starts on a Friday: 1 Fri, 4 Mon, 5, 6, 7, 8, 11, 12, 13, 14 -> the tenth is the 14th
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-12-20')).toBe('2027-01-14')
    // With the first of January a holiday the count ends a business day later
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-12-20', ['2027-01-01'])).toBe(
      '2027-01-15'
    )
  })

  it('refuses a date that is not one', () => {
    expect(() => addMonths('2026-02-30', 1)).toThrow(RangeError)
    expect(() => invalidationDeadline(SvDocumentTypes.TAX_CREDIT, 'soon')).toThrow(RangeError)
  })
})

describe('the code of the event', () => {
  it('is the same for the same request, differs for another, and has the shape of the schema', () => {
    expect(invalidationCode('a')).toBe(invalidationCode('a'))
    expect(invalidationCode('a')).not.toBe(invalidationCode('b'))
    expect(invalidationCode('a')).toMatch(
      /^[A-F0-9]{8}-[A-F0-9]{4}-4[A-F0-9]{3}-[89AB][A-F0-9]{3}-[A-F0-9]{12}$/
    )
  })
})

describe('the invalidation event', () => {
  it('is what the authority’s schema takes, for a rescission of an invoice', () => {
    const built = buildInvalidation(input())
    expect(refusal(built)).toBeNull()
    if (!built.ok) return
    expect(schemaErrors('invalidation', built.event)).toEqual([])
    expect(built.event).toMatchObject({
      identificacion: {
        version: 3,
        ambiente: '00',
        fecEmi: '2026-11-18',
        horEmi: '09:00:00',
        fusion: null
      },
      emisor: { nit: '06140101011011', codEstableMH: 'M001', codPuntoVentaMH: 'P001' },
      documento: { tipoDte: '01', codigoGeneracionR: null, fecEmi: '2026-11-16' },
      motivo: {
        tipoAnulacion: 2,
        nombreResponsable: 'Ana Pérez',
        numDocSolicita: '06140101011011'
      }
    })
  })

  it('names the replacement first for a correction, and reads the buyer of a tax credit document', () => {
    const replacement = acceptedDocument({ correlative: 42, documentUuid: OTHER_UUID })
    const doc = acceptedDocument({ receiver: BUSINESS })
    const built = buildInvalidation(
      input({
        doc,
        details: {
          kind: FiscalVoidKind.CORRECTION,
          responsible: PERSON,
          requester: REQUESTER,
          replacement
        }
      })
    )
    expect(refusal(built)).toBeNull()
    if (!built.ok) return
    expect(schemaErrors('invalidation', built.event)).toEqual([])
    const code = (replacement.payload['identificacion'] as { codigoGeneracion: string })
      .codigoGeneracion
    expect(built.event['documento']).toMatchObject({
      tipoDte: '03',
      codigoGeneracionR: code,
      tipoDocumento: '36'
    })
    expect(built.event['motivo']).toMatchObject({ tipoAnulacion: 1 })
  })

  it('asks for the replacement of a correction and of another reason, never of a rescission', () => {
    for (const kind of [FiscalVoidKind.CORRECTION, FiscalVoidKind.OTHER]) {
      const details: FiscalVoidDetails = { kind, responsible: PERSON, requester: REQUESTER }
      expect(refusal(buildInvalidation(input({ details })))).toBe(
        SvVoidRefusals.REPLACEMENT_REQUIRED
      )
    }
    // A rescission that is given one does not carry it
    const replacement = acceptedDocument({ correlative: 42, documentUuid: OTHER_UUID })
    const built = buildInvalidation(
      input({
        details: {
          kind: FiscalVoidKind.RESCISSION,
          responsible: PERSON,
          requester: REQUESTER,
          replacement
        }
      })
    )
    expect(
      built.ok && (built.event['documento'] as Record<string, unknown>)['codigoGeneracionR']
    ).toBeNull()
  })

  it('refuses a replacement that is the document itself or that has no code', () => {
    const doc = acceptedDocument()
    const base = { kind: FiscalVoidKind.CORRECTION, responsible: PERSON, requester: REQUESTER }
    expect(refusal(buildInvalidation(input({ doc, details: { ...base, replacement: doc } })))).toBe(
      SvVoidRefusals.REPLACEMENT_INVALID
    )
    expect(
      refusal(
        buildInvalidation(
          input({
            doc,
            details: {
              ...base,
              replacement: { ...doc, payload: {}, providerData: null }
            }
          })
        )
      )
    ).toBe(SvVoidRefusals.REPLACEMENT_INVALID)
  })

  it('says what is missing, with a code, and sends nothing', () => {
    const check = (over: Partial<SvInvalidationInput>, reason: string): void => {
      expect(refusal(buildInvalidation(input(over)))).toBe(reason)
    }
    check({ details: undefined }, SvVoidRefusals.KIND_REQUIRED)
    check({ details: { kind: FiscalVoidKind.RESCISSION } }, SvVoidRefusals.PARTIES_REQUIRED)
    check(
      { details: { kind: FiscalVoidKind.RESCISSION, responsible: PERSON } },
      SvVoidRefusals.PARTIES_REQUIRED
    )
    check(
      {
        details: {
          kind: FiscalVoidKind.RESCISSION,
          responsible: { ...PERSON, name: ' ' },
          requester: REQUESTER
        }
      },
      SvVoidRefusals.PARTY_INVALID
    )
    check(
      {
        details: {
          kind: FiscalVoidKind.RESCISSION,
          responsible: { ...PERSON, idNumber: '1'.repeat(21) },
          requester: REQUESTER
        }
      },
      SvVoidRefusals.PARTY_INVALID
    )
    check({ reason: '   ' }, SvVoidRefusals.REASON_INVALID)
    check({ reason: 'x'.repeat(201) }, SvVoidRefusals.REASON_INVALID)
    check({ issuer: { ...ISSUER, phone: null } }, SvVoidRefusals.ISSUER_INCOMPLETE)
    check({ issuer: { ...ISSUER, establishmentCode: 'X1' } }, SvVoidRefusals.ISSUER_INCOMPLETE)
    check(
      { doc: { ...acceptedDocument(), providerData: null } },
      SvVoidRefusals.DOCUMENT_INCOMPLETE
    )
  })

  it('refuses an invoice after three months and a tax credit document after the tenth business day', () => {
    // The invoice is of 2026-11-16: the last day is 2027-02-16
    expect(refusal(buildInvalidation(input({ now: '2027-02-16T20:00:00.000Z' })))).toBeNull()
    expect(refusal(buildInvalidation(input({ now: '2027-02-17T06:30:00.000Z' })))).toBe(
      SvVoidRefusals.DEADLINE_PASSED
    )
    // The tax credit document of the same date: the last day is 2026-12-14, counted with the holidays of the accountant
    const doc = acceptedDocument({ receiver: BUSINESS })
    const holidays = ['2026-12-25']
    expect(
      refusal(buildInvalidation(input({ doc, holidays, now: '2026-12-14T20:00:00.000Z' })))
    ).toBeNull()
    expect(
      refusal(buildInvalidation(input({ doc, holidays, now: '2026-12-15T07:00:00.000Z' })))
    ).toBe(SvVoidRefusals.DEADLINE_PASSED)
  })

  it('leaves a deadline counted in business days to the authority until the holidays are listed', () => {
    // Without the list the tenth business day could come too early, and a lawful invalidation would be refused here
    const doc = acceptedDocument({ receiver: BUSINESS })
    expect(refusal(buildInvalidation(input({ doc, now: '2026-12-20T20:00:00.000Z' })))).toBeNull()
    // An invoice (calendar months) is always checked
    expect(refusal(buildInvalidation(input({ now: '2027-03-20T20:00:00.000Z' })))).toBe(
      SvVoidRefusals.DEADLINE_PASSED
    )
  })

  it('never cuts the number of the receiver and accepts only an identity document of the catalog', () => {
    const doc = acceptedDocument()
    const long = {
      ...doc,
      payload: {
        ...doc.payload,
        receptor: { ...(doc.payload['receptor'] as object), numDocumento: '1'.repeat(21) }
      }
    }
    expect(refusal(buildInvalidation(input({ doc: long })))).toBe(
      SvVoidRefusals.DOCUMENT_INCOMPLETE
    )
    const party = (over: object): FiscalVoidDetails => ({
      kind: FiscalVoidKind.RESCISSION,
      responsible: { ...PERSON, ...over },
      requester: REQUESTER
    })
    for (const bad of [
      { idType: '99' },
      { idType: '13', idNumber: '12345' },
      { idType: '36', idNumber: 'ABC' }
    ]) {
      expect(refusal(buildInvalidation(input({ details: party(bad) })))).toBe(
        SvVoidRefusals.PARTY_INVALID
      )
    }
    // Dashes of a national id are cleaned, as the document of a receiver is
    const built = buildInvalidation(
      input({ details: party({ idType: '13', idNumber: '01234567-8' }) })
    )
    expect(
      built.ok && (built.event['motivo'] as Record<string, unknown>)['numDocResponsable']
    ).toBe('012345678')
  })

  it('goes by the time of El Salvador, not by UTC', () => {
    // 2027-02-17 03:00 UTC is still the 16th in El Salvador (21:00): inside the window
    expect(refusal(buildInvalidation(input({ now: '2027-02-17T03:00:00.000Z' })))).toBeNull()
  })

  it('takes the environment from the issuer', () => {
    const built = buildInvalidation(
      input({ issuer: { ...ISSUER, environment: FiscalEnvironment.PRODUCTION } })
    )
    expect(built.ok && (built.event['identificacion'] as Record<string, unknown>)['ambiente']).toBe(
      '01'
    )
  })
})
