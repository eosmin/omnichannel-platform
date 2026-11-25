import { FiscalDocumentKind, FiscalEnvironment, FiscalVoidKind } from '@platform/core/domain'
import type { FiscalVoidDetails } from '@platform/fiscal/sdk'

import {
  SvDocumentTypes,
  SvInvalidationDeadlineRules,
  SvInvalidationDeadlineUnits,
  SvProviderDataKeys,
  SvVoidRefusals
} from './sv-constants'
import {
  addMonths,
  buildInvalidation,
  invalidationCode,
  invalidationDeadline,
  sealDateOf,
  type SvInvalidationInput
} from './sv-invalidation'
import { acceptedDocument, BUSINESS, credited, ISSUER, schemaErrors } from './testing/sv-fixtures'

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
  it('counts three calendar months from the seal for an invoice, to the last day of a shorter month', () => {
    expect(addMonths('2026-11-16', 3)).toBe('2027-02-16')
    expect(addMonths('2026-11-30', 3)).toBe('2027-02-28')
    expect(addMonths('2027-11-30', 3)).toBe('2028-02-29')
    expect(addMonths('2026-12-31', 1)).toBe('2027-01-31')
    expect(invalidationDeadline(SvDocumentTypes.INVOICE, '2026-11-16')).toBe('2027-02-16')
    expect(invalidationDeadline(SvDocumentTypes.INVOICE, '2026-11-30')).toBe('2027-02-28')
  })

  it('gives a tax credit document or a credit note one calendar day after the seal (the stricter text)', () => {
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-11-16')).toBe('2026-11-17')
    expect(invalidationDeadline(SvDocumentTypes.CREDIT_NOTE, '2026-11-30')).toBe('2026-12-01')
    // Over the end of a year, and a leap day
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-12-31')).toBe('2027-01-01')
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2028-02-28')).toBe('2028-02-29')
    // Calendar days: a Friday seal still ends on the Saturday
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-11-20')).toBe('2026-11-21')
  })

  it('still counts the tenth business day of the next month when that rule is the one given', () => {
    const body = {
      ...SvInvalidationDeadlineRules,
      [SvDocumentTypes.TAX_CREDIT]: {
        unit: SvInvalidationDeadlineUnits.BUSINESS_DAY_OF_NEXT_MONTH,
        amount: 10
      }
    }
    // December 2026: 1 Tue, 2, 3, 4 | 7, 8, 9, 10, 11 | 14 Mon is the tenth
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-11-16', [], body)).toBe(
      '2026-12-14'
    )
    // January 2027 starts on a Friday: the tenth is the 14th, or the 15th with the first a holiday
    expect(invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-12-20', [], body)).toBe(
      '2027-01-14'
    )
    expect(
      invalidationDeadline(SvDocumentTypes.TAX_CREDIT, '2026-12-20', ['2027-01-01'], body)
    ).toBe('2027-01-15')
  })

  it('refuses a date that is not one', () => {
    expect(() => addMonths('2026-02-30', 1)).toThrow(RangeError)
    expect(() => invalidationDeadline(SvDocumentTypes.TAX_CREDIT, 'soon')).toThrow(RangeError)
  })

  it('reads the day of the seal from the hour the authority gave, in its own time', () => {
    expect(sealDateOf('16/11/2026 22:15:00')).toBe('2026-11-16')
    expect(sealDateOf('01/12/2026 00:00:00')).toBe('2026-12-01')
    expect(sealDateOf('31/12/2026 23:59:59')).toBe('2026-12-31')
    for (const bad of [null, '', 'yesterday', '2026-11-16T22:15:00', '31/02/2026 10:00:00']) {
      expect(sealDateOf(bad)).toBeNull()
    }
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
        now: '2026-11-17T15:00:00.000Z',
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

  it('refuses an invoice after three months from its seal', () => {
    // Sealed on 2026-11-16 (22:15, El Salvador): the last day is 2027-02-16, to its last second in El Salvador (UTC-6)
    expect(refusal(buildInvalidation(input({ now: '2027-02-17T05:59:59.000Z' })))).toBeNull()
    expect(refusal(buildInvalidation(input({ now: '2027-02-17T06:00:00.000Z' })))).toBe(
      SvVoidRefusals.DEADLINE_PASSED
    )
  })

  it('refuses a tax credit document or a credit note after the day that follows its seal, to the last second', () => {
    const credit = acceptedDocument({
      kind: FiscalDocumentKind.CREDIT_NOTE,
      credited: credited(),
      receiver: BUSINESS
    })
    for (const doc of [acceptedDocument({ receiver: BUSINESS }), credit]) {
      // Sealed on the 16th: the 17th is the last day. 23:59:59 on the 17th in El Salvador is 05:59:59 UTC of the 18th
      expect(refusal(buildInvalidation(input({ doc, now: '2026-11-17T05:59:59.000Z' })))).toBeNull()
      expect(refusal(buildInvalidation(input({ doc, now: '2026-11-18T05:59:59.000Z' })))).toBeNull()
      expect(refusal(buildInvalidation(input({ doc, now: '2026-11-18T06:00:00.000Z' })))).toBe(
        SvVoidRefusals.DEADLINE_PASSED
      )
    }
  })

  it('counts from the day of the seal and not from the date of the document', () => {
    // Made on the 16th and sealed on the 20th (a contingency sent late): the 21st is the last day, not the 17th
    const base = acceptedDocument({ receiver: BUSINESS })
    const doc = {
      ...base,
      providerData: {
        ...base.providerData,
        [SvProviderDataKeys.PROCESSED_AT]: '20/11/2026 08:00:00'
      }
    }
    expect(refusal(buildInvalidation(input({ doc, now: '2026-11-22T05:59:59.000Z' })))).toBeNull()
    expect(refusal(buildInvalidation(input({ doc, now: '2026-11-22T06:00:00.000Z' })))).toBe(
      SvVoidRefusals.DEADLINE_PASSED
    )
  })

  it('counts from the date of the document when the authority gave no readable hour of the seal (the stricter day)', () => {
    const base = acceptedDocument({ receiver: BUSINESS })
    for (const processedAt of [null, 'not an hour']) {
      const doc = {
        ...base,
        providerData: { ...base.providerData, [SvProviderDataKeys.PROCESSED_AT]: processedAt }
      }
      expect(refusal(buildInvalidation(input({ doc, now: '2026-11-18T05:59:59.000Z' })))).toBeNull()
      expect(refusal(buildInvalidation(input({ doc, now: '2026-11-18T06:00:00.000Z' })))).toBe(
        SvVoidRefusals.DEADLINE_PASSED
      )
    }
  })

  it('leaves a deadline counted in business days to the authority until the holidays are listed', () => {
    // Without the list the n-th business day could come too early, and a lawful invalidation would be refused here
    const rules = {
      ...SvInvalidationDeadlineRules,
      [SvDocumentTypes.TAX_CREDIT]: {
        unit: SvInvalidationDeadlineUnits.BUSINESS_DAY_OF_NEXT_MONTH,
        amount: 10
      }
    }
    const doc = acceptedDocument({ receiver: BUSINESS })
    expect(
      refusal(buildInvalidation(input({ doc, rules, now: '2026-12-20T20:00:00.000Z' })))
    ).toBeNull()
    expect(
      refusal(
        buildInvalidation(
          input({ doc, rules, holidays: ['2026-12-25'], now: '2026-12-15T07:00:00.000Z' })
        )
      )
    ).toBe(SvVoidRefusals.DEADLINE_PASSED)
    // An invoice (calendar months) is always checked
    expect(refusal(buildInvalidation(input({ now: '2027-03-20T20:00:00.000Z' })))).toBe(
      SvVoidRefusals.DEADLINE_PASSED
    )
  })

  it('dates the event of a tax credit document or a credit note with the date of the document, and an invoice with the day it is made', () => {
    // Anexo V, field 9, rule 4: the same date as the document (made on 2026-11-16), whatever the day the event is sent
    const ccf = buildInvalidation(
      input({ doc: acceptedDocument({ receiver: BUSINESS }), now: '2026-11-17T15:00:00.000Z' })
    )
    expect(ccf.ok && (ccf.event['identificacion'] as Record<string, unknown>)['fecEmi']).toBe(
      '2026-11-16'
    )
    expect(ccf.ok && (ccf.event['identificacion'] as Record<string, unknown>)['horEmi']).toBe(
      '09:00:00'
    )
    // The invoice: today, not later than three months after the date of the document
    const invoice = buildInvalidation(input({ now: '2027-02-16T15:00:00.000Z' }))
    expect(
      invoice.ok && (invoice.event['identificacion'] as Record<string, unknown>)['fecEmi']
    ).toBe('2027-02-16')
    // Sealed after the date of the document: its three months end later than those of the date; the event is dated by the date
    const base = acceptedDocument()
    const late = {
      ...base,
      providerData: {
        ...base.providerData,
        [SvProviderDataKeys.PROCESSED_AT]: '18/11/2026 08:00:00'
      }
    }
    const clamped = buildInvalidation(input({ doc: late, now: '2027-02-18T15:00:00.000Z' }))
    expect(
      clamped.ok && (clamped.event['identificacion'] as Record<string, unknown>)['fecEmi']
    ).toBe('2027-02-16')
  })

  it('names no replacement for a credit note, whatever the kind, and does not ask for one', () => {
    const doc = acceptedDocument({
      kind: FiscalDocumentKind.CREDIT_NOTE,
      credited: credited(),
      receiver: BUSINESS
    })
    const replacement = acceptedDocument({ correlative: 42, documentUuid: OTHER_UUID })
    for (const kind of [FiscalVoidKind.CORRECTION, FiscalVoidKind.OTHER]) {
      for (const given of [undefined, replacement]) {
        const built = buildInvalidation(
          input({
            doc,
            now: '2026-11-17T15:00:00.000Z',
            details: { kind, responsible: PERSON, requester: REQUESTER, replacement: given }
          })
        )
        expect(refusal(built)).toBeNull()
        if (!built.ok) return
        expect(schemaErrors('invalidation', built.event)).toEqual([])
        expect(built.event['documento']).toMatchObject({ tipoDte: '05', codigoGeneracionR: null })
      }
    }
  })

  it('refuses a document whose receiver the schema of the event would not take', () => {
    const doc = acceptedDocument()
    for (const over of [
      { nombre: 'n'.repeat(251) },
      { correo: 'c'.repeat(101) },
      { telefono: '1'.repeat(31) }
    ]) {
      const long = {
        ...doc,
        payload: { ...doc.payload, receptor: { ...(doc.payload['receptor'] as object), ...over } }
      }
      expect(refusal(buildInvalidation(input({ doc: long })))).toBe(
        SvVoidRefusals.DOCUMENT_INCOMPLETE
      )
    }
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
